import { expect, test } from "@playwright/test";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function launchExtension(chromium, testInfo, profile = "") {
  const extension = testInfo.outputPath("extension");
  await cp("dist", extension, { recursive: true });
  // モデル配信もテスト用の疑似APIで完結させる。
  const lib = join(extension, "lib.js");
  await writeFile(
    lib,
    (await readFile(lib, "utf8")).replace(
      "https://uotian.github.io/lingo/models.json",
      "http://127.0.0.1:4177/models.json",
    ),
  );
  const file = join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  // ヘッドレス環境の権限ダイアログを避けるため、テスト用コピーだけに追加する。
  manifest.host_permissions.push("*://127.0.0.1/*");
  await writeFile(file, JSON.stringify(manifest));
  return chromium.launchPersistentContext(profile, {
    channel: "chromium",
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
}

async function translationRequests(context) {
  const response = await context.request.get("http://127.0.0.1:4177/checks");
  return (await response.json()).requests;
}

test.beforeEach(async ({ request }) => {
  await request.get("http://127.0.0.1:4177/mode/ok");
});

test("設定の保存・翻訳・復元・中止とキーの保護", async ({ playwright }, testInfo) => {
  test.slow();
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    let runtimeErrors = 0;
    context.on("weberror", () => runtimeErrors++);
    const page = await context.newPage();
    const missingAssets = [];
    page.on("requestfailed", (request) => {
      if (request.url().startsWith("chrome-extension://")) missingAssets.push(request.url());
    });
    const check = (condition, label) => {
      if (!condition) throw new Error(label);
    };

    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    // Chromiumはremoveでも任意権限の宣言を照合する。事前許可のないホストで初回要求の形式を検査する。
    const optionalSite = { origins: ["*://localhost/*"] };
    expect(await worker.evaluate((scope) => chrome.permissions.contains(scope), optionalSite)).toBe(false);
    expect(await worker.evaluate((scope) => chrome.permissions.remove(scope), optionalSite)).toBe(true);
    const article = await context.newPage();
    await article.goto("http://127.0.0.1:4177/tests/article.html");
    const originalParagraph = await article.locator("#inline").innerHTML();
    const tabId = await worker.evaluate(
      async () => (await chrome.tabs.query({ url: "http://127.0.0.1:4177/tests/article.html" }))[0].id,
    );
    const popupUrl = worker.url().replace("background.js", "popup.html#tab=" + tabId);
    await page.goto(popupUrl);
    const model = page.getByRole("combobox", { name: "モデル", exact: true });
    await expect(model).toHaveValue("@recommended");
    await expect(model.locator("option:checked")).toContainText("Test Luna");
    await model.selectOption("gpt-6-sol");
    await page.getByRole("textbox", { name: "APIキー 未設定" }).fill("lingo-test-key");
    await page.getByRole("textbox", { name: "Base URL 任意" }).fill("http://127.0.0.1:4177/v1");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "対訳", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "対訳", exact: true }).waitFor();
    await expect(page.getByRole("combobox", { name: "翻訳先の言語" })).toHaveValue("ja");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator("body").screenshot({ path: testInfo.outputPath("popup-ready-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    check((await page.locator("#api-key").inputValue()) === "", "saved key should never be returned to the popup");
    const request = (type, extra = {}) =>
      page.evaluate(
        async (message) => {
          const result = await chrome.runtime.sendMessage(message);
          if (!result.ok) throw new Error(result.error);
          return result.data;
        },
        { type, tabId, ...extra },
      );
    expect((await request("settings")).model).toBe("gpt-6-sol");
    const waitDone = async () => {
      for (let i = 0; i < 60; i++) {
        const status = await request("status");
        if (status.state === "error") throw new Error(status.error);
        if (status.state === "done") return status;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("translation did not finish");
    };
    const pendingIcons = article.locator('svg[data-lingo-state="pending"]');
    const count = page.locator("#translation-count");
    const cost = page.locator("#translation-cost");
    const mode = (name) => page.getByRole("button", { name, exact: true });
    const batchCount = async () => (await translationRequests(context)).length;
    const business = article.locator("#categories a").first();
    const localMenu = article.getByRole("menu", { name: "この箇所の表示" });
    const choice = (name) => localMenu.getByRole("menuitemradio", { name, exact: true });
    await expect(mode("原文")).toHaveAttribute("aria-pressed", "true");
    await context.request.get("http://127.0.0.1:4177/mode/hold-first");
    await mode("全訳").click();
    await mode("翻訳").click();
    await expect(pendingIcons).toHaveCount(12);
    await article.mouse.move(0, 0);
    const visiblePending = () =>
      pendingIcons.evaluateAll((icons) =>
        icons
          .filter((icon) => globalThis.getComputedStyle(icon).opacity !== "0")
          .map((icon) => icon.closest("[data-lingo-marker-source]").id),
      );
    await expect.poll(visiblePending).toEqual([]);
    await expect(count).toHaveText("4/16");
    await expect(page.getByRole("button", { name: "翻訳中…", exact: true })).toBeDisabled();
    await expect(cost).toBeEmpty();
    await expect(page.getByRole("button", { name: /翻訳を中止|訳文を消去/ })).toHaveCount(0);
    await expect(business).toHaveText("ビジネス向け", { useInnerText: true });
    await expect(pendingIcons.first().locator("path:last-child")).toHaveCSS("fill", "rgb(195, 93, 89)");
    await expect(article.locator("#inline a").first()).toBeVisible();
    await mode("対訳").click();
    await expect(article.locator("#categories a").first()).toHaveText("Business ビジネス向け");
    await expect(pendingIcons.first().locator("path:first-child")).toHaveCSS("fill", "none");
    await expect(pendingIcons.first().locator("path:first-child")).toHaveCSS("stroke", "rgb(195, 93, 89)");
    await expect(pendingIcons.first().locator("path:nth-child(2)")).toHaveCSS("fill", "rgb(134, 148, 95)");
    const pendingParagraph = article.locator("#first");
    const pendingPath = pendingParagraph.locator('svg[data-lingo-state="pending"] path').first();
    const pulseCount = () => pendingPath.evaluate((el) => el.getAnimations().length);
    await expect.poll(pulseCount).toBe(0);
    await pendingParagraph.hover({ position: { x: 4, y: 4 } });
    await expect.poll(visiblePending).toEqual(["first"]);
    await expect.poll(pulseCount).toBe(1);
    await article.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(visiblePending).toEqual(["first"]);
    await expect.poll(pulseCount).toBe(0);
    await expect(pendingPath).toHaveCSS("opacity", "1");
    await article.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(pulseCount).toBe(1);
    await pendingParagraph.screenshot({ path: testInfo.outputPath("paragraph-pending.png") });
    await article.locator("#inline a").first().hover();
    await expect.poll(visiblePending).toEqual(["inline"]);
    await expect.poll(pulseCount).toBe(0);
    const touch = await context.newCDPSession(article);
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await expect.poll(visiblePending).toEqual([]);
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await touch.detach();
    await article.mouse.move(0, 0);
    await expect.poll(visiblePending).toEqual([]);
    await context.request.get("http://127.0.0.1:4177/mode/ok");

    const status = await waitDone();
    await expect(pendingIcons).toHaveCount(0);
    await expect(article.locator('#categories a svg[data-lingo-state="done"] path').first()).toHaveCSS(
      "fill",
      "rgb(195, 93, 89)",
    );
    await article.locator("#first").screenshot({ path: testInfo.outputPath("paragraph-done.png") });
    expect([status.done, status.total]).toEqual([16, 16]);
    await expect(count).toHaveText("16/16");
    await expect(page.getByRole("button", { name: "翻訳済み", exact: true })).toBeDisabled();
    const beforeDynamic = await batchCount();
    await page.goto("about:blank");
    await article.evaluate(() => {
      const { document } = globalThis;
      const section = document.createElement("section");
      section.id = "dynamic-panel";
      section.innerHTML = "<button>開く</button><p hidden>Click reveals this paragraph.</p>";
      document.body.append(section);
      section.querySelector("button").onclick = () => (section.querySelector("p").hidden = false);
      globalThis.addEventListener(
        "scroll",
        () => {
          const extra = document.createElement("p");
          extra.textContent = "Scroll loads another paragraph.";
          section.append(extra);
        },
        { once: true },
      );
    });
    await article.locator("#dynamic-panel button").click();
    await article.evaluate(() => globalThis.scrollTo(0, 0));
    await expect(article.locator("#dynamic-panel lingo-translation")).toHaveCount(2);
    const dynamicRequests = await translationRequests(context);
    expect(dynamicRequests.slice(beforeDynamic).flat().sort()).toEqual([
      "Click reveals this paragraph.",
      "Scroll loads another paragraph.",
    ]);
    await page.goto(popupUrl);
    await mode("全訳").click();
    const reusedParagraph = article.locator("#dynamic-panel p").first();
    await reusedParagraph.evaluate((el) => {
      const walker = globalThis.document.createTreeWalker(el, globalThis.NodeFilter.SHOW_TEXT);
      walker.nextNode().textContent = "Ready";
    });
    await expect(reusedParagraph.locator("lingo-translation")).toHaveText("準備完了");
    expect((await translationRequests(context)).length).toBe(dynamicRequests.length);
    await waitDone();
    await mode("対訳").click();
    await article.locator("#dynamic-panel").evaluate((el) => el.remove());
    await request("start");
    await waitDone();
    await expect(page.getByRole("button", { name: "翻訳済み", exact: true })).toBeDisabled();
    await expect(page.locator("#progress")).toBeEmpty();
    check(
      (await article.locator("#inline a").first().getAttribute("href")) === "#details",
      "original link must remain",
    );
    await expect(article.locator("#inline")).toHaveText(
      "Read the original story & the field notes at your own pace. ↩ 自分のペースで読書ノートと原文を読んでみましょう。 ↩",
      { useInnerText: true },
    );
    check((await article.locator("#attack img").count()) === 0, "translation HTML must not execute");
    check((await article.locator("#japanese lingo-translation").count()) === 0, "Japanese text should be skipped");
    await article.locator("#inline lingo-translation").hover();
    const { notePoint, ...linked } = await worker.evaluate(
      async (id) =>
        (
          await chrome.scripting.executeScript({
            target: { tabId: id },
            func: () => {
              const host = globalThis.document.querySelector("#inline lingo-translation");
              const root = chrome.dom.openOrClosedShadowRoot(host);
              const words = host.firstElementChild;
              const original = host.parentElement;
              const bounds = words.querySelector("a").getBoundingClientRect();
              return {
                notePoint: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
                text: words.textContent,
                links: [...words.querySelectorAll("a")].map((a) => [
                  a.textContent,
                  a.href,
                  a.target,
                  a.rel,
                  a.className,
                ]),
                opacity: [original, original.querySelector("a"), words, root.querySelector("svg")].map(
                  (el) => globalThis.getComputedStyle(el).opacity,
                ),
              };
            },
          })
        )[0].result,
      tabId,
    );
    const articleUrl = article.url();
    expect(linked).toEqual({
      text: "自分のペースで読書ノートと原文を読んでみましょう。 ↩",
      links: [
        ["読書ノート", new URL("?PRIVATE=notes", articleUrl).href, "_blank", "noreferrer", "field-notes"],
        ["原文", articleUrl + "#details", "", "", ""],
        ["↩", articleUrl + "#inline", "", "", ""],
      ],
      opacity: ["1", "1", "0.75", "1"],
    });
    const sourceNote = article.locator("#inline > a.field-notes");
    const translatedNote = article.locator("#inline lingo-translation a.field-notes");
    for (const scheme of ["dark", "light"]) {
      await article.emulateMedia({ colorScheme: scheme });
      const color = await sourceNote.evaluate((link) => globalThis.getComputedStyle(link).color);
      await expect(translatedNote).toHaveCSS("color", color);
      await expect(translatedNote).toHaveCSS("text-decoration-line", "none");
    }
    const [notesTab] = await Promise.all([context.waitForEvent("page"), article.mouse.click(notePoint.x, notePoint.y)]);
    await expect(notesTab).toHaveURL(new URL("?PRIVATE=notes", articleUrl).href);
    await notesTab.close();
    const typography = await worker.evaluate(
      async (id) =>
        (
          await chrome.scripting.executeScript({
            target: { tabId: id },
            func: () =>
              ["h1 lingo-translation", "#details + lingo-translation", "#first lingo-translation"].map((selector) => {
                const host = globalThis.document.querySelector(selector);
                const text = chrome.dom.openOrClosedShadowRoot(host).firstElementChild;
                const { textAlign, fontSize } = globalThis.getComputedStyle(text);
                const marker = text.querySelector('svg[data-lingo-state="done"]');
                return { textAlign, fontSize, fill: globalThis.getComputedStyle(marker.firstElementChild).fill };
              }),
          })
        )[0].result,
      tabId,
    );
    expect(typography).toEqual([
      { textAlign: "center", fontSize: "21px", fill: "rgb(195, 93, 89)" },
      { textAlign: "right", fontSize: "17px", fill: "rgb(195, 93, 89)" },
      { textAlign: "start", fontSize: "13.5px", fill: "rgb(195, 93, 89)" },
    ]);
    const storageCheck = await worker.evaluate(
      async (id) =>
        (
          await chrome.scripting.executeScript({
            target: { tabId: id },
            func: async () => {
              try {
                await chrome.storage.local.get("settings");
                return false;
              } catch {
                return true;
              }
            },
          })
        )[0].result,
      tabId,
    );
    check(storageCheck, "content script must not read stored credentials");
    const sent = await translationRequests(context);
    check(
      sent.flat().includes("Run npm install to get started. Keep your API key private."),
      "inline code must remain in the translation unit",
    );
    await article.screenshot({ path: testInfo.outputPath("article-light.png"), fullPage: true });
    await article.emulateMedia({ colorScheme: "dark" });
    await article.screenshot({ path: testInfo.outputPath("article-dark.png"), fullPage: true });
    const translatedBatches = await batchCount();
    await mode("全訳").click();
    await expect(article.locator("#inline a").first()).toBeHidden();
    await expect(article.locator("#inline lingo-translation")).toBeVisible();
    expect(
      await worker.evaluate(
        async (id) =>
          (
            await chrome.scripting.executeScript({
              target: { tabId: id },
              func: () =>
                ["h1", "#first", "#details"].map((selector) => {
                  const source = globalThis.document.querySelector(selector);
                  const host = source.querySelector("lingo-translation") ?? source.nextElementSibling;
                  const words = globalThis.getComputedStyle(host.firstElementChild);
                  const original = globalThis.getComputedStyle(source);
                  return (
                    ["fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight", "letterSpacing", "color"].every(
                      (property) => words[property] === original[property],
                    ) && words.opacity === "1"
                  );
                }),
            })
          )[0].result,
        tabId,
      ),
    ).toEqual([true, true, true]);
    await request("start");
    await waitDone();
    // 全訳中の状態確認は、サイト側の原文やリンクをDOMから出し入れしない。
    await article.evaluate(() => {
      const paragraph = globalThis.document.querySelector("#inline");
      paragraph.dataset.changes = "0";
      const observer = new globalThis.MutationObserver(() => {
        observer.disconnect();
        paragraph.dataset.changes = "1";
      });
      observer.observe(paragraph, { childList: true, subtree: true });
    });
    expect((await request("status")).hasRemaining).toBe(false);
    await expect(article.locator("#inline")).toHaveAttribute("data-changes", "0");
    const businessApple = business.getByRole("button");
    const appleColors = () =>
      businessApple.locator("path").evaluateAll((paths) => paths.map((path) => globalThis.getComputedStyle(path).fill));
    const green = "rgb(134, 148, 95)",
      red = "rgb(195, 93, 89)";
    await expect(businessApple).toHaveAccessibleName("この箇所の表示を選択（現在は全訳）");
    expect(await appleColors()).toEqual([red, red]);
    await businessApple.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await businessApple.click();
    await expect(localMenu.getByRole("menuitemradio")).toHaveText(["原文", "対訳", "全訳"]);
    await expect(choice("全訳")).toHaveAttribute("aria-checked", "true");
    await expect(business).toHaveText("ビジネス向け", { useInnerText: true });
    const menuBox = await localMenu.boundingBox();
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual((await businessApple.boundingBox()).y);
    const labelBox = await business.boundingBox();
    const left = Math.min(labelBox.x, menuBox.x) - 6;
    await article.screenshot({
      path: testInfo.outputPath("part-modes.png"),
      clip: {
        x: left,
        y: menuBox.y - 6,
        width: Math.max(labelBox.x + labelBox.width, menuBox.x + menuBox.width) - left + 6,
        height: labelBox.y + labelBox.height - menuBox.y + 12,
      },
    });
    await choice("原文").click();
    await expect(localMenu).toHaveCount(0);
    await expect(business).toHaveText("Business", { useInnerText: true });
    await expect(article).toHaveURL(articleUrl);
    expect(await appleColors()).toEqual([green, green]);
    await businessApple.press("Enter");
    await choice("原文").press("ArrowRight");
    await expect(choice("対訳")).toBeFocused();
    await choice("対訳").press("Enter");
    await expect(business).toHaveText("Business ビジネス向け", { useInnerText: true });
    expect(await appleColors()).toEqual([red, green]);
    await businessApple.press("Space");
    await choice("対訳").press("Escape");
    await expect(businessApple).toBeFocused();
    await expect(localMenu).toHaveCount(0);
    await businessApple.click();
    await choice("全訳").click();
    await expect(business).toHaveText("ビジネス向け", { useInnerText: true });
    await mode("原文").click();
    await expect(article.locator("#inline lingo-translation")).toBeHidden();
    await expect(article.locator("#inline a").first()).toBeVisible();
    await article.locator("#inline").getByRole("button").press("Enter");
    await choice("対訳").click();
    await expect(article.locator("#inline lingo-translation")).toBeVisible();
    await expect(article.locator("#first lingo-translation")).toBeHidden();
    await mode("原文").click();
    await expect(article.locator("#inline lingo-translation")).toBeHidden();
    await page.reload();
    await expect(mode("原文")).toHaveAttribute("aria-pressed", "true");
    await mode("対訳").click();
    await expect(article.locator("#first lingo-translation")).toBeVisible();
    await expect(count).toHaveText("16/16");
    expect(await batchCount()).toBe(translatedBatches);
    await request("start");
    await waitDone();
    check((await article.locator("lingo-translation").count()) === 13, "repeat must not duplicate translations");
    const categories = article.locator("#categories");
    await expect(categories.locator(":scope > *")).toHaveCount(2);
    await expect(categories.getByRole("link")).toHaveText(["Business ビジネス向け", "Personal 個人向け"]);
    await expect(categories.getByText("ビジネス向け", { exact: true })).toHaveCSS("opacity", "1");
    const plansLabel = article.locator('button[aria-controls="plans"] > span');
    await expect(plansLabel).toHaveText("Plans プラン");
    await plansLabel.evaluate((label) => (label.style.fontSize = "20px"));
    await expect(plansLabel.getByText("プラン", { exact: true })).toHaveCSS("font-size", "15px");
    await expect(plansLabel.getByText("プラン", { exact: true })).toHaveCSS("opacity", "0.75");
    await plansLabel.hover();
    await expect(plansLabel.locator("svg")).toHaveCSS("opacity", "1");
    const plansButton = article.locator('button[aria-controls="plans"]');
    await plansButton.evaluate((button) =>
      button.addEventListener("click", () => {
        button.dataset.activated = "yes";
      }),
    );
    await plansLabel.getByRole("button").press("Space");
    await choice("全訳").click();
    await expect(plansLabel).toHaveText("プラン", { useInnerText: true });
    await expect(plansLabel.getByText("プラン", { exact: true })).toHaveCSS("font-size", "20px");
    await expect(plansButton).not.toHaveAttribute("data-activated", "yes");
    const disableSite = () => request("setSite", { hostname: "127.0.0.1", enabled: false });
    await disableSite();
    check((await article.locator("lingo-translation").count()) === 0, "restore must remove translations");
    expect(await article.locator("#inline").innerHTML()).toBe(originalParagraph);
    await expect(article.locator("[data-lingo-state]")).toHaveCount(0);
    await expect(categories.getByRole("link")).toHaveText(["Business", "Personal"]);
    await expect(plansLabel).toHaveText("Plans");
    // 別モデルの未翻訳の状態で、処理中に設定を保存した場合を確認する。
    const originalSettings = await request("settings");
    const selectTestModel = (model) =>
      request("save", { settings: { baseUrl: originalSettings.baseUrl, model, apiKey: "" } });
    await selectTestModel("cancel-on-save");
    await context.request.get("http://127.0.0.1:4177/mode/hold-first");
    await request("start");
    await expect(pendingIcons).toHaveCount(12);
    const currentSettings = await request("settings");
    await request("save", { settings: { baseUrl: currentSettings.baseUrl, model: currentSettings.model, apiKey: "" } });
    await expect(pendingIcons).toHaveCount(0);
    await page.reload();
    await expect(count).toHaveText("4/16");
    await disableSite();
    await expect(count).toBeEmpty();
    await selectTestModel("cancel-on-navigation");
    await context.request.get("http://127.0.0.1:4177/mode/slow");
    await request("start");
    await expect(pendingIcons).toHaveCount(16);
    await disableSite();
    await expect(pendingIcons).toHaveCount(0);
    await new Promise((resolve) => setTimeout(resolve, 2700));
    check((await article.locator("lingo-translation").count()) === 0, "cancelled responses must not reappear");
    await request("start");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await article.goto("http://127.0.0.1:4177/tests/article.html?new-page");
    await new Promise((resolve) => setTimeout(resolve, 2700));
    check((await article.locator("lingo-translation").count()) === 0, "navigation must discard stale responses");
    await context.request.get("http://127.0.0.1:4177/mode/hold-first");
    await mode("翻訳").click();
    await expect(count).toHaveText("4/16");
    await expect(mode("翻訳中…")).toBeDisabled();
    await context.request.get("http://127.0.0.1:4177/mode/error");
    for (let i = 0; i < 30; i++) {
      const state = await request("status");
      if (state.state === "error") {
        check(
          !state.error.includes("SECRET") && !state.error.includes("lingo-test-key"),
          "server errors must be redacted",
        );
        break;
      }
      if (i === 29) throw new Error("expected API error");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await expect(pendingIcons).toHaveCount(0);
    await expect(page.locator("#progress")).toContainText("APIキーが無効");
    await expect(mode("翻訳")).toBeEnabled();
    await expect(count).toHaveText("4/16");
    const requestsAfterError = await batchCount();
    const rejected = await page.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: "save",
        settings: { baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", apiKey: "" },
      }),
    );
    check(!rejected.ok, "destination change without key must fail");
    await context.request.get("http://127.0.0.1:4177/mode/ok");
    const siteToggle = page.getByRole("switch", { name: "このサイトを自動翻訳" });
    const language = page.getByRole("combobox", { name: "翻訳元の言語" });
    const targetLanguage = page.getByRole("combobox", { name: "翻訳先の言語" });
    for (const select of [language, targetLanguage])
      await expect(select.locator("option")).toHaveText(["EN", "JA", "ZH"]);
    await expect(targetLanguage).toHaveValue("ja");
    await expect(targetLanguage).toHaveCSS("border-style", "none");
    await expect(language).toHaveValue("en");
    await expect(language).toHaveCSS("border-style", "none");
    await page.getByRole("button", { name: "設定", exact: true }).press("Tab");
    await expect(language).toBeFocused();
    await expect(language).toHaveCSS("outline-style", "solid");
    await expect(siteToggle).toHaveAccessibleDescription("127.0.0.1");
    const iconTitle = () => worker.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId);
    await expect(siteToggle).not.toBeChecked();
    expect(await batchCount()).toBe(requestsAfterError);
    await context.request.get("http://127.0.0.1:4177/mode/hold-first");
    await mode("翻訳").click();
    await expect(mode("翻訳中…")).toBeDisabled();
    await expect.poll(batchCount).toBe(requestsAfterError + 1);
    await expect(count).toHaveText("4/16");
    for (const id of ["site-label", "site-host"]) {
      await page.locator("#" + id).click();
      await expect(siteToggle).not.toBeChecked();
    }
    await page.locator(".site-option").click({ position: { x: 210, y: 20 } });
    await expect(siteToggle).not.toBeChecked();
    await siteToggle.check();
    await expect.poll(iconTitle).toContain(" ON");
    await expect(siteToggle).toBeEnabled();
    await context.request.get("http://127.0.0.1:4177/mode/retry-twice");
    await expect.poll(batchCount).toBe(requestsAfterError + 2);
    await expect(mode("翻訳中…")).toBeDisabled();
    await expect(count).toHaveText("16/16");
    const retried = (await translationRequests(context)).slice(requestsAfterError);
    expect(retried).toEqual([retried[0], retried[0], retried[0]]);
    await article.getByRole("button", { name: "Plans" }).click();
    await expect(count).toHaveText("17/17");
    await article.locator("h1").hover();
    await article.goto("http://127.0.0.1:4177/tests/article.html?auto");
    await expect(article.locator("#first lingo-translation")).toHaveCount(1);
    await expect(article.locator("#plans lingo-translation")).toHaveCount(0);
    await mode("全訳").click();
    await article.locator('button[aria-controls="plans"]').hover();
    await expect(article.locator("#plans lingo-translation")).toHaveCount(1);
    await expect(article.locator("#plans p")).not.toContainText("Compare available plans", { useInnerText: true });
    expect((await translationRequests(context)).at(-1)).toEqual(["Compare available plans"]);
    const anotherTab = await context.newPage();
    await anotherTab.goto("http://127.0.0.1:4177/tests/article.html?another");
    await expect(anotherTab.locator("#first lingo-translation")).toHaveCount(1);
    await language.selectOption("zh");
    for (const target of [article, anotherTab]) {
      await expect(target.locator("#simplified lingo-translation, #traditional lingo-translation")).toHaveCount(2);
      await expect(target.locator("#kanji lingo-translation, #first lingo-translation")).toHaveCount(0);
    }
    const otherHost = await context.newPage();
    await otherHost.goto("http://localhost:4177/tests/article.html");
    await expect(otherHost.locator("lingo-translation")).toHaveCount(0);
    await page.reload();
    await expect(siteToggle).toBeChecked();
    await expect(language).toHaveValue("zh");
    await siteToggle.uncheck();
    await expect.poll(iconTitle).toContain(" OFF");
    await expect(anotherTab.locator("lingo-translation")).toHaveCount(0);
    await anotherTab.close();
    await otherHost.close();
    await expect(article.locator("lingo-translation")).toHaveCount(0);
    await article.reload();
    await article.getByRole("button", { name: "Plans" }).hover();
    await expect(article.locator("lingo-translation")).toHaveCount(0);
    await page.reload();
    await expect(language).toHaveValue("zh");
    await page.getByRole("button", { name: "対訳" }).click();
    await mode("翻訳").click();
    await expect(count).toHaveText("2/2");
    await targetLanguage.selectOption("zh");
    await expect(language).toHaveValue("ja");
    await page.getByRole("button", { name: "翻訳", exact: true }).click();
    await expect(article.locator('#kanji lingo-translation[lang="zh"]')).toHaveCount(1);
    await targetLanguage.selectOption("en");
    await expect(count).toBeEmpty();
    await page.reload();
    await expect(language).toHaveValue("ja");
    await expect(targetLanguage).toHaveValue("en");
    await page.getByRole("button", { name: "翻訳", exact: true }).click();
    await expect(article.locator('#kanji lingo-translation[lang="en"]')).toHaveCount(1);
    await language.selectOption("en");
    await expect(targetLanguage).toHaveValue("ja");
    await expect(count).toBeEmpty();
    await expect(siteToggle).not.toBeChecked();
    await expect(article.locator("lingo-translation")).toHaveCount(0);
    // 上限を超えるページでも、先頭のアコーディオンボタンを本文と同じ順序で拾う。
    await article.evaluate(() => {
      const { document } = globalThis;
      document.body.innerHTML =
        '<h4><button aria-expanded="false"><span>Why choose LastPass?</span></button></h4><a href="#plans" role="tab" style="font-size:16px">Plans</a>';
      for (let i = 0; i < 1000; i++) {
        const paragraph = document.createElement("p");
        paragraph.textContent = "Footer entry " + i;
        document.body.append(paragraph);
      }
    });
    await request("start");
    const firstPass = await waitDone();
    expect([firstPass.done, firstPass.skipped]).toEqual([1000, 2]);
    await expect(article.locator("h4 button")).toContainText("テスト訳");
    const plansTab = article.getByRole("tab");
    await expect(plansTab).toHaveText("Plans プラン");
    await expect(plansTab.getByText("プラン", { exact: true })).toHaveCSS("font-size", "12px");
    await expect(article.locator("p").last().locator("lingo-translation")).toHaveCount(0);
    await request("start");
    expect((await waitDone()).done).toBe(1002);
    expect((await translationRequests(context)).at(-1)).toEqual(["Footer entry 998", "Footer entry 999"]);
    await expect(article.locator("p").last().locator("lingo-translation")).toHaveCount(1);
    await request("forget");
    check(!(await request("settings")).hasKey, "forgotten key must be absent");
    await article.reload();
    // 公式の料金での表示もローカル疑似APIで検証する。外部には接続しない。
    await worker.evaluate(async () => {
      const fetchLocal = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (url !== "https://api.openai.com/v1/chat/completions") throw new Error("Unexpected test API");
        return fetchLocal("http://127.0.0.1:4177/v1/chat/completions", options);
      };
      await chrome.storage.local.set({
        settings: { baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", apiKey: "lingo-test-key" },
      });
    });
    await page.goto(popupUrl);
    const total = page.locator("#usage-total");
    const clear = page.getByRole("button", { name: "累計をクリア" });
    await expect(page.locator("footer")).toBeHidden();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await expect(page.locator("footer")).toBeVisible();
    await clear.click();
    await expect(total).toHaveText("累計 0ページ · 0円");
    await page.getByRole("button", { name: "戻る", exact: true }).click();
    await expect(page.locator("footer")).toBeHidden();
    await context.request.get("http://127.0.0.1:4177/mode/hold-first");
    await page.getByRole("button", { name: "対訳", exact: true }).click();
    await mode("翻訳").click();
    await expect(count).toHaveText("4/16");
    await expect(total).toHaveText("累計 1ページ · 約0.06円");
    await expect(cost).toHaveText("約0.06円");
    await expect(cost).toHaveCSS("font-size", await count.evaluate((el) => globalThis.getComputedStyle(el).fontSize));
    const resultBox = await page.locator("#translation-result").boundingBox();
    const titleBox = await page.getByRole("heading", { name: "Lingo", exact: true }).boundingBox();
    expect(resultBox.x - (titleBox.x + titleBox.width)).toBeCloseTo(12, 0);
    expect(Math.abs(resultBox.y + resultBox.height / 2 - titleBox.y - titleBox.height / 2)).toBeLessThan(1);
    const actionBox = await page.locator("#translate").boundingBox();
    const rowBox = await page.locator(".languages").boundingBox();
    expect(actionBox.x + actionBox.width).toBeCloseTo(rowBox.x + rowBox.width, 0);
    await page.locator("body").screenshot({ path: testInfo.outputPath("popup-running.png") });
    await mode("原文").click();
    await context.request.get("http://127.0.0.1:4177/mode/ok");
    await expect(count).toHaveText("16/16");
    await expect(cost).toHaveText("約0.11円");
    await expect(article.locator("#first lingo-translation")).toBeHidden();
    await mode("対訳").click();
    await page.reload();
    await expect(cost).toHaveText("約0.11円");
    await expect(total).toHaveText("累計 1ページ · 約0.11円");
    await page.locator("body").screenshot({ path: testInfo.outputPath("popup-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator("body").screenshot({ path: testInfo.outputPath("popup-dark.png") });
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await expect(cost).toBeHidden();
    await page.getByRole("button", { name: "戻る", exact: true }).click();
    await expect(cost).toBeVisible();
    await mode("原文").click();
    await expect(count).toHaveText("16/16");
    await expect(cost).toHaveText("約0.11円");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator("body").screenshot({ path: testInfo.outputPath("settings.png") });
    await worker.evaluate(() =>
      chrome.storage.local.set({
        settings: { model: "team/legacy", apiKey: "lingo-test-key", baseUrl: "https://api.openai.com/v1" },
      }),
    );
    await page.reload();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await expect(model).toHaveValue("team/legacy");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("設定を保存しました。", { exact: true })).toBeVisible();
    expect((await request("settings")).model).toBe("team/legacy");
    // モード切り替え直後の状態取得だけ失敗させ、画面の復帰を確認する。
    await page.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      let switched = false;
      chrome.runtime.sendMessage = async (message) => {
        if (switched && message.type === "status") {
          chrome.runtime.sendMessage = send;
          return { ok: false, error: "状態を取得できませんでした。" };
        }
        const response = await send(message);
        if (message.type === "displayMode") switched = true;
        return response;
      };
    });
    await mode("原文").click();
    await expect(page.locator("#message")).toHaveText("状態を取得できませんでした。");
    await expect(mode("対訳")).toBeEnabled();

    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "キーを削除" }).click();
    await expect(page.getByRole("button", { name: "キーを削除" })).toBeHidden();
    expect(runtimeErrors).toBe(0);
    check(missingAssets.length === 0, `Missing extension resources: ${missingAssets.join(", ")}`);
  } finally {
    await context.close();
  }
});

