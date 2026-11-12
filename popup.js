import {
  DEFAULT_BASE_URL,
  MODELS,
  PAGE_LIMITS,
  LANGUAGES,
  YEN_PER_USD,
  normalizeBaseUrl,
  permissionOrigin,
} from "./lib.js";

const $ = (id) => document.getElementById(id);
const modelSelect = /** @type {HTMLSelectElement} */ ($("model"));
$("translation-cost").title = `応答を受け取った分の概算（1米ドル＝${YEN_PER_USD}円換算）`;
function input(id) {
  const element = $(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`入力欄が見つかりません: ${id}`);
  return element;
}
function button(id) {
  const element = $(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`ボタンが見つかりません: ${id}`);
  return element;
}
let config,
  tabId,
  site,
  starting = false,
  running,
  finished = false,
  timer;
const modeButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll("button[data-mode]"));
let changingMode = false;
let statusVersion = 0;
let renderedVersion = 0;

async function request(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || "拡張を読み込み直してください。");
  return response.data;
}

function notice(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}

function showSettings(show) {
  $("main-view").hidden = show;
  $("translation-result").hidden = show;
  $("settings-view").hidden = !show;
  $("settings-footer").hidden = !show;
  $("view-title").textContent = show ? "Lingoの設定" : "Lingo";
  button("settings-toggle").textContent = show ? "戻る" : "設定";
  button("settings-toggle").setAttribute("aria-expanded", String(show));
  notice("");
}

function renderSettings(value) {
  config = value;
  input("api-key").value = "";
  input("api-key").placeholder = value.hasKey ? "変更するときだけ入力" : "sk-…";
  $("key-state").textContent = value.hasKey ? "保存済み" : "未設定";
  button("forget").disabled = !value.hasKey;
  modelSelect.replaceChildren(...MODELS.map(({ id, label }) => new Option(label, id)));
  if (!MODELS.some(({ id }) => id === value.model)) modelSelect.add(new Option(value.model, value.model));
  modelSelect.value = value.model;
  input("base-url").value = value.baseUrl === DEFAULT_BASE_URL ? "" : value.baseUrl;
  updateTranslationControls();
}

function updateTranslationControls() {
  const unavailable = !config?.hasKey || sourceLanguage.disabled || changingMode;
  button("translate").disabled = unavailable || starting || running !== false || finished;
  for (const control of modeButtons) control.disabled = unavailable;
}

function formatYen(yen) {
  if (!yen) return "0円";
  return yen < 0.01 ? "0.01円未満" : `約${yen.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
}

function renderTotals({ pages, yen }) {
  $("usage-total").textContent = `累計 ${pages.toLocaleString("ja-JP")}ページ · ${formatYen(yen)}`;
  button("clear-total").disabled = !pages && !yen;
}

button("clear-total").addEventListener("click", async () => {
  try {
    const totals = await request("clearTotals");
    renderedVersion = ++statusVersion;
    renderTotals(totals);
  } catch (error) {
    notice(error.message, true);
  }
});

async function refreshStatus() {
  const version = ++statusVersion;
  const status = await request("status", { tabId });
  if (version < renderedVersion) return;
  renderedVersion = version;
  renderTotals(status.totals);
  if (!tabId) return;
  running = status.state === "running";
  finished = !running && !status.error && status.hasRemaining === false;
  updateTranslationControls();
  button("translate").textContent = running ? "翻訳中…" : finished && status.done ? "翻訳済み" : "翻訳";
  for (const control of modeButtons) {
    control.setAttribute("aria-pressed", String(control.dataset.mode === (status.mode ?? "original")));
  }
  const count = $("translation-count");
  const fraction = status.total ? `${status.done}/${status.total}` : "";
  if (count.textContent !== fraction) count.textContent = fraction;
  const cost = $("translation-cost");
  const amount = status.costYen > 0 ? formatYen(status.costYen) : "";
  if (cost.textContent !== amount) cost.textContent = amount;
  const progress = $("progress");
  progress.classList.toggle("error", status.state === "error");
  if (status.error) progress.textContent = status.error;
  else if (!running && status.skipped)
    progress.textContent = `${status.skipped}か所は今回の上限（${PAGE_LIMITS.maxItems.toLocaleString("ja-JP")}か所・1か所${PAGE_LIMITS.maxItemChars.toLocaleString("ja-JP")}文字）で省略しました。`;
  else progress.textContent = status.state === "done" && !status.total ? "翻訳できる原文が見つかりませんでした。" : "";
}

const siteToggle = input("site-auto");
const sourceLanguage = /** @type {HTMLSelectElement} */ ($("source-language"));
const targetLanguage = /** @type {HTMLSelectElement} */ ($("target-language"));
for (const [code, { label }] of Object.entries(LANGUAGES)) {
  for (const select of [sourceLanguage, targetLanguage]) {
    const option = new Option(code.toUpperCase(), code);
    option.setAttribute("aria-label", label);
    select.add(option);
  }
}

function renderSite(value) {
  site = value;
  siteToggle.checked = site.enabled;
  sourceLanguage.value = site.language;
  targetLanguage.value = site.targetLanguage;
  siteToggle.disabled = sourceLanguage.disabled = targetLanguage.disabled = !site.hostname;
  updateTranslationControls();
  $("site-host").textContent = site.hostname;
}

async function changeSite(change) {
  siteToggle.disabled = sourceLanguage.disabled = targetLanguage.disabled = true;
  updateTranslationControls();
  notice("");
  try {
    if (change.enabled && !(await chrome.permissions.request({ origins: [`*://${site.hostname}/*`] })))
      throw new Error("このサイトへのアクセスが許可されませんでした。");
    renderSite(await request("setSite", { tabId, hostname: site.hostname, ...change }));
    await refreshStatus();
  } catch (error) {
    renderSite(site);
    notice(error.message, true);
  }
}
siteToggle.addEventListener("change", () => changeSite({ enabled: siteToggle.checked }));
sourceLanguage.addEventListener("change", () => changeSite({ language: sourceLanguage.value }));
targetLanguage.addEventListener("change", () => changeSite({ targetLanguage: targetLanguage.value }));

