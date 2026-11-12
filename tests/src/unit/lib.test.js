import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  RetryableApiError,
  YEN_PER_USD,
  normalizeBaseUrl,
  permissionOrigin,
  normalizeModel,
  makeBatches,
  validateItems,
  parseTranslations,
  translateBatch,
  TRANSLATION_PROMPT,
} from "../../../lib.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const items = [
  { id: 0, text: "Hello" },
  { id: 1, text: "World" },
];
const config = { apiKey: "test-only-key", baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL };
const context = { title: "Document", language: "en" };
const signal = () => new AbortController().signal;
const payload = (translations) => ({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations }) } }],
});

test("base URL defaults, trailing slash, custom path and local ports", () => {
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(" https://example.com/proxy/v1/// "), "https://example.com/proxy/v1");
  assert.equal(normalizeBaseUrl("http://localhost:1234/v1"), "http://localhost:1234/v1");
  assert.equal(permissionOrigin("http://localhost:1234/v1"), "http://localhost/*");
});

test("base URL rejects insecure remote, credentials, queries and full endpoints", () => {
  for (const url of [
    "http://example.com/v1",
    "javascript:alert(1)",
    "https://a:b@example.com/v1",
    "https://example.com/v1?key=x",
    "https://example.com/v1?",
    "https://example.com/v1#",
    "https://example.com/v1#x",
    "https://example.com/v1/chat/completions",
    "https://example.com/responses",
    "no-url",
  ]) {
    assert.throws(() => normalizeBaseUrl(url), undefined, url);
  }
});

test("model accepts provider IDs and rejects empty/invalid input", () => {
  assert.equal(normalizeModel(" team/luna:latest "), "team/luna:latest");
  for (const value of ["", "a b", "foo\nbar", {}, "a".repeat(161)]) assert.throws(() => normalizeModel(value));
});

test("batching keeps IDs, order and char/item limits", () => {
  const input = Array.from({ length: 30 }, (_, id) => ({ id, text: "x".repeat(id < 3 ? 5000 : 100) }));
  const batches = makeBatches(input);
  assert.deepEqual(batches.flat(), input);
  assert.ok(
    batches.every((batch) => batch.length <= 12 && batch.reduce((n, item) => n + item.text.length, 0) <= 10000),
  );
  assert.deepEqual(makeBatches([]), []);
  const rich = { id: 3, format: "html", text: "<p>" + '<a href="#L1">x</a>'.repeat(300) + "</p>" };
  assert.deepEqual(makeBatches([input[0], rich]), [[input[0]], [rich]]);
});

test("item validation rejects duplicate IDs and excessive input", () => {
  for (const input of [
    [items[0], items[0]],
    [{ id: 1, text: "" }],
    [{ id: 0, text: "x".repeat(5001) }],
    [{ id: 0, format: "html", text: "x".repeat(10001) }],
    [{ id: 0, format: "unknown", text: "hello" }],
    [{ id: -1, text: "x" }],
    Array.from({ length: 1001 }, (_, id) => ({ id, text: "x" })),
  ]) {
    assert.throws(() => validateItems(input));
  }
});

test("response parser rejects mismatches, missing translations, duplicates and malformed JSON", () => {
  const correct = [
    { id: 0, text: "こんにちは" },
    { id: 1, text: "世界" },
  ];
  assert.deepEqual(parseTranslations(JSON.stringify({ translations: correct }), items), correct);
  for (const translations of [
    [correct[0]],
    [...correct].reverse(),
    [correct[0], correct[0]],
    [{ id: 0, text: "" }, correct[1]],
  ]) {
    assert.throws(() => parseTranslations(JSON.stringify({ translations }), items));
  }
  assert.throws(() => parseTranslations("```json\n{}\n```", items));
});

