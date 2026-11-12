import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig([
  globalIgnores([
    ".cache/**",
    "dist/**",
    "output/**",
    ".playwright-cli/**",
    "tests/results/**",
    "playwright-report/**",
  ]),
  js.configs.recommended,
  { files: ["*.js"], languageOptions: { globals: { ...globals.browser, chrome: "readonly" } } },
  {
    files: ["popup.js", "content.js"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "chrome", property: "storage", message: "設定はbackgroundのメッセージ経由で扱う。" },
      ],
    },
  },
  {
    files: ["popup.js", "content.js", "background.js"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "翻訳の通信はlib.jsのtranslateBatchに集約する。" }],
    },
  },
  { files: ["background.js"], languageOptions: { globals: globals.serviceworker } },
  { files: ["**/*.mjs", "tests/**/*.js"], languageOptions: { globals: globals.node } },
  { files: ["tests/src/e2e/*.spec.js"], languageOptions: { globals: { chrome: "readonly" } } },
]);
