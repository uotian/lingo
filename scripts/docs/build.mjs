import { glob, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { unified } from "unified";
import remarkParse from "remark-parse";

function* walk(node) {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

export async function checkDocumentation(directory) {
  const root = await realpath(directory);
  const pages = [];
  const anchors = new Map();
  const links = [];
  async function target(file, from, url) {
    const path = await realpath(resolve(from, url)).catch(() => {
      throw new Error(`${file}: 参照先がありません: ${url}`);
    });
    if (path !== root && !path.startsWith(root + sep)) throw new Error(`${file}: リポジトリ外を参照しています: ${url}`);
    return path;
  }

  for await (const file of glob(["*.md", "docs/**/*.md", "tests/{RULES,AGENTS}.md"], {
    cwd: root,
    exclude: ["**/_assets/**"],
  })) {
    const path = join(root, file);
    const raw = await readFile(path, "utf8");
    const meta = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(raw);
    const nodes = [
      ...walk(
        unified()
          .use(remarkParse)
          .parse(raw.slice(meta?.[0].length ?? 0)),
      ),
    ];
    const headingText = (node) => [...walk(node)].map((child) => child.value ?? child.alt ?? "").join("");
    const headings = nodes.filter((node) => node.type === "heading");
    const slugger = new GithubSlugger();
    anchors.set(path, new Set(headings.map((node) => slugger.slug(headingText(node)))));
    for (const node of nodes) {
      if (["image", "link", "definition"].includes(node.type)) links.push({ file, path, url: node.url });
    }
    if (!file.startsWith("docs/") || /\/(AGENTS|RULES)\.md$/.test(file)) continue;
    const title = /^title: (.+)$/m.exec(meta?.[1])?.[1];
    const source = /^source: (.+)$/m.exec(meta?.[1])?.[1];
    if (!title || !source || headings[0]?.depth !== 1 || headingText(headings[0]) !== title) {
      throw new Error(`${file}: title・source と先頭のH1を確認してください。`);
    }
    await target(file, root, source);
    const images = nodes.filter((node) => node.type === "image");
    if (images.length !== 1 || !images[0].alt?.trim() || !/^\.\/_assets\/[^/]+\.png$/.test(images[0].url)) {
      throw new Error(`${file}: 説明付きのローカルPNGを1枚指定してください。`);
    }
    const png = await target(file, dirname(path), images[0].url);
    if (!(await readFile(png)).subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
      throw new Error(`${file}: PNG形式を確認してください。`);
    await target(file, dirname(path), images[0].url.replace(/\.png$/, ".prompt.md"));
    pages.push({ file, title, source });
  }
  for (const { file, path, url } of links) {
    if (/^(https?:|mailto:)/i.test(url)) continue;
    const [ref, fragment] = url.split("#");
    const destination = ref ? await target(file, dirname(path), decodeURIComponent(ref)) : path;
    if (fragment && destination.endsWith(".md") && !anchors.get(destination)?.has(decodeURIComponent(fragment))) {
      throw new Error(`${file}: 見出しが見つかりません: ${url}`);
    }
  }
  return pages.sort((a, b) => a.file.localeCompare(b.file));
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const pages = await checkDocumentation(".");
  if (!pages.some((page) => page.file === "docs/index.md")) throw new Error("docs/index.md が必要です。");
  await mkdir(".cache/docs", { recursive: true });
  await writeFile(".cache/docs/index.json", JSON.stringify(pages, null, 2) + "\n");
  console.log(`文書 ${pages.length} ページと規約のローカル参照を確認しました。`);
}
