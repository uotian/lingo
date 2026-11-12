import { test, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

let listener,
  closeTab,
  modes = {},
  saved = {},
  locked = false,
  removed = [],
  allowed = true;
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => ({ [key]: modes[key] }),
      set: async (value) => Object.assign(modes, value),
      remove: async (key) => {
        delete modes[key];
      },
    },
    local: {
      setAccessLevel: async ({ accessLevel }) => {
        locked = accessLevel === "TRUSTED_CONTEXTS";
      },
      get: async (keys) => {
        assert.ok(locked);
        return structuredClone({ ...(typeof keys === "object" && !Array.isArray(keys) ? keys : {}), ...saved });
      },
      set: async (value) => {
        assert.ok(locked);
        Object.assign(saved, structuredClone(value));
      },
    },
  },
  runtime: {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: {
      addListener: (fn) => {
        listener = fn;
      },
    },
  },
  tabs: {
    onRemoved: {
      addListener(fn) {
        closeTab = fn;
      },
    },
    onUpdated: { addListener() {} },
  },
  permissions: {
    contains: async () => allowed,
    remove: async (permission) => {
      removed.push(permission);
    },
  },
};
await import("../../../background.js");
beforeEach(() => {
  saved = {};
  modes = {};
  removed = [];
  allowed = true;
});
const popup = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
function send(message, sender = popup) {
  return new Promise((resolve) => {
    if (listener(message, sender, resolve) === false) resolve(null);
  });
}
const config = { baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", apiKey: "fake-secret" };

test("only popup may access settings or start API requests", async () => {
  assert.equal(
    await send({ type: "settings" }, { id: "test-extension", url: "https://example.com", tab: { id: 1 } }),
    null,
  );
  assert.equal(await send({ type: "start", tabId: 1 }, { id: "test-extension", url: "https://example.com" }), null);
  assert.equal(await send({ type: "settings" }, { ...popup, id: "other-extension" }), null);
});

test("closing a tab clears only its session display mode", async () => {
  for (const tabId of [11, 12]) assert.equal((await send({ type: "displayMode", mode: "original", tabId })).ok, true);
  assert.deepEqual(modes, { "displayMode:11": "original", "displayMode:12": "original" });
  closeTab(11);
  assert.deepEqual(modes, { "displayMode:12": "original" });
  assert.deepEqual(saved, {});
});

test("key persists locally but never returns to the popup", async () => {
  const response = await send({ type: "save", settings: config });
  assert.equal(response.ok, true);
  assert.equal(saved.settings.apiKey, "fake-secret");
  assert.ok(!JSON.stringify(response).includes("fake-secret"));
  assert.deepEqual((await send({ type: "settings" })).data, {
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: true,
  });
});

test("model change keeps key; destination change requires explicit new key", async () => {
  await send({ type: "save", settings: config });
  assert.equal((await send({ type: "save", settings: { ...config, model: "gpt-6-sol", apiKey: "" } })).ok, true);
  assert.equal(saved.settings.apiKey, "fake-secret");
  assert.equal(
    (await send({ type: "save", settings: { ...config, baseUrl: "https://elsewhere.example/v1", apiKey: "" } })).ok,
    false,
  );
  assert.equal(saved.settings.baseUrl, config.baseUrl);
});

test("ungranted destination and invalid keys are rejected without changing settings", async () => {
  allowed = false;
  assert.equal((await send({ type: "save", settings: config })).ok, false);
  assert.deepEqual(saved, {});
  allowed = true;
  assert.equal((await send({ type: "save", settings: { ...config, apiKey: "key\r\nsecret" } })).ok, false);
});

test("changing provider revokes unused optional host permission", async () => {
  await send({ type: "save", settings: { ...config, baseUrl: "https://old.example/v1" } });
  await send({ type: "save", settings: config });
  assert.deepEqual(removed, [{ origins: ["https://old.example/*"] }]);
});

test("forget removes the saved key and preserves model and destination", async () => {
  await send({ type: "save", settings: config });
  assert.equal((await send({ type: "forget" })).data.hasKey, false);
  assert.equal(saved.settings.apiKey, "");
  assert.equal(saved.settings.model, config.model);
});

test("eight batches run at once and a free slot starts the next batch immediately", async () => {
  saved = { settings: config, "site:example.com": true };
  const tabId = 1;
  const items = Array.from({ length: 120 }, (_, id) => ({ id, text: "Example " + id }));
  const applied = [];
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    scripting: { executeScript: async () => [{ documentId: "doc" }] },
    tabs: {
      ...globalThis.chrome.tabs,
      get: async () => ({ url: "https://example.com/article" }),
      sendMessage: async (_, message) => {
        if (message.type === "collect") return { items, skipped: 0 };
        if (message.type === "current") return true;
        if (message.type === "apply") {
          applied.push(...message.translations);
          return true;
        }
        if (message.type === "status") return { done: applied.length, total: items.length, skipped: 0 };
      },
    },
  });
  const requests = [];
  vi.stubGlobal("fetch", (_, { body, signal }) => {
    const { items: batch } = JSON.parse(JSON.parse(body).messages[1].content);
    const { promise, resolve } = Promise.withResolvers();
    requests.push({ batch, signal, resolve });
    return promise;
  });
  try {
    assert.equal((await send({ type: "start", tabId })).ok, true);
    await vi.waitFor(() => assert.equal(requests.length, 8));
    const second = requests[1];
    second.resolve(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations: second.batch }) } }],
      }),
    );
    await vi.waitFor(() => assert.equal(requests.length, 9));
    assert.deepEqual(applied, items.slice(12, 24));
    assert.deepEqual(requests[8].batch, items.slice(96, 108));

    requests[0].resolve(new Response(null, { status: 503, headers: { "Retry-After": "60" } }));
    for (const attempt of [8, 9]) {
      requests[attempt].resolve(new Response(null, { status: 429, headers: { "Retry-After": "0" } }));
      await vi.waitFor(() => assert.equal(requests.length, attempt + 2));
      assert.deepEqual(requests.at(-1).batch, requests[8].batch);
      assert.equal((await send({ type: "status", tabId })).data.state, "running");
    }
    requests[10].resolve(new Response(null, { status: 429 }));
    await vi.waitFor(async () => assert.equal((await send({ type: "status", tabId })).data.state, "error"));
    assert.ok(requests.every(({ signal }) => signal.aborted));
    await send({ type: "pageChanged" }, { id: popup.id, tab: { id: tabId }, documentId: "doc", frameId: 0 });
    assert.equal((await send({ type: "status", tabId })).data.state, "error");
    assert.equal(requests.length, 11);
    assert.equal((await send({ type: "status", tabId })).data.done, 12);
  } finally {
    await send({ type: "forget" });
    vi.unstubAllGlobals();
  }
});

test("forgetting the key during setup prevents a late injection or API request", async () => {
  saved = { settings: config };
  const permission = Promise.withResolvers();
  const contains = vi.fn(() => permission.promise);
  const inject = vi.fn();
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    permissions: { contains },
    scripting: { executeScript: inject },
    tabs: { get: async () => ({ url: "https://example.com/" }), sendMessage: async () => ({}) },
  });
  try {
    const start = send({ type: "start", tabId: 2 });
    await vi.waitFor(() => assert.equal(contains.mock.calls.length, 1));
    await send({ type: "forget" });
    permission.resolve(true);
    assert.equal((await start).ok, true);
    assert.equal(inject.mock.calls.length, 0);
    assert.equal((await send({ type: "status", tabId: 2 })).data.state, "idle");
  } finally {
    permission.resolve(true);
    vi.unstubAllGlobals();
  }
});
