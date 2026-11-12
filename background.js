import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  UserError,
  RetryableApiError,
  normalizeBaseUrl,
  normalizeModel,
  permissionOrigin,
  PAGE_LIMITS,
  LANGUAGES,
  makeBatches,
  translateBatch,
} from "./lib.js";
import { lookupTranslations, saveTranslations } from "./translation-cache.js";

const ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const jobs = new Map();
const MAX_PARALLEL_BATCHES = 8;
const RETRY_DELAYS_MS = [1000, 2000];

// 並行する翻訳応答とクリアを同じ順序で集計する。
let totalsQueue = Promise.resolve();
function updateTotals(task) {
  const result = totalsQueue.then(task);
  totalsQueue = result.catch(() => {});
  return result;
}

async function readTotals() {
  await ready;
  const { totals } = await chrome.storage.local.get({ totals: { pages: 0, yen: 0, period: "initial" } });
  return /** @type {{ pages: number, yen: number, period: string }} */ (totals);
}

function waitForRetry(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancelWait);
      resolve();
    }, ms);
    function cancelWait() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", cancelWait, { once: true });
  });
}

async function settings() {
  await ready;
  const { settings = {} } = await chrome.storage.local.get("settings");
  const defaults = { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, apiKey: "" };
  return settings && typeof settings === "object" ? { ...defaults, ...settings } : defaults;
}

function cancel(tabId) {
  const job = jobs.get(tabId);
  job?.controller?.abort();
  jobs.delete(tabId);
}

function cancelAll() {
  for (const tabId of jobs.keys()) cancel(tabId);
}

function tabModeKey(tabId) {
  return "displayMode:" + tabId;
}

async function readTabMode(tabId) {
  const key = tabModeKey(tabId);
  return (await chrome.storage.session.get(key))[key];
}

function publicSettings(value) {
  return {
    baseUrl: value.baseUrl,
    model: value.model,
    hasKey: Boolean(value.apiKey),
  };
}

async function saveSettings(input) {
  const previous = await settings();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = normalizeModel(input.model);
  // eslint-disable-next-line no-control-regex -- Authorizationヘッダーに使うキーから制御文字を除外する。
  if (typeof input.apiKey !== "string" || input.apiKey.length > 1024 || /[\x00-\x20\x7f]/.test(input.apiKey)) {
    throw new UserError("APIキーに空白や改行が含まれています。");
  }
  if (baseUrl !== previous.baseUrl && !input.apiKey) {
    throw new UserError("送信先を変更するときは、APIキーを再入力してください。");
  }
  const apiKey = input.apiKey || previous.apiKey;
  if (!apiKey) throw new UserError("APIキーを入力してください。");
  if (!(await chrome.permissions.contains({ origins: [permissionOrigin(baseUrl)] }))) {
    throw new UserError("この送信先への接続を許可してください。");
  }
  cancelAll();
  const value = { baseUrl, model, apiKey, revision: crypto.randomUUID() };
  await chrome.storage.local.set({ settings: value });
  const oldOrigin = permissionOrigin(previous.baseUrl);
  if (
    oldOrigin !== permissionOrigin(baseUrl) &&
    oldOrigin !== permissionOrigin(DEFAULT_BASE_URL) &&
    !(await readSite(new URL(previous.baseUrl).hostname)).enabled
  ) {
    await chrome.permissions.remove({ origins: [oldOrigin] });
  }
  return publicSettings(value);
}

async function pageMessage(tabId, message, documentId) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, documentId ? { documentId } : { frameId: 0 });
  } catch {
    return null;
  }
}

async function restoreTab(tabId) {
  cancel(tabId);
  await pageMessage(tabId, { type: "restore" });
}

