import { readFile, mkdir, copyFile, rm, rename, mkdtemp } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const files = new Set([
  "manifest.json",
  "models.json",
  manifest.options_page,
  manifest.background.service_worker,
  "lib.js",
  "translation-cache.js",
  "content.js",
  "popup.js",
  "popup.css",
  "icons/lingo.svg",
  "icons/lingo-off.svg",
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
]);
await mkdir(".cache", { recursive: true });
const staging = await mkdtemp(".cache/build-");
try {
  for (const file of files) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error(`拡張の外を参照しています: ${file}`);
    const to = join(staging, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(file, to);
  }
  await rm("dist", { recursive: true, force: true });
  await rename(staging, "dist");
  console.log(`dist/ に拡張の ${files.size} ファイルを配置しました。`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
