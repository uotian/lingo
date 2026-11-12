(() => {
  if (globalThis.__lingoLoaded) return;
  globalThis.__lingoLoaded = true;

  const SOURCE_EXCLUDE =
    'script,style,noscript,template,pre,svg,math,canvas,iframe,input,textarea,select,button[form],form,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"],[inert],[translate="no"],.notranslate,lingo-translation';
  const EXCLUDE = SOURCE_EXCLUDE + ",code,kbd,samp";
  const CONTROL = 'button,[role="button"],[role="tab"]';
  const MODES = { original: "原文", bilingual: "対訳", translated: "全訳" };
  const APPLE_GREEN = "#86945f";
  const APPLE_RED = "#c35d59";
  const LINK_ATTRIBUTES = ["target", "rel", "download", "referrerpolicy"];
  const BLOCK = /^(block|list-item|table-cell|table-caption|flow-root|flex|grid)$/;
  const FLEX_OR_GRID = /^(inline-)?(flex|grid)$/;
  const translations = new Map();
  const hiddenOriginals = new WeakSet();
  const markerWhitespace = new WeakMap();
  const pending = new Map();
  let pageMode = "bilingual";
  let modeMenu;
  let progress = { total: 0, skipped: 0, costYen: 0 };
  let runId,
    lastError,
    pageUrl,
    pageLanguage,
    pageTargetLanguage,
    watching = false,
    updateTimer,
    configRevision;
  let skippedSources = new WeakMap();

  function pageAddress() {
    return location.href.split("#", 1)[0];
  }

  function visible(element, includeOriginals = false) {
    if (!element.isConnected) return false;
    let hasLayout = Boolean(element.getClientRects().length);
    if (!hasLayout && !includeOriginals) return false;
    for (let node = element; node; node = node.parentElement) {
      // 全訳でLingoが隠した原文だけは、DOMを変更せずに翻訳対象として照合する。
      if (includeOriginals && hiddenOriginals.has(node)) {
        hasLayout = true;
        continue;
      }
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility !== "visible" ||
        Number(style.opacity) === 0 ||
        style.contentVisibility === "hidden"
      )
        return false;
    }
    return hasLayout;
  }

  function sourceWalker(element, includeOriginals) {
    return document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const parent = node instanceof Element ? node : node.parentElement;
        const control = parent.closest(CONTROL);
        if ((control && control !== element) || parent.closest(SOURCE_EXCLUDE) || !visible(parent, includeOriginals))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  // 同じリンク内では、装飾で分割された文字もひと続きのラベルとして扱う。
  function readTextRuns(walker, withLinks) {
    const parts = [];
    let lastText;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text || node instanceof HTMLBRElement)) continue;
      const text = node instanceof Text ? node.data : "\n";
      if (node instanceof Text && text.trim()) lastText = node;
      const link = withLinks ? node.parentElement?.closest("a[href]") : null;
      const previous = parts.at(-1);
      if (previous && previous.link === link) {
        previous.text += text;
        previous.nodes.push(node);
      } else parts.push({ link, text, nodes: [node] });
    }
    return { parts, lastText };
  }

  function readSource(element, includeOriginals = false) {
    const enclosingLink = element.closest("a[href]");
    const { parts, lastText } = readTextRuns(
      sourceWalker(element, includeOriginals),
      !enclosingLink && !element.closest(CONTROL),
    );
    const normalize = (value) => value.replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n");
    const text = normalize(parts.map((part) => part.text).join("")).trim();
    const labels = parts.filter((part) => part.text.trim());
    // 表のセルや見出しにリンクが1本だけある場合も、既存のリンク内でラベルを翻訳する。
    const labelLink = enclosingLink ?? (labels.length === 1 ? labels[0].link : null);
    const originals = parts.map((part) => (!labelLink && part.link ? part.link : part.nodes)).flat();
    const plain = { text, lastText, originals, labelLink, source: text };
    if (labelLink || !parts.some((part) => part.link)) return plain;

    const paragraph = document.createElement("p");
    const links = new Map();
    for (const part of parts) {
      const label = normalize(part.text);
      const link = part.link;
      if (
        !(link instanceof HTMLAnchorElement) ||
        !label.trim() ||
        !["http:", "https:", "mailto:", "tel:"].includes(link.protocol)
      ) {
        paragraph.append(label);
        continue;
      }
      const ref = "#L" + (links.size + 1);
      const anchor = document.createElement("a");
      anchor.setAttribute("href", ref);
      anchor.textContent = label;
      paragraph.append(anchor);
      const attributes = { href: link.href };
      for (const name of LINK_ATTRIBUTES) {
        if (link.hasAttribute(name)) attributes[name] = link.getAttribute(name);
      }
      links.set(ref, { attributes, element: link });
    }
    if (!links.size) return plain;
    const html = paragraph.outerHTML;
    const targets = Array.from(links.values(), ({ attributes }) => attributes);
    return { ...plain, html, links, source: JSON.stringify([html, ...targets]) };
  }

  function appendLinkedTranslation(words, translation, links) {
    // 応答のHTMLはテンプレート内でだけ読み、ページには文字と原文由来のリンクを組み立てる。
    const template = document.createElement("template");
    template.innerHTML = translation;
    for (const hidden of template.content.querySelectorAll("script,style,noscript,template")) hidden.remove();
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (const { text, link } of readTextRuns(walker, true).parts) {
      const ref = link?.getAttribute("href");
      const original = links.get(ref);
      if (!original) {
        words.append(text);
        continue;
      }
      const anchor = document.createElement("a");
      for (const [name, value] of Object.entries(original.attributes)) anchor.setAttribute(name, value);
      for (const name of ["class", "style"]) {
        if (original.element.hasAttribute(name)) anchor.setAttribute(name, original.element.getAttribute(name));
      }
      anchor.textContent = text;
      words.append(anchor);
      links.delete(ref);
    }
  }

  function matchesLanguage(text, element, language) {
    const declared = element.closest("[lang]")?.getAttribute("lang")?.toLowerCase().split("-")[0];
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (!letters) return false;
    if (language === "ja") {
      return (
        /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) || (declared === "ja" && /\p{Script=Han}/u.test(text))
      );
    }
    if (language === "zh") {
      if (declared === "ja" || /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return false;
      const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
      return han > 0 && (declared === "zh" || han / letters >= 0.5);
    }
    const latin = text.match(/[a-z]/gi)?.length ?? 0;
    return latin / letters >= 0.7 && (!declared || ["en", "ja", "und"].includes(declared));
  }

  function sourceBlocks() {
    const root = document.body;
    if (!root) return [];
    const candidates = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return !node.textContent.trim() || node.parentElement.closest(EXCLUDE) || !visible(node.parentElement)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      let element = walker.currentNode.parentElement;
      const control = element.closest(CONTROL);
      if (control) {
        candidates.add(control);
        continue;
      }
      while (element !== root && element.parentElement) {
        const display = getComputedStyle(element).display;
        if (
          element.localName !== "lingo-marker-group" &&
          (BLOCK.test(display) || (element.matches("a[href]") && display !== "inline"))
        )
          break;
        element = element.parentElement;
      }
      if (element !== document.body) candidates.add(element);
    }
    // 子の段落と親のコンテナを二重に翻訳しない。
    for (const element of candidates) {
      if (element.matches(CONTROL)) continue;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) candidates.delete(parent);
    }
    return [...candidates].filter((element) => visible(element));
  }

  const markerStyles = new CSSStyleSheet();
  markerStyles.replaceSync(`
    lingo-marker { all: unset !important; white-space: nowrap !important; }
    /* 最後の文字とりんごの間で改行しない。コピーする本文には文字を足さない。 */
    lingo-marker::before { content: "\\2060" !important; }
    svg[data-lingo-state] > path { animation: none !important; transition: none !important; }
    @keyframes lingo-pending-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    @media (prefers-reduced-motion: no-preference) {
      svg[data-lingo-state="pending"] > path {
        animation: var(--lingo-marker-pulse, none) 1.6s ease-in-out infinite !important;
      }
    }
    @media (hover: hover) {
      :root, [data-lingo-marker-source] {
        --lingo-marker-opacity: 0;
        --lingo-marker-pulse: none;
      }
      [data-lingo-marker-source]:hover:not(:has([data-lingo-marker-source]:hover)) {
        --lingo-marker-pulse: lingo-pending-pulse;
        /* flex・gridでは訳文が原文の隣にある。 */
        &, & + lingo-translation {
          --lingo-marker-opacity: 1;
        }
      }
      lingo-translation:hover,
      svg[data-lingo-state="done"]:is(:hover, :focus-visible, [aria-expanded="true"]) {
        --lingo-marker-opacity: 1;
      }
      svg[data-lingo-row-hover] {
        --lingo-marker-opacity: 1;
        --lingo-marker-pulse: lingo-pending-pulse;
      }
      lingo-marker:has(> svg[data-lingo-row-hover][data-lingo-state="done"]) {
        position: relative !important;
        z-index: 2147483647 !important;
      }
    }
    @media (hover: none) {
      svg[data-lingo-state="done"] { --lingo-marker-opacity: 1; }
    }
  `);
  document.adoptedStyleSheets.push(markerStyles);

  let rowHoverMarker;
  function setRowHover(marker) {
    if (rowHoverMarker === marker) return;
    rowHoverMarker?.removeAttribute("data-lingo-row-hover");
    rowHoverMarker = marker;
    marker?.setAttribute("data-lingo-row-hover", "");
  }

  // 行全体を覆うリンクはクリックを受け取り続け、直下の本文に対応するりんごだけを手前に出す。
  function hoverThroughRowLink(event) {
    if (event.pointerType === "touch" || !runId) return;
    if (rowHoverMarker?.matches(":hover")) return;
    const link = event.target instanceof Element && event.target.closest("a[href]:empty");
    const row = link && link.closest('tr, [role="row"]');
    if (row && getComputedStyle(link).position === "absolute") {
      for (const hit of document.elementsFromPoint(event.clientX, event.clientY)) {
        if (link.contains(hit) || hit.closest('tr, [role="row"]') !== row) continue;
        const host = hit.closest("lingo-translation");
        const sibling = host && translations.get(host.previousElementSibling);
        const source = hit.closest("[data-lingo-marker-source]");
        const entry = sibling && sibling.node === host ? sibling : translations.get(source);
        const marker = entry?.marker ?? source?.querySelector('svg[data-lingo-state="pending"]');
        if (marker) {
          setRowHover(marker);
          return;
        }
      }
    }
    setRowHover(null);
  }
  document.addEventListener("pointermove", hoverThroughRowLink, { capture: true, passive: true });
  document.addEventListener("pointerover", hoverThroughRowLink, { capture: true, passive: true });
  document.addEventListener(
    "pointerout",
    (event) => {
      if (!event.relatedTarget) setRowHover(null);
    },
    true,
  );

  function createMarker() {
    const ns = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    icon.dataset.lingoState = "pending";
    icon.style.cssText = `
      all: initial !important; display: inline-block !important; width: 14px !important;
      height: 14px !important; margin-inline-start: 3px !important; vertical-align: middle !important;
      flex: none !important; pointer-events: none !important; user-select: none !important;
      opacity: var(--lingo-marker-opacity, 0) !important;
    `;
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      "M8 7.15C6.95 7.15 6.25 5.45 4.85 5.45C3.05 5.45 2.3 7.5 2.4 9.65C2.55 12.5 4.75 15.1 7.1 15.05Q8 14.75 8.9 15.05C11.25 15.1 13.45 12.5 13.6 9.65C13.7 7.5 12.95 5.45 11.15 5.45C9.75 5.45 9.05 7.15 8 7.15Z",
    );
    path.style.cssText = "stroke-width: 1.35 !important; stroke-linejoin: round !important;";
    const leaf = document.createElementNS(ns, "path");
    leaf.setAttribute("d", "M6.75 4.6C6.85 1.45 9.65 .05 13.65 .45C13.1 3.35 10.45 5.25 6.75 4.6Z");
    leaf.style.cssText = "stroke: none !important;";
    icon.append(path, leaf);
    colorMarker(icon, pageMode);
    return icon;
  }

  function colorMarker(marker, mode) {
    const fruit = mode === "original" ? APPLE_GREEN : APPLE_RED;
    marker.firstElementChild.style.setProperty(
      "fill",
      marker.dataset.lingoState === "done" ? fruit : "none",
      "important",
    );
    marker.firstElementChild.style.setProperty("stroke", fruit, "important");
    marker.lastElementChild.style.setProperty("fill", mode === "translated" ? APPLE_RED : APPLE_GREEN, "important");
  }

  function detachMarker(marker) {
    const suffix = marker.parentElement;
    if (suffix?.localName !== "lingo-marker") {
      marker.remove();
      return;
    }
    const group = suffix.parentElement;
    suffix.remove();
    if (group?.localName === "lingo-marker-group") group.replaceWith(...group.childNodes);
    const split = markerWhitespace.get(suffix);
    if (split) {
      if (split.tail.nextSibling === split.space) {
        split.tail.appendData(split.space.data);
        split.space.remove();
      }
      markerWhitespace.delete(suffix);
    }
  }

  function placeMarkerAfter(tail, marker) {
    if (!tail?.parentElement) return;
    const suffix = marker.closest("lingo-marker") ?? document.createElement("lingo-marker");
    if (tail.nextSibling === suffix) return;
    detachMarker(marker);
    if (marker.parentElement !== suffix) suffix.append(marker);
    // HTMLの末尾にある改行や字下げはりんごの後ろに置き、取り外すときに元の文字ノードへ戻す。
    if (tail instanceof Text) {
      const space = /[ \t\r\n\f]+$/.exec(tail.data);
      if (space) markerWhitespace.set(suffix, { tail, space: tail.splitText(space.index) });
    }
    // flex・gridの直下でも文字とりんごを同じ項目に収める。
    if (FLEX_OR_GRID.test(getComputedStyle(tail.parentElement).display)) {
      const group = document.createElement("lingo-marker-group");
      group.style.cssText = "all: unset !important;";
      tail.before(group);
      group.append(tail, suffix);
    } else tail.after(suffix);
  }

  function clearPending() {
    for (const { element, marker } of pending.values()) {
      element.removeAttribute("data-lingo-marker-source");
      detachMarker(marker);
    }
    pending.clear();
  }

  function showOriginals(entry) {
    for (const wrapper of entry.hidden) wrapper.replaceWith(...wrapper.childNodes);
    entry.hidden.length = 0;
  }

  function hideOriginals(entry) {
    for (const node of new Set(entry.originals)) {
      if (!entry.element.contains(node) || hiddenOriginals.has(node.parentNode)) continue;
      const wrapper = document.createElement("span");
      wrapper.style.setProperty("display", "none", "important");
      node.before(wrapper);
      wrapper.append(node);
      hiddenOriginals.add(wrapper);
      entry.hidden.push(wrapper);
    }
  }

  function closeModeMenu(focusMarker = false) {
    if (!modeMenu) return;
    const { host, marker, controller } = modeMenu;
    modeMenu = null;
    controller.abort();
    host.remove();
    marker.setAttribute("aria-expanded", "false");
    if (focusMarker && marker.isConnected) marker.focus({ preventScroll: true });
  }

  function openModeMenu(entry) {
    const { marker, element } = entry;
    const alreadyOpen = modeMenu?.marker === marker;
    closeModeMenu();
    if (alreadyOpen) return;

    const host = document.createElement("lingo-display-menu");
    host.translate = false;
    host.lang = "ja";
    host.style.setProperty("display", "contents", "important");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      [popover] {
        --paper: #fff; --ink: #252927; --line: #dcdedc; --hover: #f2f3f2; --accent: #246b5e; --on-accent: #fff;
        position: fixed; inset: auto; margin: 0; padding: 3px; border: 1px solid var(--line); border-radius: 7px;
        background: var(--paper); color: var(--ink); box-shadow: 0 2px 8px #0003; direction: ltr; writing-mode: horizontal-tb;
        font: 500 13px/1.4 system-ui, sans-serif;
      }
      :popover-open { display: flex; gap: 2px; }
      button { font: inherit; color: inherit; background: transparent; border: 0; border-radius: 4px;
        padding: 5px 10px; min-height: 28px; cursor: pointer; white-space: nowrap; }
      button:hover { background: var(--hover); }
      button[aria-checked="true"] { background: var(--accent); color: var(--on-accent); }
      button:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }
      @media (prefers-color-scheme: dark) { [popover] { --paper: #252725; --ink: #f1f2ef; --line: #484c48;
        --hover: #353935; --accent: #9bcaba; --on-accent: #18382f; } }
      @media (forced-colors: active) { [aria-checked="true"] { border: 2px solid Highlight; } }
    `;
    const menu = document.createElement("div");
    menu.popover = "manual";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "この箇所の表示");
    menu.setAttribute("aria-orientation", "horizontal");
    const choices = Object.entries(MODES).map(([mode, label]) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = label;
      choice.setAttribute("role", "menuitemradio");
      choice.setAttribute("aria-checked", String(mode === entry.mode));
      choice.tabIndex = mode === entry.mode ? 0 : -1;
      choice.addEventListener("click", (event) => {
        event.stopPropagation();
        if (entry.mode !== mode) displayEntry(entry, mode);
        closeModeMenu(true);
      });
      menu.append(choice);
      return choice;
    });
    root.append(style, menu);
    const container =
      element.closest('dialog[open],[popover],nav,[role="menu"]') || document.fullscreenElement || document.body;
    container.append(host);
    const controller = new AbortController();
    const { signal } = controller;
    modeMenu = { host, marker, controller };
    marker.setAttribute("aria-expanded", "true");
    menu.showPopover();
    function positionMenu() {
      if (!marker.isConnected || !marker.getClientRects().length) return closeModeMenu();
      const bounds = marker.getBoundingClientRect();
      const { width, height } = menu.getBoundingClientRect();
      const left = bounds.left + (bounds.width - width) / 2;
      const above = bounds.top - height - 5;
      const top = above >= 3 ? above : bounds.bottom + 5;
      menu.style.left = Math.max(3, Math.min(left, document.documentElement.clientWidth - width - 3)) + "px";
      menu.style.top = Math.max(3, Math.min(top, innerHeight - height - 3)) + "px";
    }
    positionMenu();
    choices.find((choice) => choice.tabIndex === 0).focus({ preventScroll: true });
    menu.addEventListener("keydown", (event) => {
      const index = choices.findIndex((choice) => choice === root.activeElement);
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: choices.length - 1 }[event.key];
      if (next !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        choices[(next + choices.length) % choices.length].focus();
      } else if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
        closeModeMenu(true);
      }
    });
    document.addEventListener(
      "click",
      (event) => {
        if (!event.composedPath().includes(host)) closeModeMenu();
      },
      { signal },
    );
    document.addEventListener("scroll", positionMenu, { capture: true, passive: true, signal });
    window.addEventListener("resize", positionMenu, { signal });
  }

  function displayEntry(entry, mode) {
    const { marker, node, frame, words, separator } = entry;
    showOriginals(entry);
    if (separator) {
      if (mode === "bilingual") words.prepend(separator);
      else separator.remove();
    }
    const control = entry.element.matches(CONTROL);
    const secondary = mode === "bilingual" && (frame || control);
    words.style.setProperty("opacity", secondary ? "0.75" : "1", "important");
    if (frame) {
      frame.style.font =
        mode === "translated"
          ? "inherit"
          : "400 clamp(12px, min(0.75em, 0.25em + 10px), 24px)/1.6 system-ui, sans-serif";
      frame.style.letterSpacing = mode === "translated" ? "inherit" : "normal";
    } else if (control) node.style.setProperty("font-size", mode === "translated" ? "inherit" : "75%", "important");
    placeMarkerAfter(mode === "original" ? entry.lastText : (frame?.firstChild ?? words), marker);
    node.style.setProperty("display", mode === "original" ? "none" : frame ? "block" : "inline", "important");
    if (mode === "translated") hideOriginals(entry);
    entry.mode = mode;
    colorMarker(marker, mode);
    const label = `この箇所の表示を選択（現在は${MODES[mode]}）`;
    marker.setAttribute("aria-label", label);
    marker.setAttribute("title", label);
  }

  function enableMarker(entry) {
    const { marker } = entry;
    marker.dataset.lingoState = "done";
    marker.removeAttribute("aria-hidden");
    marker.setAttribute("role", "button");
    marker.setAttribute("aria-haspopup", "menu");
    marker.setAttribute("aria-expanded", "false");
    marker.setAttribute("tabindex", "0");
    marker.setAttribute("focusable", "true");
    marker.style.cssText +=
      "pointer-events: auto !important; cursor: pointer !important; padding: 3px !important; margin-block: -3px !important; outline: none !important;";
    marker.addEventListener("focus", () => {
      if (marker.matches(":focus-visible")) marker.style.setProperty("outline", "2px solid currentColor", "important");
    });
    marker.addEventListener("blur", () => marker.style.setProperty("outline", "none", "important"));
    marker.addEventListener("pointerdown", () => marker.style.setProperty("outline", "none", "important"));
    const activate = (event) => {
      if (event.type !== "click" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keyup" || event.repeat) return;
      openModeMenu(entry);
    };
    for (const event of ["click", "keydown", "keyup"]) marker.addEventListener(event, activate);
    // サイトのボタンやリンクに対するポインター操作と切り分ける。
    for (const event of ["pointerdown", "pointerup", "mousedown", "mouseup"])
      marker.addEventListener(event, (e) => e.stopPropagation());
  }

  function setPageMode(mode) {
    if (!Object.hasOwn(MODES, mode)) return;
    closeModeMenu();
    pageMode = mode;
    for (const { marker } of pending.values()) colorMarker(marker, mode);
    for (const entry of translations.values()) {
      if (entry.mode !== mode) displayEntry(entry, mode);
    }
  }

  function removeTranslation(entry) {
    if (modeMenu?.marker === entry.marker) closeModeMenu();
    entry.element.removeAttribute("data-lingo-marker-source");
    showOriginals(entry);
    detachMarker(entry.marker);
    entry.node.remove();
    translations.delete(entry.element);
    progress.total--;
  }

  function restoreTranslations() {
    for (const entry of translations.values()) removeTranslation(entry);
    progress = { total: 0, skipped: 0, costYen: 0 };
  }

  function reconcileTranslations() {
    for (const [element, entry] of translations) {
      const current = visible(element) ? readSource(element, true) : null;
      if (!element.isConnected || !entry.node.isConnected || (current && current.source !== entry.source)) {
        removeTranslation(entry);
        continue;
      }
      if (!current) continue;
      entry.originals = current.originals;
      entry.lastText = current.lastText;
      if (entry.mode === "original") placeMarkerAfter(entry.lastText, entry.marker);
      if (entry.mode === "translated" && entry.originals.some((node) => !hiddenOriginals.has(node.parentNode))) {
        showOriginals(entry);
        hideOriginals(entry);
      }
    }
  }

  function restorePage() {
    setRowHover(null);
    clearTimeout(updateTimer);
    updateTimer = undefined;
    watching = false;
    observer.disconnect();
    runId = null;
    lastError = undefined;
    clearPending();
    restoreTranslations();
    pageMode = "bilingual";
  }

  let pageLimits, remaining;

  function invalidate() {
    remaining = undefined;
    if (!watching || updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      if (watching && pageAddress() === pageUrl && remainingWork() === "new")
        chrome.runtime.sendMessage({ type: "pageChanged" }).catch(() => {});
    }, 300);
  }
  const observer = new MutationObserver(invalidate);
  for (const event of [
    "scroll",
    "click",
    "pointerover",
    "pointerout",
    "focusin",
    "focusout",
    "toggle",
    "transitionend",
    "animationend",
  ])
    document.addEventListener(event, invalidate, true);
  window.addEventListener("resize", invalidate);

  function remainingWork() {
    if (!runId || pageAddress() !== pageUrl) return "new";
    if (remaining) return remaining;
    reconcileTranslations();
    remaining = "none";
    for (const element of sourceBlocks()) {
      if (translations.has(element)) continue;
      const { text, source } = readSource(element);
      if (text.length > pageLimits.maxItemChars || !matchesLanguage(text, element, pageLanguage)) continue;
      if (skippedSources.get(element) !== source) {
        remaining = "new";
        break;
      }
      remaining = "skipped";
    }
    return remaining;
  }

  function collect({ runId: id, incremental, revision, hostname, language, targetLanguage, limits, displayMode }) {
    if (hostname !== location.hostname) return null;
    const address = pageAddress();
    const samePage = runId && pageUrl === address && language === pageLanguage && targetLanguage === pageTargetLanguage;
    if (incremental && (!watching || !samePage || configRevision !== revision)) {
      watching = false;
      return { items: [], title: "" };
    }
    watching = false;
    configRevision = revision;
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    pageLimits = limits;
    remaining = undefined;
    if (!incremental) skippedSources = new WeakMap();
    if (!samePage) {
      restoreTranslations();
      pageMode = displayMode ?? "bilingual";
    } else if (displayMode && displayMode !== pageMode) setPageMode(displayMode);
    pageLanguage = language;
    pageTargetLanguage = targetLanguage;
    lastError = undefined;
    runId = id;
    pageUrl = address;
    clearPending();
    reconcileTranslations();
    const items = [];
    let skipped = 0;
    for (const element of sourceBlocks()) {
      if (translations.has(element)) continue;
      const { text, lastText, html, source } = readSource(element);
      if (!matchesLanguage(text, element, language)) continue;
      if (
        text.length > limits.maxItemChars ||
        items.length >= limits.maxItems ||
        skippedSources.get(element) === source
      ) {
        skippedSources.set(element, source);
        skipped++;
        continue;
      }
      const id = items.length;
      const linked = Boolean(html && html.length <= limits.maxBatchChars);
      pending.set(id, { element, source, lastText, linked, marker: createMarker() });
      items.push(linked ? { id, format: "html", text: html } : { id, text });
    }
    for (const { element, lastText, marker } of pending.values()) {
      element.setAttribute("data-lingo-marker-source", "");
      placeMarkerAfter(lastText, marker);
    }
    progress.total = translations.size + items.length;
    progress.skipped = skipped;
    return { items, title: document.title.slice(0, 500), origin: location.origin };
  }

  function insertTranslation(source, translation, original, links) {
    const words = document.createElement("span");
    words.lang = pageTargetLanguage;
    words.translate = false;
    words.style.cssText = "all: unset !important;";
    const cell = source.closest('td, th, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]');
    if (cell) words.style.setProperty("word-break", "break-all", "important");
    const { labelLink, lastText, originals } = original;
    if (labelLink || source.matches(CONTROL)) {
      words.style.setProperty("pointer-events", "none", "important");
      words.style.setProperty("white-space-collapse", "preserve", "important");
      words.textContent = translation;
      let tail = lastText;
      if (labelLink) {
        const first = originals.find((node) => labelLink.contains(node) && node.textContent.trim());
        while (first && !tail.parentElement.contains(first)) tail = tail.parentElement;
      }
      tail.after(words);
      const separateLine = labelLink && labelLink !== source && source.contains(labelLink);
      const separator = separateLine ? document.createElement("br") : document.createTextNode(" ");
      return { node: words, words, frame: null, separator };
    }
    if (links) appendLinkedTranslation(words, translation, links);
    else words.textContent = translation;
    const host = document.createElement("lingo-translation");
    host.lang = pageTargetLanguage;
    host.translate = false;
    host.style.cssText = `
      display: block !important;
      margin: 0.25em 0 0.35em !important;
      padding: 0 !important;
      clear: both !important;
      color: inherit !important;
      text-align: inherit !important;
    `;

    const text = document.createElement("span");
    text.style.cssText = `
      display: block;
      white-space: ${cell ? "inherit" : "pre-wrap"};
      overflow-wrap: anywhere;
    `;
    // 訳文はページ側に置き、リンクにサイトのCSSが適用されるようにする。
    host.append(words);
    text.append(document.createElement("slot"));
    const root = host.attachShadow({ mode: "closed" });
    root.adoptedStyleSheets = [markerStyles];
    root.append(text);

    const style = getComputedStyle(source);
    if (FLEX_OR_GRID.test(style.display)) {
      // レイアウトを崩さず原文の外に置くため、継承できない書式を引き継ぐ。
      const parentStyle = getComputedStyle(source.parentElement);
      for (const property of [
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "line-height",
        "letter-spacing",
        "word-spacing",
        "white-space",
        "text-align",
        "color",
        "opacity",
      ]) {
        const value = style.getPropertyValue(property);
        if (property === "opacity" || value !== parentStyle.getPropertyValue(property))
          host.style.setProperty(property, value, "important");
      }
      source.after(host);
    } else {
      source.append(host);
    }
    return { node: host, words, frame: text };
  }

  let countedPeriod;
  let countedUrl;
  function apply(batch) {
    let inserted = false;
    // 単価・使用量が不明な応答を含む場合は合計額を表示しない。
    progress.costYen = progress.costYen == null || batch.costYen == null ? null : progress.costYen + batch.costYen;
    for (const item of batch.translations) {
      const entry = pending.get(item.id);
      if (!entry) continue;
      pending.delete(item.id);
      const { element, source, marker } = entry;
      detachMarker(marker);
      const currentSource = readSource(element);
      if (!visible(element) || currentSource.source !== source) {
        element.removeAttribute("data-lingo-marker-source");
        continue;
      }
      const view = insertTranslation(element, item.text, currentSource, entry.linked && currentSource.links);
      const translated = {
        ...view,
        element,
        marker,
        source,
        lastText: currentSource.lastText,
        originals: currentSource.originals,
        hidden: [],
        mode: null,
      };
      inserted = true;
      translations.set(element, translated);
      enableMarker(translated);
      displayEntry(translated, pageMode);
    }
    const firstPage = inserted && (countedPeriod !== batch.period || countedUrl !== pageUrl);
    if (firstPage) {
      countedPeriod = batch.period;
      countedUrl = pageUrl;
    }
    return { firstPage };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    switch (message.type) {
      case "collect":
        respond(collect(message));
        break;
      case "current":
      case "apply": {
        const current = message.runId === runId && pageAddress() === pageUrl;
        respond(current && message.type === "apply" ? apply(message) : current);
        break;
      }
      case "finish":
        if (message.runId === runId) {
          clearPending();
          lastError = message.error;
          watching = !message.cancelled && !lastError;
          invalidate();
        }
        respond({});
        break;
      case "displayMode":
        if (runId && pageUrl !== pageAddress()) restorePage();
        if (runId && (!message.resume || message.mode !== pageMode)) setPageMode(message.mode);
        respond({});
        break;
      case "status": {
        const hasRemaining = pending.size > 0 || remainingWork() !== "none";
        respond({
          ...progress,
          hasRemaining,
          error: lastError,
          mode: runId ? pageMode : undefined,
          done: [...translations.values()].filter((entry) => entry.node.isConnected).length,
        });
        break;
      }
      case "restore":
        restorePage();
        respond({});
        break;
    }
  });
})();