async function run(tabId, job, config, incremental) {
  const { signal } = job.controller;
  const send = (type, fields = {}) => pageMessage(tabId, { type, runId: job.id, ...fields }, job.documentId);
  async function requestPage(type, fields = {}) {
    signal.throwIfAborted();
    const reply = await send(type, fields);
    signal.throwIfAborted();
    if (!reply) throw new UserError("ページが変わったため中断しました。もう一度翻訳してください。");
    return reply;
  }
  try {
    const { items, title, origin } = await requestPage("collect", {
      ...job.site,
      incremental,
      revision: config.revision,
      limits: PAGE_LIMITS,
      displayMode: job.displayMode,
    });
    const context = { title, language: job.site.language, targetLanguage: job.site.targetLanguage };
    const cacheScope =
      !job.incognito && origin
        ? [origin, config.baseUrl, config.model, context.language, context.targetLanguage]
        : null;
    const batches = makeBatches(items);
    const remaining = batches.values();
    async function translate(batch) {
      for (let attempt = 0; ; attempt++) {
        await requestPage("current");
        try {
          return await translateBatch(config, batch, context, signal);
        } catch (error) {
          if (!(error instanceof RetryableApiError) || attempt >= RETRY_DELAYS_MS.length) throw error;
          let delay = error.retryAfterMs ?? RETRY_DELAYS_MS[attempt];
          // 長い Retry-After の間も対象文書を確認し、拡張のワーカーを稼働させる。
          while (delay > 20000) {
            await waitForRetry(20000, signal);
            await requestPage("current");
            delay -= 20000;
          }
          await waitForRetry(delay, signal);
        }
      }
    }
    async function apply(result) {
      await updateTotals(async () => {
        const totals = await readTotals();
        const applied = signal.aborted ? null : await send("apply", { ...result, period: totals.period });
        totals.yen += result.costYen ?? 0;
        if (applied?.firstPage) totals.pages++;
        await chrome.storage.local.set({ totals });
        signal.throwIfAborted();
        if (!applied) throw new UserError("ページが変わったため中断しました。もう一度翻訳してください。");
      });
    }
    async function processBatches() {
      for (const batch of remaining) {
        signal.throwIfAborted();
        const { keys, hits, missing } = await lookupTranslations(cacheScope, batch);
        if (hits.length) await apply({ translations: hits, costYen: 0 });
        if (missing.length) {
          const result = await translate(missing);
          await apply(result);
          await saveTranslations(keys, result.translations);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_BATCHES, batches.length) }, processBatches));
    if (signal.aborted) return;
    job.state = "done";
  } catch (error) {
    if (signal.aborted) return;
    job.controller.abort();
    job.state = "error";
    job.error =
      error instanceof UserError ? error.message : "翻訳できませんでした。ページを再読み込みしてお試しください。";
  } finally {
    await send("finish", { error: job.error, cancelled: signal.aborted });
  }
}

async function start(tabId, mode = "manual", documentId = undefined) {
  if (!Number.isSafeInteger(tabId)) throw new UserError("翻訳するタブが見つかりません。");
  // 設定の読み込み中にも「中止」やページ移動でこの開始要求を取り消せるようにする。
  const previous = jobs.get(tabId) ?? { state: "idle" };
  jobs.set(tabId, previous);
  if (mode !== "manual" && previous.state === "error") return {};
  if (previous.state === "running") return {};
  const config = await settings();
  if (mode !== "manual" && !config.apiKey) return {};
  if (!config.apiKey) throw new UserError("設定からAPIキーを保存してください。");
  const tab = await chrome.tabs.get(tabId);
  const hostname = httpHost(tab.url);
  if (!hostname) throw new UserError("通常のWebページで使ってください。Chromeの設定画面やPDFには対応していません。");
  if (!(await chrome.permissions.contains({ origins: [permissionOrigin(config.baseUrl)] }))) {
    throw new UserError("送信先への接続権限がありません。設定を保存し直してください。");
  }
  const [site, savedMode] = await Promise.all([readSite(hostname), readTabMode(tabId)]);
  if (mode === "auto" && !site.enabled) return {};
  if (jobs.get(tabId) !== previous) return {};
  const job = {
    id: crypto.randomUUID(),
    controller: new AbortController(),
    state: "running",
    incognito: tab.incognito,
    pageUrl: tab.url.split("#", 1)[0],
    documentId,
    displayMode: previous.displayMode ?? savedMode,
    site,
  };
  jobs.set(tabId, job);
  if (!documentId) {
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      job.documentId = injection.documentId;
    } catch {
      job.state = "error";
      job.error = "このページには翻訳を表示できません。通常のWebページでお試しください。";
      throw new UserError(job.error);
    }
  }
  if (!job.controller.signal.aborted) void run(tabId, job, config, mode === "incremental");
  return {};
}

