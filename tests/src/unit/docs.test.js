import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocumentation } from "../../../scripts/docs/build.mjs";

test("文書の実在する根拠・画像・見出しだけを受け入れる", async () => {
  const root = await mkdtemp(join(tmpdir(), "lingo-docs-"));
  try {
    const write = (path, value) => writeFile(join(root, path), value);
    await mkdir(join(root, "docs/_assets"), { recursive: true });
    await write(
      "docs/_assets/index.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nK8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await write("docs/_assets/index.prompt.md", "再現用");
    await write("docs/index.md", "---\ntitle: Lingo\nsource: .\n---\n# Lingo\n\n![図](./_assets/index.png)\n");
    await write("README.md", "[設計](./docs/index.md#lingo)");
    expect(await checkDocumentation(root)).toEqual([{ file: "docs/index.md", title: "Lingo", source: "." }]);
    await write("README.md", "[設計](./docs/index.md#missing)");
    await expect(checkDocumentation(root)).rejects.toThrow("見出し");
    await write("README.md", "[ファイル](./missing.md)");
    await expect(checkDocumentation(root)).rejects.toThrow("参照先");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