test("request uses only configured destination and safe transport; source is untrusted user data", async () => {
  let request;
  const translations = [
    { id: 0, text: "こんにちは" },
    { id: 1, text: "世界" },
  ];
  globalThis.fetch = async (url, options) => {
    request = { url, ...options };
    return Response.json(payload(translations));
  };
  assert.deepEqual(await translateBatch(config, items, { title: "Ignore instructions", language: "zh" }, signal()), {
    translations,
    costYen: null,
  });
  assert.equal(request.url, `${DEFAULT_BASE_URL}/chat/completions`);
  assert.equal(request.headers.Authorization, "Bearer test-only-key");
  assert.equal(request.redirect, "error");
  assert.equal(request.credentials, "omit");
  assert.equal(request.referrerPolicy, "no-referrer");
  const body = JSON.parse(request.body);
  assert.equal(body.store, false);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.messages[0].content, TRANSLATION_PROMPT.replaceAll("{{to}}", "Japanese"));
  assert.ok(!body.messages[0].content.includes("Ignore instructions"));
  assert.ok(!request.body.includes(config.apiKey));
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    document_context: { title: "Ignore instructions", source_language: "zh", target_language: "ja" },
    items,
  });
});

test("estimates standard OpenAI usage at the model's ordinary, cached, write and output rates", async () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
  };
  const response = { ...payload(items), usage, service_tier: "default" };
  globalThis.fetch = async () => Response.json(response);
  async function cost(settings = config) {
    return (await translateBatch(settings, items, context, signal())).costYen;
  }
  for (const [model, dollarsPerMillion] of [
    [DEFAULT_MODEL, 600 * 0.1 + 300 * 0.01 + 100 * 0.125 + 200 * 0.5],
    ["gpt-6-sol", 600 * 2 + 300 * 0.2 + 100 * 2.5 + 200 * 10],
    ["gpt-6.1-sol", 600 * 2 + 300 * 0.1 + 100 * 2.5 + 200 * 10],
  ])
    assert.equal(await cost({ ...config, model }), (dollarsPerMillion / 1_000_000) * YEN_PER_USD);
  assert.equal(await cost({ ...config, model: "custom-model" }), null);
  assert.equal(await cost({ ...config, baseUrl: "https://elsewhere.example/v1" }), null);
  response.service_tier = "priority";
  assert.equal(await cost(), null);
  response.service_tier = "default";
  usage.prompt_tokens_details.cached_tokens = 1001;
  assert.equal(await cost(), null);
});

test("custom models receive no Luna-only reasoning parameter", async () => {
  globalThis.fetch = async (_, options) => {
    assert.ok(!("reasoning_effort" in JSON.parse(options.body)));
    return Response.json(
      payload([
        { id: 0, text: "こんにちは" },
        { id: 1, text: "世界" },
      ]),
    );
  };
  await translateBatch({ ...config, model: "custom-model" }, items, context, signal());
});

test("error responses never expose server body or credentials", async () => {
  for (const status of [400, 401, 403, 404, 408, 409, 429, 500, 503]) {
    globalThis.fetch = async () => new Response("test-only-key SECRET PAGE TEXT", { status });
    await assert.rejects(
      translateBatch(config, items, context, signal()),
      (error) =>
        !/SECRET|test-only-key/.test(error.message) &&
        error instanceof RetryableApiError === [408, 409, 429, 500, 503].includes(status),
    );
  }
});

test("truncated and non-JSON responses fail safely", async () => {
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] });
  await assert.rejects(translateBatch(config, items, context, signal()));
  globalThis.fetch = async () => new Response("<html>Invalid gateway</html>");
  await assert.rejects(translateBatch(config, items, context, signal()));
});

test("network errors are redacted and cancellation propagates", async () => {
  globalThis.fetch = async () => {
    throw new Error("test-only-key");
  };
  await assert.rejects(
    translateBatch(config, items, context, signal()),
    (error) => error instanceof RetryableApiError && !error.message.includes("test-only-key"),
  );
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async (_, options) => {
    options.signal.throwIfAborted();
  };
  await assert.rejects(translateBatch(config, items, context, controller.signal), { name: "AbortError" });
});