async function handle(message) {
  switch (message.type) {
    case "clearTotals":
      return updateTotals(async () => {
        await ready;
        const totals = { pages: 0, yen: 0, period: crypto.randomUUID() };
        await chrome.storage.local.set({ totals });
        return totals;
      });
    case "settings":
      return publicSettings(await settings());
    case "save": {
      const result = await saveSettings(message.settings);
      if (message.tabId) void start(message.tabId, "auto").catch(() => {});
      return result;
    }
    case "forget": {
      cancelAll();
      const value = await settings();
      value.apiKey = "";
      await chrome.storage.local.set({ settings: value });
      return publicSettings(value);
    }
    case "site": {
      const tab = await chrome.tabs.get(message.tabId);
      return readSite(httpHost(tab.url));
    }
    case "setSite":
      return setSite(message);
    case "start":
      return start(message.tabId);
    case "displayMode": {
      const { tabId, mode } = message;
      if (!Number.isSafeInteger(tabId)) throw new UserError("表示を切り替えるタブが見つかりません。");
      if (!["original", "bilingual", "translated"].includes(mode)) throw new UserError("表示方法を確認してください。");
      const job = jobs.get(tabId);
      if (job) job.displayMode = mode;
      await chrome.storage.session.set({ [tabModeKey(tabId)]: mode });
      await pageMessage(tabId, { type: "displayMode", mode });
      return {};
    }
    case "status": {
      const { tabId } = message;
      const [totals, progress] = await Promise.all([
        readTotals(),
        tabId ? pageMessage(tabId, { type: "status" }) : null,
      ]);
      const mode = progress?.mode ?? (tabId ? await readTabMode(tabId) : undefined);
      const job = jobs.get(tabId);
      return {
        ...(progress ?? { done: 0, total: 0, skipped: 0 }),
        mode,
        totals,
        state: job?.state ?? (progress?.error ? "error" : "idle"),
        error: job ? job.error : progress?.error,
      };
    }
    default:
      throw new UserError("未対応の操作です。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    message.type === "pageChanged" &&
    sender.id === chrome.runtime.id &&
    sender.tab?.id &&
    sender.documentId &&
    sender.frameId === 0
  ) {
    // 対象は通知元の文書に固定し、本文はその文書から取り直す。
    void start(sender.tab.id, "incremental", sender.documentId)
      .then(() => respond({}))
      .catch(() => respond({}));
    return true;
  }
  // 設定と手動操作は拡張のポップアップだけに許可する。
  if (sender.id !== chrome.runtime.id || sender.url?.split("#")[0] !== chrome.runtime.getURL("popup.html"))
    return false;
  handle(message)
    .then((data) => respond({ ok: true, data }))
    .catch((error) => {
      respond({
        ok: false,
        error: error instanceof UserError ? error.message : "操作に失敗しました。もう一度お試しください。",
      });
    });
  return true;
});

function httpHost(url) {
  return /^https?:\/\//.test(url || "") ? new URL(url).hostname : "";
}

function isLanguage(value) {
  return typeof value === "string" && Object.hasOwn(LANGUAGES, value);
}