button("settings-toggle").addEventListener("click", () => showSettings($("settings-view").hidden));

for (const control of modeButtons) {
  control.addEventListener("click", async () => {
    if (changingMode) return;
    changingMode = true;
    updateTranslationControls();
    notice("");
    try {
      await request("displayMode", { tabId, mode: control.dataset.mode });
      await refreshStatus();
    } catch (error) {
      notice(error.message, true);
    } finally {
      changingMode = false;
      updateTranslationControls();
    }
  });
}

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  button("save").disabled = true;
  notice("");
  try {
    const baseUrl = normalizeBaseUrl(input("base-url").value);
    const model = modelSelect.value;
    const apiKey = input("api-key").value.trim();
    if (!apiKey && (!config?.hasKey || baseUrl !== config.baseUrl))
      throw new Error("APIキーを入力してください。送信先を変更する場合は再入力が必要です。");
    // ユーザー操作の直後に、指定されたホストだけの権限を要求する。
    if (!(await chrome.permissions.request({ origins: [permissionOrigin(baseUrl)] })))
      throw new Error("送信先への接続が許可されませんでした。");
    renderSettings(await request("save", { tabId, settings: { baseUrl, model, apiKey } }));
    showSettings(!tabId);
    notice("設定を保存しました。");
  } catch (error) {
    notice(error.message, true);
  } finally {
    button("save").disabled = false;
  }
});

button("forget").addEventListener("click", async () => {
  try {
    renderSettings(await request("forget"));
    notice("保存したAPIキーを削除しました。");
  } catch (error) {
    notice(error.message, true);
  }
});

button("translate").addEventListener("click", async () => {
  starting = true;
  updateTranslationControls();
  notice("");
  try {
    await request("start", { tabId });
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  } finally {
    starting = false;
    updateTranslationControls();
  }
});

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const target = new URLSearchParams(location.hash.slice(1)).get("tab");
  tabId = target ? Number(target) : tab?.url?.startsWith(chrome.runtime.getURL("")) ? undefined : tab?.id;
  button("settings-toggle").hidden = !tabId;
  if (tabId) renderSite(await request("site", { tabId }));
  const initialSettings = await request("settings");
  renderSettings(initialSettings);
  if (!initialSettings.hasKey || !tabId) showSettings(true);
  await refreshStatus();
  timer = setInterval(() => refreshStatus().catch(() => {}), 800);
} catch {
  notice("設定を読み込めませんでした。拡張を読み込み直してください。", true);
}
window.addEventListener("pagehide", () => clearInterval(timer));