async function openTestPage(context, fixture = "listing") {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() =>
    chrome.storage.local.set({
      settings: { baseUrl: "http://127.0.0.1:4177/v1", apiKey: "lingo-test-key", model: "gpt-6-luna" },
    }),
  );
  const article = await context.newPage();
  await article.setViewportSize({ width: 850, height: 350 });
  await article.goto(`http://127.0.0.1:4177/tests/${fixture}.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, article.url());
  const popup = await context.newPage();
  await popup.goto(worker.url().replace("background.js", "popup.html#tab=" + tabId));
  return { article, popup, tabId };
}

// 本文、見出し、リンクで、表示中の文字の最終行とりんごの位置を測る。
async function expectMarkerAtTextEnd(worker, tabId, selectors, original) {
  const positions = await worker.evaluate(
    async ({ tabId, selectors, original }) =>
      (
        await chrome.scripting.executeScript({
          target: { tabId },
          args: [selectors, original],
          func: (selectors, original) =>
            selectors.map((selector) => {
              const doc = globalThis.document;
              const source = doc.querySelector(selector);
              const host =
                source.querySelector("lingo-translation") ?? source.nextElementSibling?.closest("lingo-translation");
              const words = host?.firstElementChild ?? source.querySelector('[lang="ja"]');
              const marker = (!original && host ? chrome.dom.openOrClosedShadowRoot(host) : source).querySelector(
                "svg[data-lingo-state]",
              );
              const text = original
                ? doc.createTreeWalker(source, globalThis.NodeFilter.SHOW_TEXT).nextNode()
                : words.lastChild;
              const range = doc.createRange();
              range.selectNodeContents(text);
              const end = [...range.getClientRects()].at(-1);
              const icon = marker?.getBoundingClientRect();
              return {
                selector,
                gap: icon && icon.left - end.right,
                sameLine: icon && icon.top < end.bottom && end.top < icon.bottom,
              };
            }),
        })
      )[0].result,
    { tabId, selectors, original },
  );
  for (const { selector, gap, sameLine } of positions) {
    expect(sameLine, selector).toBe(true);
    expect(gap, selector).toBeGreaterThanOrEqual(0);
    expect(gap, selector).toBeLessThanOrEqual(8);
  }
}

test("推奨を選ぶと配信されたモデルで翻訳して配信単価で集計する", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { popup } = await openTestPage(context);
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(async () => {
      const fetchLocal = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (url !== "https://api.openai.com/v1/chat/completions") return fetchLocal(url, options);
        if (JSON.parse(options.body).model !== "test-fast") throw new Error("Expected the recommended model");
        return fetchLocal("http://127.0.0.1:4177/v1/chat/completions", options);
      };
      await chrome.storage.local.set({
        settings: { baseUrl: "https://api.openai.com/v1", apiKey: "lingo-test-key", model: "@recommended" },
      });
    });
    await popup.reload();
    await popup.getByRole("button", { name: "翻訳", exact: true }).click();
    await expect(popup.locator("#translation-count")).toHaveText("2/2");
    // 1,000入力×1ドル + 500出力×2ドル（100万トークン当たり）。
    await expect(popup.locator("#translation-cost")).toHaveText("約0.32円");
  } finally {
    await context.close();
  }
});

test("ページを開き直して保存済みの訳文を使い、変更した文章だけ送る", async ({ playwright }, testInfo) => {
  const profile = testInfo.outputPath("profile");
  let context = await launchExtension(playwright.chromium, testInfo, profile);
  try {
    let { article, popup } = await openTestPage(context);
    const translate = () => popup.getByRole("button", { name: "翻訳", exact: true }).click();
    const done = () => popup.getByRole("button", { name: "翻訳済み", exact: true });
    await translate();
    await expect(done()).toBeVisible();
    const before = (await translationRequests(context)).length;
    const labels = () => article.locator("a.listing-title [lang=ja]");
    const originals = await labels().allTextContents();
    expect(originals).toHaveLength(2);
    await context.close();
    context = await launchExtension(playwright.chromium, testInfo, profile);
    ({ article, popup } = await openTestPage(context));
    await article.goto(article.url() + "?revisit");
    await translate();
    await expect(done()).toBeVisible();
    await expect(labels()).toHaveText(originals);
    expect((await translationRequests(context)).length).toBe(before);
    await article.reload();
    await article
      .locator("a.listing-title")
      .last()
      .evaluate((link) => link.replaceChildren("Ready"));
    await translate();
    await expect(done()).toBeVisible();
    await expect(labels()).toHaveText([originals[0], "準備完了"]);
    expect((await translationRequests(context)).slice(before)).toEqual([["Ready"]]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("訳文は最近使った1,000件を保存し、シークレット用の読み書きは行わない", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { popup } = await openTestPage(context);
    const result = await popup.evaluate(async () => {
      const { lookupTranslations, saveTranslations } = await import(chrome.runtime.getURL("translation-cache.js"));
      const batch = Array.from({ length: 1001 }, (_, id) => ({ id, text: "Test entry " + id }));
      const scope = ["http://example.test", "endpoint", "model", "en", "ja"];
      const save = async (scope, items) => {
        const { keys } = await lookupTranslations(scope, items);
        await saveTranslations(keys, items);
      };
      await save(scope, batch.slice(0, 2));
      await save(scope, batch.slice(2, 1000));
      await lookupTranslations(scope, [batch[0]]);
      await save(scope, [batch[1000]]);
      const { missing } = await lookupTranslations(scope, batch);
      const privateItem = { id: 2000, text: "Private entry" };
      await save(null, [privateItem]);
      return {
        evicted: missing.map((item) => item.id),
        privateHits: (await lookupTranslations(null, [batch[0]])).hits,
        sharedPrivateHits: (await lookupTranslations(scope, [privateItem])).hits,
        otherSiteHits: (await lookupTranslations(["https://other.test", ...scope.slice(1)], [batch[0]])).hits,
      };
    });
    expect(result).toEqual({ evicted: [1], privateHits: [], sharedPrivateHits: [], otherSiteHits: [] });
  } finally {
    await context.close();
  }
});

test("原文・対訳・全訳でりんごが最後の文字と同じ行に並ぶ", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { article, popup, tabId } = await openTestPage(context, "article");
    const worker = context.serviceWorkers()[0];
    const paragraph = article.locator("#first");
    const originalHtml = await paragraph.evaluate((p) => {
      p.firstChild.appendData("\n    ");
      return p.innerHTML;
    });
    const button = (name) => popup.getByRole("button", { name, exact: true });
    await button("翻訳").click();
    await expect(button("翻訳済み")).toBeDisabled();
    for (const mode of ["対訳", "全訳", "原文"]) {
      await button(mode).click();
      const original = mode === "原文";
      for (const width of [850, 320]) {
        await article.setViewportSize({ width, height: 350 });
        await expectMarkerAtTextEnd(worker, tabId, ["#first", "#details", "#categories a"], original);
      }
      // 文章ちょうどの幅でも、りんごだけが次の行に落ちないことを確かめる。
      await paragraph.evaluate((p, original) => {
        const text = original ? p.firstChild : p.querySelector("lingo-translation > span").lastChild;
        const range = globalThis.document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.data.trimEnd().length);
        p.style.width = "max-content";
        p.style.width = Math.ceil(range.getBoundingClientRect().width) + 1 + "px";
      }, original);
      await expectMarkerAtTextEnd(worker, tabId, ["#first"], original);
      await paragraph.evaluate((p) => p.style.removeProperty("width"));
    }
    await popup.evaluate(
      (id) => chrome.runtime.sendMessage({ type: "setSite", hostname: "127.0.0.1", enabled: false, tabId: id }),
      tabId,
    );
    expect(await paragraph.innerHTML()).toBe(originalHtml);
    expect(await paragraph.evaluate((p) => p.childNodes.length)).toBe(1);
  } finally {
    await context.close();
  }
});

test("本文のりんごはホバー・キーボード操作・メニュー表示中に現れる", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { article, popup, tabId } = await openTestPage(context, "article");
    const worker = context.serviceWorkers()[0];
    const markerStates = () =>
      worker.evaluate(
        async (id) =>
          (
            await chrome.scripting.executeScript({
              target: { tabId: id },
              func: () =>
                ["#first", "#details"].map((selector) => {
                  const source = globalThis.document.querySelector(selector);
                  const host = source.querySelector("lingo-translation") ?? source.nextElementSibling;
                  const marker =
                    chrome.dom.openOrClosedShadowRoot(host).querySelector("svg") ??
                    source.querySelector("svg[data-lingo-state]");
                  return {
                    opacity: globalThis.getComputedStyle(marker).opacity,
                    animations: marker.getAnimations({ subtree: true }).length,
                  };
                }),
            })
          )[0].result,
        tabId,
      );
    const expectStaticMarkers = (...opacities) =>
      expect.poll(markerStates).toEqual(opacities.map((opacity) => ({ opacity, animations: 0 })));
    const button = (name) => popup.getByRole("button", { name, exact: true });
    await button("翻訳").click();
    await expect(button("翻訳済み")).toBeDisabled();
    await article.mouse.move(0, 0);
    await expectStaticMarkers("0", "0");
    const paragraph = article.locator("#first");
    const height = (await paragraph.boundingBox()).height;
    await paragraph.screenshot({ path: testInfo.outputPath("paragraph-idle.png") });
    await paragraph.hover({ position: { x: 4, y: 4 } });
    await expectStaticMarkers("1", "0");
    expect((await paragraph.boundingBox()).height).toBe(height);
    await paragraph.screenshot({ path: testInfo.outputPath("paragraph-hover.png") });
    await article.locator("#details").hover();
    await expectStaticMarkers("0", "1");
    await button("全訳").click();
    await article.locator("#details + lingo-translation").hover();
    await expectStaticMarkers("0", "1");

    await button("原文").click();
    await article.locator("#details").hover();
    await expectStaticMarkers("0", "1");
    await article.mouse.move(0, 0);
    const marker = paragraph.getByRole("button");
    await expect(marker).toHaveCSS("opacity", "0");
    await marker.hover();
    await expectStaticMarkers("1", "0");
    await article.mouse.move(0, 0);
    await article.locator("h1").getByRole("button").focus();
    await article.keyboard.press("Tab");
    await expect(marker).toBeFocused();
    await expect(marker).toHaveCSS("opacity", "1");
    await marker.press("Enter");
    const option = article.getByRole("menuitemradio", { name: "原文" });
    await option.hover();
    await expect(marker).toHaveCSS("opacity", "1");
    await option.press("Escape");
    await expect(marker).toBeFocused();
    await article.mouse.move(0, 0);
    await article.keyboard.press("Tab");
    await expect(marker).toHaveCSS("opacity", "0");

    const devtools = await context.newCDPSession(article);
    await devtools.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await expect(marker).toHaveCSS("opacity", "1");
    await devtools.detach();
  } finally {
    await context.close();
  }
});

test("自動翻訳がオフなら表示モードを選んでも「翻訳」を押すまで送信しない", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const before = (await translationRequests(context)).length;
    const { article, popup } = await openTestPage(context);
    const button = (name) => popup.getByRole("button", { name, exact: true });
    await expect(popup.getByRole("switch")).not.toBeChecked();
    const title = article.locator("a.listing-title").first();
    const original = await title.innerText();
    for (const mode of ["対訳", "原文", "全訳"]) {
      await button(mode).click();
      await expect(button(mode)).toHaveAttribute("aria-pressed", "true");
      await expect(button("翻訳")).toBeEnabled();
    }
    await popup.reload();
    await expect(button("全訳")).toHaveAttribute("aria-pressed", "true");
    await expect(title).toHaveText(original, { useInnerText: true });
    await expect(article.locator("[data-lingo-state]")).toHaveCount(0);
    expect((await translationRequests(context)).length).toBe(before);

    await button("翻訳").click();
    await expect(title).toHaveText("LLMデータをキュレーションするためのツール", { useInnerText: true });
    await expect(button("翻訳済み")).toBeDisabled();
    expect((await translationRequests(context)).length).toBe(before + 1);
  } finally {
    await context.close();
  }
});

test("表の長い訳語をセル内で折り返し、著者名と日付の改行指定を保つ", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { article, popup } = await openTestPage(context, "table");
    await article.setViewportSize({ width: 390, height: 600 });
    const button = (name) => popup.getByRole("button", { name, exact: true });
    const title = article.locator(".summary a > [lang=ja]");
    const description = article.locator(".summary lingo-translation > span");
    const author = article.locator(".author + lingo-translation > span");
    const date = article.locator(".date lingo-translation > span");
    const lines = (words) =>
      words.evaluate((el) => {
        const range = globalThis.document.createRange();
        range.selectNodeContents(el.lastChild);
        return range.getClientRects().length;
      });
    await button("翻訳").click();
    await expect(button("翻訳済み")).toBeDisabled();
    for (const mode of ["対訳", "全訳"]) {
      await button(mode).click();
      await expect(title).toHaveCSS("word-break", "break-all");
      await expect(description).toHaveCSS("word-break", "break-all");
      expect(await lines(title)).toBeGreaterThan(1);
      expect(await lines(description)).toBeGreaterThan(1);
      expect(await lines(author)).toBe(1);
      expect(await lines(date)).toBe(1);
      const pageFits = await article.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      );
      expect(pageFits).toBe(true);
    }
  } finally {
    await context.close();
  }
});

test("行全体がリンクでも指した文章のりんごだけで表示メニューを開ける", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { article, popup } = await openTestPage(context, "table");
    await popup.getByRole("button", { name: "翻訳", exact: true }).click();
    await expect(popup.getByRole("button", { name: "翻訳済み" })).toBeDisabled();
    const paragraphs = article.locator(".summary p");
    const titleMarker = paragraphs.first().getByRole("button");
    const pointAt = async (paragraph) => {
      const box = await paragraph.boundingBox();
      await article.mouse.move(box.x + 2, box.y + 3);
    };
    await pointAt(paragraphs.first());
    await expect(titleMarker).toHaveCSS("opacity", "1");
    await popup.getByRole("button", { name: "原文", exact: true }).click();
    await pointAt(paragraphs.last());
    await expect(paragraphs.last().getByRole("button")).toHaveCSS("opacity", "1");
    await expect(titleMarker).toHaveCSS("opacity", "0");
    await pointAt(paragraphs.first());
    await expect(paragraphs.last().getByRole("button")).toHaveCSS("opacity", "0");
    await titleMarker.click();
    await expect(article.getByRole("menu")).toBeVisible();
    await expect(article).toHaveURL(/table\.html$/);
    await article.getByRole("menuitemradio", { name: "原文" }).press("Escape");
    await pointAt(paragraphs.first());
    await article.mouse.down();
    await article.mouse.up();
    await expect(article).toHaveURL(/#article$/);
  } finally {
    await context.close();
  }
});

test("記事一覧の対訳と全訳で元のタイトルリンクの書式と操作を保つ", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { article, popup, tabId } = await openTestPage(context);
    const table = article.locator("table");
    const titles = table.locator("td > a.listing-title");
    const originals = await titles.allTextContents();
    const originalHtml = await table.innerHTML();
    const japanese = ["LLMデータをキュレーションするためのツール", "「評価は難しい」はプロダクトの危険信号"];
    const labels = titles.locator('[lang="ja"]');
    const styles = (elements) =>
      elements.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = globalThis.getComputedStyle(node);
          return [
            style.color,
            style.fontFamily,
            style.fontSize,
            style.fontWeight,
            style.lineHeight,
            style.textDecorationLine,
            style.opacity,
          ];
        }),
      );
    await article.emulateMedia({ colorScheme: "dark" });
    const dark = await styles(titles);
    await article.emulateMedia({ colorScheme: "light" });
    const light = await styles(titles);
    expect(light).not.toEqual(dark);
    const rowHeight = (await table.locator("tr").first().boundingBox()).height;
    await titles.first().evaluate((link) =>
      link.addEventListener("click", (event) => {
        event.preventDefault();
        globalThis.document.title = link.hash;
      }),
    );
    const mode = (name) => popup.getByRole("button", { name, exact: true });
    await mode("対訳").click();
    await mode("翻訳").click();
    await expect(labels).toHaveText(japanese);
    await expectMarkerAtTextEnd(context.serviceWorkers()[0], tabId, ["a.listing-title"], false);
    await expect(table.getByRole("link")).toHaveCount(2);
    expect(await styles(labels)).toEqual(light);
    await article.emulateMedia({ colorScheme: "dark" });
    expect(await styles(labels)).toEqual(dark);
    await titles.first().hover();
    await expect(titles.first().getByRole("button")).toHaveCSS("opacity", "1");
    await expect(titles.last().getByRole("button")).toHaveCSS("opacity", "0");
    await article.mouse.move(0, 0);
    await expect(titles.first().getByRole("button")).toHaveCSS("opacity", "0");
    await table.screenshot({ path: testInfo.outputPath("listing-bilingual.png") });

    await mode("全訳").click();
    await expect(titles).toHaveText(japanese, { useInnerText: true });
    expect(await styles(labels)).toEqual(dark);
    expect((await table.locator("tr").first().boundingBox()).height).toBe(rowHeight);
    await table.screenshot({ path: testInfo.outputPath("listing-translated.png") });
    const beforeUpdate = (await translationRequests(context)).length;
    await titles.first().evaluate((link, title) => link.firstChild.replaceWith(title), originals[0]);
    await expect(titles.first()).toHaveText(japanese[0], { useInnerText: true });
    await titles.last().evaluate((link) => link.firstChild.replaceWith("新しい記事"));
    await expect(titles.last()).toHaveText("新しい記事", { useInnerText: true });
    await expect(titles.last().locator("[data-lingo-state]")).toHaveCount(0);
    expect((await translationRequests(context)).length).toBe(beforeUpdate);
    await titles.last().evaluate((link, title) => link.replaceChildren(title), originals[1]);
    await expect(titles.last()).toHaveText(japanese[1], { useInnerText: true });
    const bounds = await labels.first().boundingBox();
    await article.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(article).toHaveTitle("#tools");
    await expect(titles.first()).toHaveCSS("text-decoration-line", "underline");
    await mode("原文").click();
    await expect(titles).toHaveText(originals, { useInnerText: true });
    const restored = await popup.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          type: "setSite",
          hostname: "127.0.0.1",
          enabled: false,
          tabId: id,
        }),
      tabId,
    );
    expect(restored.ok).toBe(true);
    expect(await table.innerHTML()).toBe(originalHtml);
  } finally {
    await context.close();
  }
});

test("原文を選んだタブでリンク移動と再読み込み後も原文を表示する", async ({ playwright }, testInfo) => {
  const context = await launchExtension(playwright.chromium, testInfo);
  try {
    const { article, popup } = await openTestPage(context);
    const mode = (name) => popup.getByRole("button", { name, exact: true });
    const popupUrl = popup.url();
    await popup.getByRole("switch", { name: "このサイトを自動翻訳" }).check();
    const title = article.locator("a.listing-title").last();
    await expect(title.locator('[lang="ja"]')).toBeVisible();
    await mode("原文").click();
    await expect(title.locator('[lang="ja"]')).toBeHidden();
    await popup.goto("about:blank");
    // ポップアップを閉じ、バックグラウンドが再起動する場合もタブの選択を引き継ぐ。
    const devtools = await context.newCDPSession(article);
    await devtools.send("ServiceWorker.enable");
    await devtools.send("ServiceWorker.stopAllWorkers");
    await devtools.detach();
    await title.click();
    await expect(article).toHaveURL(/article\.html#eval$/);
    const translation = article.locator("#first lingo-translation");
    await expect(translation).toHaveCount(1);
    await expect(translation).toBeHidden();
    await article.reload();
    await expect(translation).toHaveCount(1);
    await expect(translation).toBeHidden();
    await popup.goto(popupUrl);
    await expect(mode("原文")).toHaveAttribute("aria-pressed", "true");
    await expect(popup.getByRole("switch")).toBeChecked();
    await article.evaluate(() => globalThis.history.back());
    await expect(article).toHaveURL(/listing\.html$/);
    await expect(title.locator('[lang="ja"]')).toHaveCount(1);
    await expect(title.locator('[lang="ja"]')).toBeHidden();
    await article.evaluate(() => globalThis.history.forward());
    await expect(article).toHaveURL(/article\.html#eval$/);
    await expect(translation).toHaveCount(1);
    await expect(translation).toBeHidden();

    const otherTab = await context.newPage();
    await otherTab.goto(article.url());
    await expect(otherTab.locator("#first lingo-translation")).toBeVisible();
    await mode("対訳").click();
    await expect(translation).toBeVisible();
    await article.evaluate(() => globalThis.history.back());
    await expect(article).toHaveURL(/listing\.html$/);
    await expect(title.locator('[lang="ja"]')).toBeVisible();
    await expect(mode("対訳")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await context.close();
  }
});

for (const automatic of [false, true]) {
  test(`${automatic ? "自動" : "手動"}翻訳でページ内リンクをたどっても原文表示を保ち、追加分だけを翻訳する`, async ({
    playwright,
  }, testInfo) => {
    const context = await launchExtension(playwright.chromium, testInfo);
    try {
      const { article, popup } = await openTestPage(context);
      if (automatic) await popup.getByRole("switch").check();
      else await popup.getByRole("button", { name: "翻訳", exact: true }).click();
      const labels = article.locator("a.listing-title [lang=ja]");
      await expect(labels).toHaveCount(2);
      await popup.getByRole("button", { name: "原文", exact: true }).click();
      await expect(labels.first()).toBeHidden();
      const before = (await translationRequests(context)).length;
      const addParagraph = (text) =>
        article.evaluate((text) => {
          const extra = globalThis.document.createElement("p");
          extra.textContent = text;
          globalThis.document.body.append(extra);
        }, text);
      await context.request.get("http://127.0.0.1:4177/mode/hold-first");
      await addParagraph("A quieter way to read");
      await expect.poll(async () => (await translationRequests(context)).length).toBe(before + 1);
      const link = article.locator("a.listing-title").first();
      await link.evaluate((link) => link.setAttribute("href", "#details"));
      await link.click();
      await expect(article).toHaveURL(/#details$/);
      await context.request.get("http://127.0.0.1:4177/mode/ok");
      const extra = article.locator("p lingo-translation");
      await expect(extra).toHaveCount(1);
      await addParagraph("Ready");
      await expect(extra).toHaveCount(2);
      await expect(extra.first()).toBeHidden();
      await expect(extra.last()).toBeHidden();
      expect((await translationRequests(context)).slice(before).flat()).toEqual(["A quieter way to read", "Ready"]);
      await expect(popup.locator("#translation-count")).toHaveText("4/4");
      await popup.getByRole("button", { name: "設定", exact: true }).click();
      await expect(popup.locator("#usage-total")).toContainText("1ページ");

      // 同じ文書でも記事自体が変わったときは移動前の訳文を消し、タブで選んだ表示を使う。
      await article.evaluate(() => {
        globalThis.history.pushState(null, "", "?next");
        globalThis.document.querySelector("p").replaceChildren("Status");
      });
      if (!automatic) {
        await expect(labels).toHaveCount(0);
        await expect(extra).toHaveCount(0);
        await popup.getByRole("button", { name: "戻る", exact: true }).click();
        await popup.getByRole("button", { name: "翻訳", exact: true }).click();
      }
      await expect(extra.first()).toHaveText("状態");
      await expect(extra.first()).toBeHidden();
    } finally {
      await context.close();
    }
  });
}
