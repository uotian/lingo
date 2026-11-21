import http from "node:http";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

import { testCatalog } from "../catalog.js";
const catalog = {
  ...testCatalog,
  recommended: "test-fast",
  models: [
    ...testCatalog.models,
    { id: "test-fast", label: "Test Luna", input: 1, cached: 0.1, write: 1.25, output: 2 },
  ],
};
const pages = {
  "/tests/article.html": await readFile(new URL("./article.html", import.meta.url)),
  "/tests/listing.html": await readFile(new URL("./listing.html", import.meta.url)),
  "/tests/table.html": await readFile(new URL("./table.html", import.meta.url)),
};
const translations = {
  "FIELD NOTES · 06 NOVEMBER 2026": "読書のノート · 2026年11月6日",
  "A quieter way to read": "静かに、言葉を読む。",
  "The best tools give us room to think. They help us understand a little more, without getting in the way of the words on the page.":
    "よい道具は、考える余白をくれます。ページの言葉を邪魔せずに、理解を少し深めてくれます。",
  '<p>Read the <a href="#L1">original story</a> &amp; the <a href="#L2">field notes</a> at your own pace. <a href="#L3">↩</a></p>':
    '<p>自分のペースで<a href="#L2" target="_self">読書ノート</a>と<a href="#L1" class="extra">原文</a><a href="https://example.invalid/">を</a>読んでみましょう<a href="#L2">。</a> <a href="#L3">↩</a></p>',
  "Small details, better understanding": "小さな工夫で、理解を深める",
  "Run npm install to get started. Keep your API key private.":
    "まず npm install を実行してください。APIキーは他の人に見せないでください。",
  "Keep the original text.": "原文を残します。",
  "Read the translation below.": "その下の訳文を読みます。",
  Business: "ビジネス向け",
  Personal: "個人向け",
  Plans: "プラン",
  Feature: "機能",
  Status: "状態",
  Translation: "翻訳",
  Ready: "準備完了",
  "Tools for curating LLM Data": "LLMデータをキュレーションするためのツール",
  "“It’s Hard to Eval” Is a Product Smell": "「評価は難しい」はプロダクトの危険信号",
  "Index reference": "DocumentSearchRouterQueryEngineReference",
  "Read the index reference.": "DocumentSearchRouterQueryEngineReferenceの説明を参照してください。",
  "Mina Kato": "Mina Kato",
  "Mar 2024": "2024年3月",
  "请选择套餐。": "プランを選んでください。",
  "請選擇方案。": "プランを選択してください。",
};
let releaseFirstBatch;
let transientFailures = 0;
let mode = "ok",
  requests = [];
http
  .createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const path = req.url.split("?")[0];
    if (path === "/models.json") {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.cookie, undefined);
      res.setHeader("Access-Control-Allow-Origin", "*");
      json(200, catalog);
      return;
    }
    if (Object.hasOwn(pages, path)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pages[path]);
      return;
    }
    if (req.url.startsWith("/mode/")) {
      releaseFirstBatch?.();
      mode = req.url.slice(6);
      transientFailures = mode === "retry-twice" ? 2 : 0;
      json(200, {});
      return;
    }
    if (req.url === "/checks") {
      json(200, { requests });
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(req.headers.authorization, "Bearer lingo-test-key");
      assert.equal(body.store, false);
      assert.ok(!raw.includes("PRIVATE"));
      assert.ok(!raw.includes("DO NOT TRANSLATE"));
      assert.ok(!raw.includes("lingo-test-key"));
      const { items, document_context } = JSON.parse(body.messages[1].content);
      const { source_language, target_language } = document_context;
      const targetName = { en: "English", zh: "Chinese", ja: "Japanese" }[target_language];
      assert.ok(body.messages[0].content.includes("fluently into " + targetName + "."));
      if (source_language !== "ja") assert.ok(!raw.includes("これは日本語の文章"));
      for (const item of items) {
        if (item.text.startsWith("<p>")) assert.equal(item.format, "html");
      }
      if (document_context.source_language === "zh") {
        assert.deepEqual(
          items.map((item) => item.text),
          ["请选择套餐。", "請選擇方案。"],
        );
      } else if (source_language === "ja") {
        assert.deepEqual(
          items.map((item) => item.text),
          ["これは日本語の文章です。APIの設定を確認してください。", "利用料金"],
        );
      } else {
        assert.equal(document_context.source_language, "en");
        assert.ok(!raw.includes("请选择套餐") && !raw.includes("請選擇方案"));
      }
      requests.push(items.map((item) => item.text));
      if (mode === "hold-first" && items.some((item) => item.text === "A quieter way to read")) {
        await new Promise((resolve) => {
          releaseFirstBatch = resolve;
        });
      }
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 2500));
      if (transientFailures > 0) {
        transientFailures--;
        res.setHeader("Retry-After", "1");
        json(503, { error: "Temporarily unavailable" });
        return;
      }
      if (mode === "error") {
        json(401, { error: { message: "SECRET SERVER BODY lingo-test-key" } });
        return;
      }
      const result = items.map(({ id, text }) => ({
        id,
        text:
          target_language === "en"
            ? "English translation"
            : target_language === "zh"
              ? "中文译文"
              : translations[text] || '<img src=x onerror="alert(1)">という文字を含むテスト訳です。',
      }));
      json(200, {
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations: result }) } }],
      });
    } catch {
      json(500, { error: "Mock assertion failed" });
    }
  })
  .listen(4177, "127.0.0.1", () => console.log("Mock API and article: http://127.0.0.1:4177/tests/article.html"));