async function readSite(hostname) {
  const autoKey = "site:" + hostname;
  const languageKey = "language:" + hostname;
  const targetKey = "targetLanguage:" + hostname;
  const values = hostname ? await chrome.storage.local.get([autoKey, languageKey, targetKey]) : {};
  const language = isLanguage(values[languageKey]) ? values[languageKey] : "en";
  const target = values[targetKey];
  return {
    hostname,
    enabled: values[autoKey] === true,
    language,
    targetLanguage: isLanguage(target) && language !== target ? target : language === "ja" ? "en" : "ja",
  };
}

async function setIcon(tabId, enabled) {
  const { action, icons } = chrome.runtime.getManifest();
  await Promise.all([
    chrome.action.setIcon({ tabId, path: enabled ? icons : action.default_icon }),
    chrome.action.setTitle({
      tabId,
      title: enabled ? "Lingo：自動翻訳 ON" : "Lingo：自動翻訳 OFF",
    }),
  ]);
}

async function setSite({ tabId, hostname, enabled, language, targetLanguage }) {
  const tab = await chrome.tabs.get(tabId);
  if (!hostname || hostname !== httpHost(tab.url))
    throw new UserError("ページが変わりました。Lingoを開き直してください。");
  const origins = [`*://${hostname}/*`];
  const changingLanguage = language !== undefined || targetLanguage !== undefined;
  if (changingLanguage) {
    const previous = await readSite(hostname);
    const from = language ?? (targetLanguage === previous.language ? previous.targetLanguage : previous.language);
    const to = targetLanguage ?? (language === previous.targetLanguage ? previous.language : previous.targetLanguage);
    if (!isLanguage(from) || !isLanguage(to) || from === to)
      throw new UserError("翻訳元と翻訳先に異なる言語を選んでください。");
    await chrome.storage.local.set({ ["language:" + hostname]: from, ["targetLanguage:" + hostname]: to });
  } else {
    if (typeof enabled !== "boolean") throw new UserError("自動翻訳の設定を確認してください。");
    if (enabled && !(await chrome.permissions.contains({ origins })))
      throw new UserError("このサイトへのアクセスを許可してください。");
    const key = "site:" + hostname;
    if (enabled) await chrome.storage.local.set({ [key]: true });
    else await chrome.storage.local.remove(key);
  }
  const site = await readSite(hostname);
  const tabs = await chrome.tabs.query({ url: origins });
  const ids = new Set([tabId, ...tabs.map((tab) => tab.id)]);
  await Promise.allSettled(
    [...ids].map(async (id) => {
      if (changingLanguage || !site.enabled) await restoreTab(id);
      await setIcon(id, site.enabled);
      if (site.enabled) await start(id, "auto");
    }),
  );
  // APIの接続にも使うホスト権限は維持する。
  if (enabled === false && !site.enabled && new URL((await settings()).baseUrl).hostname !== hostname)
    await chrome.permissions.remove({ origins });
  return site;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  cancel(tabId);
  void chrome.storage.session.remove(tabModeKey(tabId));
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.status && !change.url) return;
  // Chromeはページ内リンクでも loading を通知する。処理中の同じ原文を再送しない。
  const fragmentChange = change.url && jobs.get(tabId)?.pageUrl === change.url.split("#", 1)[0];
  if (!fragmentChange && (change.status === "loading" || change.url)) cancel(tabId);
  void refreshTab(tabId, tab.url, tab.status === "complete").catch(() => {});
});

async function refreshTab(tabId, url, loaded) {
  const hostname = httpHost(url);
  const { enabled } = await readSite(hostname);
  await setIcon(tabId, enabled);
  if (!loaded || !hostname) return;
  if (enabled) {
    const job = jobs.get(tabId);
    if (job?.documentId) {
      const current = await pageMessage(tabId, { type: "current", runId: job.id });
      if (current || jobs.get(tabId) !== job) return;
      cancel(tabId);
    }
    return start(tabId, "auto");
  }
  // 戻る・進むで既に翻訳した文書が復帰した場合も、そのタブの表示に合わせる。
  const mode = await readTabMode(tabId);
  await pageMessage(tabId, { type: "displayMode", mode, resume: true });
}
