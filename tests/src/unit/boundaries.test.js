import { ESLint } from "eslint";
import { expect, test } from "vitest";

test("ページ側の保存領域への直接アクセスとAPI呼び出しを拒否し、担当側では許可する", async () => {
  const lint = new ESLint();
  async function rules(filePath, source) {
    const [result] = await lint.lintText(source, { filePath });
    return result.messages.map((message) => message.ruleId);
  }
  for (const file of ["popup.js", "content.js"]) {
    expect(await rules(file, 'chrome.storage.local.get("settings"); fetch("/");')).toEqual([
      "no-restricted-properties",
      "no-restricted-globals",
    ]);
    expect(await rules(file, 'chrome.runtime.sendMessage({type:"status"});')).toEqual([]);
  }
  expect(await rules("background.js", 'chrome.storage.local.get("settings");')).toEqual([]);
  expect(await rules("lib.js", 'fetch("/");')).toEqual([]);
});
