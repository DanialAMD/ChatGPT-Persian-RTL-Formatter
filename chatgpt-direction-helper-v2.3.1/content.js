(() => {
  "use strict";

  const STORAGE_KEY = "chatgptRtlHelperSettings";
  const DRAFT_PREFIX = "chatgptRtlDraft:";
  const DEFAULTS = {
    mode: "auto", // auto | rtl | ltr
    showToolbar: true,
    forceCodeLtr: true,
    autoMessageDirection: true,
    perParagraphPrompt: true,
    rememberLastMode: true,
    draftAutosave: true,
    showCounter: true,
    codeCopyButtons: true,
    showTextTools: true,
    focusMode: false,
    fontFamily: "system",
    fontSize: 16,
    chatWidth: 768
  };

  const FONT_STACKS = {
    system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    tahoma: 'Tahoma, Arial, sans-serif',
    vazirmatn: 'Vazirmatn, Vazir, Tahoma, Arial, sans-serif',
    iransans: 'IRANSans, "Iran Sans", Tahoma, Arial, sans-serif'
  };

  let settings = { ...DEFAULTS };
  let toolbar = null;
  let observer = null;
  let lastKnownUrl = location.href;
  let draftTimer = null;
  let currentEditor = null;
  let restoredDraftKey = null;
  let textToolsPanel = null;
  let shortcutsReady = false;
  let delegatedEditorEventsReady = false;
  let mutationFlushTimer = 0;
  let routeRefreshTimer = 0;
  let pendingEditor = null;
  let lastDraftSavedKey = null;
  let lastDraftSavedText = null;

  const EDITOR_SELECTOR = '#prompt-textarea, [contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"].ProseMirror, textarea[placeholder]';
  const MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const messageBlockState = new WeakMap();
  const promptBlockState = new WeakMap();
  const pendingMutationRoots = new Set();
  const pendingMessageRoots = new Set();


  let extensionContextInvalid = false;

  function isExtensionContextAlive() {
    if (extensionContextInvalid) return false;
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime?.id;
    } catch (_) {
      extensionContextInvalid = true;
      return false;
    }
  }

  function handleExtensionApiError(error) {
    const message = String(error?.message || error || "");
    if (message.includes("Extension context invalidated")) {
      extensionContextInvalid = true;
      return true;
    }
    return false;
  }

  function safeStorageGet(area, keys, callback) {
    if (!isExtensionContextAlive()) {
      callback?.({});
      return;
    }
    try {
      chrome.storage[area].get(keys, (result) => {
        try {
          if (chrome.runtime?.lastError) {
            handleExtensionApiError(chrome.runtime.lastError);
            callback?.({});
            return;
          }
          callback?.(result || {});
        } catch (error) {
          handleExtensionApiError(error);
          callback?.({});
        }
      });
    } catch (error) {
      handleExtensionApiError(error);
      callback?.({});
    }
  }

  function safeStorageSet(area, value) {
    if (!isExtensionContextAlive()) return;
    try {
      chrome.storage[area].set(value, () => {
        try {
          if (chrome.runtime?.lastError) handleExtensionApiError(chrome.runtime.lastError);
        } catch (error) {
          handleExtensionApiError(error);
        }
      });
    } catch (error) {
      handleExtensionApiError(error);
    }
  }

  function safeStorageRemove(area, key) {
    if (!isExtensionContextAlive()) return;
    try {
      chrome.storage[area].remove(key, () => {
        try {
          if (chrome.runtime?.lastError) handleExtensionApiError(chrome.runtime.lastError);
        } catch (error) {
          handleExtensionApiError(error);
        }
      });
    } catch (error) {
      handleExtensionApiError(error);
    }
  }

  const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
  const LATIN_RE = /[A-Za-z]/g;
  const STRONG_RE = /[\u0590-\u08FFA-Za-z]/;

  function getDraftKey() {
    return `${DRAFT_PREFIX}${location.pathname || "/"}`;
  }

  function loadSettings(callback) {
    safeStorageGet("sync", [STORAGE_KEY], (result) => {
      settings = { ...DEFAULTS, ...(result[STORAGE_KEY] || {}) };
      normalizeSettings();
      callback?.();
    });
  }

  function normalizeSettings() {
    if (!FONT_STACKS[settings.fontFamily]) settings.fontFamily = DEFAULTS.fontFamily;
    settings.fontSize = clamp(Number(settings.fontSize), 13, 22, DEFAULTS.fontSize);
    settings.chatWidth = clamp(Number(settings.chatWidth), 560, 1200, DEFAULTS.chatWidth);
  }

  function clamp(value, min, max, fallback) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    normalizeSettings();
    safeStorageSet("sync", { [STORAGE_KEY]: settings });
  }

  function isVisibleElement(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function getPromptEditor(preferredTarget = null) {
    // Prefer the actual event/focus target. On hot paths callers pass the editor
    // directly, so we avoid repeated page-wide selectors and layout reads.
    if (preferredTarget instanceof Element) {
      const fromTarget = preferredTarget.closest?.(EDITOR_SELECTOR);
      if (fromTarget) return fromTarget;
    }

    const active = document.activeElement;
    if (active instanceof Element) {
      const fromActive = active.closest?.(EDITOR_SELECTOR);
      if (fromActive) return fromActive;
    }

    if (currentEditor?.isConnected) return currentEditor;

    const candidates = Array.from(document.querySelectorAll(EDITOR_SELECTOR));
    return candidates.find(isVisibleElement) || candidates[0] || null;
  }

  function getEditorText(editor) {
    if (!editor) return "";

    // Avoid innerText in the hot typing path: it can force layout/reflow and cause
    // noticeable lag in React/ProseMirror editors. textContent is much cheaper.
    if ("value" in editor && typeof editor.value === "string") return editor.value;

    const editable = editor.matches?.('[contenteditable="true"]')
      ? editor
      : editor.querySelector?.('[contenteditable="true"]');

    const source = editable || editor;
    if (source.children?.length > 1) {
      return Array.from(source.children)
        .map((child) => child.textContent || "")
        .join("\n");
    }
    return source.textContent ?? "";
  }

  function setEditorText(editor, text) {
    if (!editor || !text) return false;
    if ("value" in editor && typeof editor.value === "string") {
      editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    // Lexical/ContentEditable: insert text through the browser's editing path.
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand?.("insertText", false, text);
    if (!inserted) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return true;
  }


  function replaceEditorText(editor, text) {
    if (!editor) return false;
    if ("value" in editor && typeof editor.value === "string") {
      editor.focus();
      editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand?.("selectAll", false, null) && document.execCommand?.("insertText", false, text);
    if (!ok) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return true;
  }

  function normalizePersianLetters(text) {
    return (text || "")
      .replace(/ي/g, "ی")
      .replace(/ى/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/ۀ/g, "هٔ");
  }

  function addPersianHalfSpaces(text) {
    let out = normalizePersianLetters(text);
    out = out.replace(/(^|[\s\n])((?:ن?می))\s+([\u0600-\u06FF])/g, "$1$2‌$3");
    out = out.replace(/([\u0600-\u06FF])\s+(ها|های|تر|ترین)(?=($|[\s،؛؟!.]))/g, "$1‌$2");
    return out;
  }

  function normalizePersianPunctuation(text) {
    let out = normalizePersianLetters(text);
    out = out.replace(/([\u0600-\u06FF])\s*,\s*(?=[\u0600-\u06FF])/g, "$1، ");
    out = out.replace(/([\u0600-\u06FF])\s*;\s*(?=[\u0600-\u06FF])/g, "$1؛ ");
    out = out.replace(/([\u0600-\u06FF])\s*\?(?=($|\s))/g, "$1؟");
    out = out.replace(/[ \t]+([،؛؟])/g, "$1");
    out = out.replace(/([،؛])(?=\S)/g, "$1 ");
    return out;
  }

  const EN_DIGITS = "0123456789";
  const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
  const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

  function toPersianDigits(text) {
    return (text || "").replace(/[0-9٠-٩]/g, (d) => {
      const i = EN_DIGITS.indexOf(d) >= 0 ? EN_DIGITS.indexOf(d) : AR_DIGITS.indexOf(d);
      return i >= 0 ? FA_DIGITS[i] : d;
    });
  }

  function toEnglishDigits(text) {
    return (text || "").replace(/[۰-۹٠-٩]/g, (d) => {
      let i = FA_DIGITS.indexOf(d);
      if (i < 0) i = AR_DIGITS.indexOf(d);
      return i >= 0 ? EN_DIGITS[i] : d;
    });
  }

  function transformPrompt(transformer) {
    const editor = getPromptEditor();
    if (!editor) return;
    const before = getEditorText(editor);
    if (!before) return;
    const after = transformer(before);
    if (after === before) return;
    replaceEditorText(editor, after);
    applyEditorDirection(editor);
    saveDraft(editor);
  }

  function editorToMarkdown(editor) {
    if (!editor) return "";
    if (editor.tagName === "TEXTAREA") return editor.value || "";
    const blocks = Array.from(editor.childNodes);
    if (!blocks.length) return getEditorText(editor);
    return blocks.map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (!(node instanceof HTMLElement)) return "";
      const text = node.innerText || node.textContent || "";
      if (node.matches("pre")) return `\`\`\`\`\n${text}\n\`\`\``;
      if (node.matches("blockquote")) return text.split("\n").map((x) => `> ${x}`).join("\n");
      if (node.matches("ul, ol")) return text;
      return text;
    }).join("\n");
  }

  async function copyPromptAsMarkdown() {
    const editor = getPromptEditor();
    if (!editor) return false;
    const md = editorToMarkdown(editor);
    if (!md.trim()) return false;
    await navigator.clipboard.writeText(md);
    return true;
  }

  function applyFocusMode() {
    document.body?.classList.toggle("cgrtl-focus-mode", !!settings.focusMode);
    toolbar?.querySelector('[data-action="focus"]')?.classList.toggle("active", !!settings.focusMode);
  }

  function toggleFocusMode() {
    saveSettings({ focusMode: !settings.focusMode });
    applyFocusMode();
  }

  function closeTextTools() {
    if (textToolsPanel) textToolsPanel.hidden = true;
    toolbar?.querySelector('[data-action="tools"]')?.classList.remove("active");
  }

  function createTextToolsPanel() {
    if (textToolsPanel?.isConnected) return textToolsPanel;
    textToolsPanel = document.createElement("div");
    textToolsPanel.className = "cgrtl-text-tools";
    textToolsPanel.hidden = true;
    textToolsPanel.innerHTML = `
      <div class="cgrtl-tools-head"><b>ابزار متن</b><button type="button" data-tool="close" aria-label="Close">×</button></div>
      <div class="cgrtl-tools-grid">
        <button type="button" data-tool="halfspace">نیم‌فاصله</button>
        <button type="button" data-tool="punctuation">علائم فارسی</button>
        <button type="button" data-tool="fa-digits">اعداد فارسی</button>
        <button type="button" data-tool="en-digits">English digits</button>
        <button type="button" data-tool="copy-md" class="wide">Copy as Markdown</button>
      </div>`;

    textToolsPanel.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-tool]");
      if (!btn) return;
      const tool = btn.dataset.tool;
      if (tool === "close") return closeTextTools();
      if (tool === "halfspace") transformPrompt(addPersianHalfSpaces);
      else if (tool === "punctuation") transformPrompt(normalizePersianPunctuation);
      else if (tool === "fa-digits") transformPrompt(toPersianDigits);
      else if (tool === "en-digits") transformPrompt(toEnglishDigits);
      else if (tool === "copy-md") {
        const old = btn.textContent;
        try {
          const ok = await copyPromptAsMarkdown();
          btn.textContent = ok ? "Copied ✓" : "متنی نیست";
        } catch {
          btn.textContent = "Copy failed";
        }
        setTimeout(() => (btn.textContent = old), 1200);
      }
    });

    document.body.appendChild(textToolsPanel);
    return textToolsPanel;
  }

  function toggleTextTools() {
    if (!settings.showTextTools) return;
    const panel = createTextToolsPanel();
    panel.hidden = !panel.hidden;
    toolbar?.querySelector('[data-action="tools"]')?.classList.toggle("active", !panel.hidden);
  }

  function detectDirection(text) {
    const sample = (text || "").trim();
    if (!sample) return "rtl";

    const rtl = (sample.match(RTL_RE) || []).length;
    const latin = (sample.match(LATIN_RE) || []).length;

    if (rtl === latin) {
      const firstStrong = sample.match(STRONG_RE)?.[0] || "";
      return /[\u0590-\u08FF]/.test(firstStrong) ? "rtl" : "ltr";
    }
    return rtl > latin ? "rtl" : "ltr";
  }

  function resolvePromptDirection(editor, knownText = null) {
    if (settings.mode === "rtl" || settings.mode === "ltr") return settings.mode;
    return detectDirection(knownText ?? getEditorText(editor));
  }

  function applyParagraphDirection(editor) {
    if (!editor || !settings.perParagraphPrompt || settings.mode !== "auto") return;
    if (!(editor instanceof HTMLElement) || editor.tagName === "TEXTAREA") return;

    const blocks = Array.from(editor.children).filter((el) => el instanceof HTMLElement);
    for (const block of blocks) {
      const text = (block.textContent || "").trim();
      if (!text) continue;
      const prev = promptBlockState.get(block);
      if (prev?.text === text && block.dataset.rtlHelperPromptBlock === "1") continue;

      const dir = detectDirection(text);
      block.setAttribute("dir", dir);
      block.style.setProperty("direction", dir, "important");
      block.style.setProperty("text-align", dir === "rtl" ? "right" : "left", "important");
      block.dataset.rtlHelperPromptBlock = "1";
      promptBlockState.set(block, { text, dir });
    }
  }

  function clearParagraphOverrides(editor) {
    if (!editor?.querySelectorAll) return;
    editor.querySelectorAll('[data-rtl-helper-prompt-block="1"]').forEach((block) => {
      block.style.removeProperty("direction");
      block.style.removeProperty("text-align");
      block.removeAttribute("dir");
      delete block.dataset.rtlHelperPromptBlock;
    });
  }

  function applyEditorDirection(editor = getPromptEditor()) {
    if (!editor) return;

    const dir = resolvePromptDirection(editor);
    editor.setAttribute("dir", dir);
    editor.style.setProperty("direction", dir, "important");
    editor.style.setProperty("text-align", dir === "rtl" ? "right" : "left", "important");
    editor.dataset.rtlHelperDirection = dir;

    if (settings.mode === "auto" && settings.perParagraphPrompt) applyParagraphDirection(editor);
    else clearParagraphOverrides(editor);

    updateToolbarState(dir);
    updateCounter(editor);
  }

  function elementsIncludingRoot(root, selector) {
    if (!root?.querySelectorAll) return [];
    const items = [];
    if (root instanceof Element && root.matches?.(selector)) items.push(root);
    items.push(...root.querySelectorAll(selector));
    return items;
  }

  function tagChatWidthContainer(anchor) {
    if (!(anchor instanceof Element)) return;
    let el = anchor;
    while (el && el !== document.body) {
      const cls = typeof el.className === "string" ? el.className : "";
      if (cls.includes("mx-auto") && cls.includes("max-w")) {
        el.dataset.cgrtlChatWidth = "1";
        return;
      }
      if (el.tagName === "MAIN") break;
      el = el.parentElement;
    }
  }

  function applyChatWidthTargets(root = document) {
    elementsIncludingRoot(root, MESSAGE_SELECTOR).forEach(tagChatWidthContainer);
    const editor = root === document ? getPromptEditor() : null;
    if (editor) tagChatWidthContainer(editor);
  }

  function isCodeLike(el) {
    return el.matches?.("pre, pre *, code") || !!el.closest?.("pre");
  }

  function applyCodeDirection(root = document) {
    if (!settings.forceCodeLtr) {
      elementsIncludingRoot(root, '[data-rtl-helper-code="1"]').forEach((el) => {
        el.style.removeProperty("direction");
        el.style.removeProperty("text-align");
        el.removeAttribute("dir");
        delete el.dataset.rtlHelperCode;
      });
      return;
    }

    elementsIncludingRoot(root, "pre, pre code").forEach((el) => {
      if (el.dataset.rtlHelperCode === "1") return;
      el.style.setProperty("direction", "ltr", "important");
      el.style.setProperty("text-align", "left", "important");
      el.setAttribute("dir", "ltr");
      el.dataset.rtlHelperCode = "1";
    });
  }

  function addCodeCopyButtons(root = document) {
    if (!settings.codeCopyButtons) {
      root.querySelectorAll?.(".cgrtl-code-copy").forEach((button) => button.remove());
      return;
    }

    elementsIncludingRoot(root, "pre").forEach((pre) => {
      if (pre.querySelector(":scope > .cgrtl-code-copy")) return;
      const code = pre.querySelector("code");
      if (!code) return;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "cgrtl-code-copy";
      button.textContent = "Copy";
      button.title = "Copy code";
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(code.innerText || code.textContent || "");
          button.textContent = "Copied ✓";
          setTimeout(() => (button.textContent = "Copy"), 1200);
        } catch {
          button.textContent = "Failed";
          setTimeout(() => (button.textContent = "Copy"), 1200);
        }
      });
      pre.appendChild(button);
    });
  }

  function applyMessageDirection(root = document) {
    if (!settings.autoMessageDirection) {
      elementsIncludingRoot(root, '[data-rtl-helper-message="1"]').forEach((el) => {
        el.style.removeProperty("direction");
        el.style.removeProperty("text-align");
        el.removeAttribute("dir");
        delete el.dataset.rtlHelperMessage;
        messageBlockState.delete(el);
      });
      return;
    }

    const messages = elementsIncludingRoot(root, MESSAGE_SELECTOR);
    for (const message of messages) {
      tagChatWidthContainer(message);
      const candidates = message.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th");
      for (const el of candidates) {
        if (isCodeLike(el)) continue;
        const text = (el.textContent || "").trim();
        if (!text) continue;

        const previous = messageBlockState.get(el);
        if (previous?.text === text && el.dataset.rtlHelperMessage === "1") continue;

        const dir = detectDirection(text);
        if (previous?.dir !== dir || el.dataset.rtlHelperMessage !== "1") {
          el.setAttribute("dir", dir);
          el.style.setProperty("direction", dir, "important");
          el.style.setProperty("text-align", dir === "rtl" ? "right" : "left", "important");
          el.dataset.rtlHelperMessage = "1";
        }
        messageBlockState.set(el, { text, dir });
      }
    }
  }

  function applyTypography() {
    const font = FONT_STACKS[settings.fontFamily] || FONT_STACKS.system;
    document.documentElement.style.setProperty("--cgrtl-font", font);
    document.documentElement.style.setProperty("--cgrtl-font-size", `${settings.fontSize}px`);
    document.documentElement.style.setProperty("--cgrtl-chat-width", `${settings.chatWidth}px`);
  }

  function injectStyles() {
    if (document.getElementById("chatgpt-rtl-helper-style")) return;
    const style = document.createElement("style");
    style.id = "chatgpt-rtl-helper-style";
    style.textContent = `
      #prompt-textarea,
      [contenteditable="true"][data-lexical-editor="true"],
      [contenteditable="true"].ProseMirror {
        font-family: var(--cgrtl-font) !important;
        font-size: var(--cgrtl-font-size) !important;
      }

      [data-message-author-role="user"],
      [data-message-author-role="assistant"] {
        font-family: var(--cgrtl-font) !important;
        font-size: var(--cgrtl-font-size) !important;
      }

      [data-cgrtl-chat-width="1"] {
        max-width: var(--cgrtl-chat-width, 768px) !important;
      }

      pre { position: relative; }
      .cgrtl-code-copy {
        position: absolute;
        top: 7px;
        right: 7px;
        z-index: 5;
        border: 1px solid rgba(127,127,127,.25);
        border-radius: 8px;
        background: rgba(30,30,30,.72);
        color: white;
        padding: 4px 8px;
        font: 600 11px/1.2 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
        opacity: 0;
        transition: opacity .15s ease, transform .1s ease;
        backdrop-filter: blur(8px);
      }
      pre:hover > .cgrtl-code-copy { opacity: .9; }
      .cgrtl-code-copy:hover { opacity: 1 !important; }
      .cgrtl-code-copy:active { transform: scale(.96); }

      .cgrtl-toolbar {
        position: fixed;
        right: 18px;
        bottom: 110px;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        width: 390px;
        max-width: calc(100vw - 28px);
        gap: 4px;
        padding: 5px;
        border: 1px solid rgba(127,127,127,.22);
        border-radius: 14px;
        background: color-mix(in srgb, Canvas 86%, transparent);
        color: CanvasText;
        box-shadow: 0 10px 30px rgba(0,0,0,.16);
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        user-select: none;
      }
      .cgrtl-toolbar[hidden] { display: none !important; }
      .cgrtl-toolbar button {
        appearance: none;
        border: 0;
        background: transparent;
        color: inherit;
        min-width: 34px;
        height: 30px;
        padding: 0 9px;
        border-radius: 10px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        line-height: 30px;
        transition: background .15s ease, transform .1s ease, opacity .15s ease;
      }
      .cgrtl-toolbar button:hover { background: rgba(127,127,127,.14); }
      .cgrtl-toolbar button:active { transform: scale(.96); }
      .cgrtl-toolbar button.active {
        background: rgba(16,163,127,.17);
        box-shadow: inset 0 0 0 1px rgba(16,163,127,.28);
      }
      .cgrtl-divider {
        width: 1px;
        height: 18px;
        margin: 0 2px;
        background: rgba(127,127,127,.25);
      }
      .cgrtl-status {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        margin: 0 5px 0 4px;
        background: #10a37f;
        box-shadow: 0 0 0 3px rgba(16,163,127,.12);
      }
      .cgrtl-counter {
        direction: ltr;
        order: 50;
        flex: 1 0 100%;
        min-width: 0;
        padding: 5px 4px 1px;
        border-top: 1px solid rgba(127,127,127,.14);
        text-align: center;
        font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        opacity: .68;
        white-space: nowrap;
      }

      .cgrtl-toolbar button.cgrtl-icon-button {
        min-width: 36px;
        font-size: 11px;
      }
      .cgrtl-text-tools {
        position: fixed;
        right: 18px;
        bottom: 140px;
        z-index: 2147483001;
        width: 250px;
        padding: 10px;
        border: 1px solid rgba(127,127,127,.22);
        border-radius: 16px;
        background: color-mix(in srgb, Canvas 92%, transparent);
        color: CanvasText;
        box-shadow: 0 14px 40px rgba(0,0,0,.2);
        backdrop-filter: blur(16px) saturate(145%);
        -webkit-backdrop-filter: blur(16px) saturate(145%);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        direction: rtl;
      }
      .cgrtl-text-tools[hidden] { display: none !important; }
      .cgrtl-tools-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 3px 8px;
        font-size: 12px;
      }
      .cgrtl-tools-head button {
        border: 0;
        background: transparent;
        color: inherit;
        width: 26px;
        height: 26px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 17px;
      }
      .cgrtl-tools-head button:hover { background: rgba(127,127,127,.14); }
      .cgrtl-tools-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 7px;
      }
      .cgrtl-tools-grid button {
        border: 1px solid rgba(127,127,127,.18);
        border-radius: 10px;
        background: rgba(127,127,127,.07);
        color: inherit;
        min-height: 36px;
        padding: 7px 8px;
        cursor: pointer;
        font: 700 11px/1.35 Tahoma, ui-sans-serif, sans-serif;
      }
      .cgrtl-tools-grid button:hover { background: rgba(16,163,127,.12); }
      .cgrtl-tools-grid .wide { grid-column: 1 / -1; direction: ltr; }

      body.cgrtl-focus-mode aside,
      body.cgrtl-focus-mode #stage-slideover-sidebar,
      body.cgrtl-focus-mode [data-testid="sidebar"] {
        display: none !important;
      }
      body.cgrtl-focus-mode main {
        width: 100% !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
      }

      @media (max-width: 720px) {
        .cgrtl-toolbar {
          right: 10px;
          left: auto;
          bottom: 100px;
          width: min(360px, calc(100vw - 20px));
          max-width: calc(100vw - 20px);
          flex-wrap: wrap;
          justify-content: center;
          transform: none;
        }
        .cgrtl-toolbar button {
          min-width: 30px;
          padding-inline: 7px;
        }
        .cgrtl-counter {
          display: block;
          order: 50;
          flex: 1 0 100%;
          min-width: 0;
          padding: 4px 4px 1px;
          text-align: center;
          border-top: 1px solid rgba(127,127,127,.16);
          font-size: 10px;
        }
        .cgrtl-text-tools { right: 10px; bottom: 150px; width: min(250px, calc(100vw - 20px)); }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createToolbar() {
    if (toolbar?.isConnected) return toolbar;

    toolbar = document.createElement("div");
    toolbar.className = "cgrtl-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "ChatGPT text direction");

    const status = document.createElement("span");
    status.className = "cgrtl-status";
    status.title = "RTL/LTR Helper فعال است";
    toolbar.appendChild(status);

    const modes = [
      ["auto", "AUTO", "تشخیص خودکار (Alt+Shift+A)"],
      ["rtl", "RTL", "راست‌به‌چپ (Alt+Shift+R)"],
      ["ltr", "LTR", "چپ‌به‌راست (Alt+Shift+L)"]
    ];

    modes.forEach(([mode, label, title]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.mode = mode;
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", () => setMode(mode));
      toolbar.appendChild(btn);
    });

    const toolsBtn = document.createElement("button");
    toolsBtn.type = "button";
    toolsBtn.dataset.action = "tools";
    toolsBtn.className = "cgrtl-icon-button";
    toolsBtn.textContent = "TOOLS";
    toolsBtn.title = "ابزار متن (Alt+Shift+T)";
    toolsBtn.addEventListener("click", toggleTextTools);
    toolbar.appendChild(toolsBtn);

    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.dataset.action = "focus";
    focusBtn.className = "cgrtl-icon-button";
    focusBtn.textContent = "FOCUS";
    focusBtn.title = "حالت تمرکز (Alt+Shift+F)";
    focusBtn.addEventListener("click", toggleFocusMode);
    toolbar.appendChild(focusBtn);

    const divider = document.createElement("span");
    divider.className = "cgrtl-divider";
    toolbar.appendChild(divider);

    const counter = document.createElement("span");
    counter.className = "cgrtl-counter";
    counter.title = "characters • words • approximate tokens";
    toolbar.appendChild(counter);

    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.textContent = "×";
    hideBtn.title = "مخفی کردن نوار";
    hideBtn.setAttribute("aria-label", "Hide direction toolbar");
    hideBtn.addEventListener("click", () => {
      saveSettings({ showToolbar: false });
      updateToolbarVisibility();
    });
    toolbar.appendChild(hideBtn);

    document.body.appendChild(toolbar);
    updateToolbarVisibility();
    updateToolbarState();
    updateCounter(getPromptEditor());
    return toolbar;
  }

  function updateToolbarVisibility() {
    if (!toolbar) return;
    toolbar.hidden = !settings.showToolbar;
    const toolsBtn = toolbar.querySelector('[data-action="tools"]');
    if (toolsBtn) toolsBtn.hidden = !settings.showTextTools;
    if (!settings.showTextTools) closeTextTools();
  }

  function updateToolbarState(resolvedDirection) {
    if (!toolbar) return;
    toolbar.querySelectorAll("button[data-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === settings.mode);
    });
    const status = toolbar.querySelector(".cgrtl-status");
    if (status) {
      const dir = resolvedDirection || resolvePromptDirection(getPromptEditor());
      status.title = `حالت: ${settings.mode.toUpperCase()} • جهت فعلی: ${dir.toUpperCase()}`;
    }
  }

  function updateCounterFromText(text) {
    if (!toolbar) return;
    const counter = toolbar.querySelector(".cgrtl-counter");
    if (!counter) return;
    counter.hidden = !settings.showCounter;
    if (!settings.showCounter) return;

    const normalized = (text || "").replace(/\u00A0/g, " ");
    const chars = [...normalized].length;
    const words = (normalized.trim().match(/\S+/gu) || []).length;
    const tokens = normalized ? Math.max(1, Math.ceil(chars / 4)) : 0;
    counter.textContent = `${chars}c · ${words}w · ~${tokens}t`;
  }

  function updateCounter(editor = getPromptEditor()) {
    updateCounterFromText(getEditorText(editor));
  }

  let editorRefreshFrame = 0;
  let paragraphRefreshTimer = 0;

  function scheduleEditorRefresh(editor) {
    if (!editor?.isConnected) return;
    currentEditor = editor;
    pendingEditor = editor;
    saveDraft(editor);

    // One DOM read + one UI update per animation frame. The old implementation
    // read the whole prompt separately for the counter and for direction.
    if (editorRefreshFrame) return;
    editorRefreshFrame = requestAnimationFrame(() => {
      editorRefreshFrame = 0;
      const target = pendingEditor?.isConnected ? pendingEditor : getPromptEditor();
      pendingEditor = null;
      if (!target) return;

      const text = getEditorText(target);
      updateCounterFromText(text);

      const dir = resolvePromptDirection(target, text);
      if (target.dataset.rtlHelperDirection !== dir) {
        target.setAttribute("dir", dir);
        target.style.setProperty("direction", dir, "important");
        target.style.setProperty("text-align", dir === "rtl" ? "right" : "left", "important");
        target.dataset.rtlHelperDirection = dir;
      }
      updateToolbarState(dir);

      clearTimeout(paragraphRefreshTimer);
      paragraphRefreshTimer = setTimeout(() => {
        if (!target.isConnected) return;
        if (settings.mode === "auto" && settings.perParagraphPrompt) applyParagraphDirection(target);
        else clearParagraphOverrides(target);
      }, 220);
    });
  }

  function setMode(mode) {
    if (!["auto", "rtl", "ltr"].includes(mode)) return;
    if (settings.rememberLastMode) saveSettings({ mode });
    else settings.mode = mode;
    applyEditorDirection();
    updateToolbarState();
  }

  function saveDraft(editor) {
    if (!settings.draftAutosave || !editor) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (!editor.isConnected) return;
      const key = getDraftKey();
      const text = getEditorText(editor);
      if (key === lastDraftSavedKey && text === lastDraftSavedText) return;

      lastDraftSavedKey = key;
      lastDraftSavedText = text;
      if (text.trim()) {
        safeStorageSet("local", { [key]: { text, savedAt: Date.now() } });
      } else {
        safeStorageRemove("local", key);
      }
    }, 900);
  }

  function restoreDraft(editor) {
    if (!settings.draftAutosave || !editor) return;
    const key = getDraftKey();
    if (restoredDraftKey === key) return;
    restoredDraftKey = key;
    if (getEditorText(editor).trim()) return;

    safeStorageGet("local", [key], (result) => {
      const draft = result[key];
      if (!draft?.text || getEditorText(editor).trim()) return;
      setEditorText(editor, draft.text);
      setTimeout(() => {
        applyEditorDirection(editor);
        updateCounter(editor);
      }, 0);
    });
  }

  function bindEditor(editor) {
    if (!editor) return;
    currentEditor = editor;
    tagChatWidthContainer(editor);

    if (editor.dataset.rtlHelperBound !== "1") {
      editor.dataset.rtlHelperBound = "1";
      applyEditorDirection(editor);
    } else {
      updateCounter(editor);
    }
    restoreDraft(editor);
  }

  function applyAll(root = document) {
    injectStyles();
    applyTypography();
    createToolbar();
    createTextToolsPanel();
    updateToolbarVisibility();
    applyFocusMode();

    const editor = getPromptEditor();
    if (editor) bindEditor(editor);
    applyEditorDirection(editor);
    applyChatWidthTargets(root);
    applyCodeDirection(root);
    addCodeCopyButtons(root);
    applyMessageDirection(root);
  }

  function queueMutationRoot(el) {
    if (!(el instanceof Element)) return;
    if (el.closest?.(".cgrtl-toolbar, .cgrtl-text-tools")) return;

    // Keep only top-most roots so nested React insertions are not rescanned.
    for (const existing of pendingMutationRoots) {
      if (existing === el || existing.contains(el)) return;
      if (el.contains(existing)) pendingMutationRoots.delete(existing);
    }
    pendingMutationRoots.add(el);
  }

  function scheduleMutationFlush() {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = setTimeout(flushMutations, 180);
  }

  function flushMutations() {
    mutationFlushTimer = 0;
    const roots = Array.from(pendingMutationRoots);
    const messages = Array.from(pendingMessageRoots);
    pendingMutationRoots.clear();
    pendingMessageRoots.clear();

    // Resolve/bind the composer once per batch instead of once per mutation.
    if (!currentEditor?.isConnected) {
      const editor = getPromptEditor();
      if (editor) bindEditor(editor);
    }

    for (const root of roots) {
      if (!root.isConnected) continue;

      const editor = root.matches?.(EDITOR_SELECTOR) ? root : root.querySelector?.(EDITOR_SELECTOR);
      if (editor) bindEditor(editor);

      if (root.matches?.("pre, code") || root.querySelector?.("pre, code")) {
        applyCodeDirection(root);
        addCodeCopyButtons(root);
      }

      if (root.matches?.(MESSAGE_SELECTOR) || root.querySelector?.(MESSAGE_SELECTOR)) {
        applyMessageDirection(root);
        applyChatWidthTargets(root);
      }
    }

    for (const message of messages) {
      if (!message.isConnected) continue;
      applyMessageDirection(message);
      tagChatWidthContainer(message);
      if (message.querySelector?.("pre, code")) {
        applyCodeDirection(message);
        addCodeCopyButtons(message);
      }
    }
  }

  function onMutations(mutations) {
    let hasRelevantMutation = false;

    for (const mutation of mutations) {
      if (mutation.type !== "childList" || !mutation.addedNodes.length) continue;

      // Input changes are handled by delegated input events, not MutationObserver.
      if (currentEditor?.isConnected && currentEditor.contains(mutation.target)) continue;

      const targetEl = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const parentMessage = targetEl?.closest?.(MESSAGE_SELECTOR);
      if (parentMessage) {
        pendingMessageRoots.add(parentMessage);
        hasRelevantMutation = true;
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node;
        // Ignore unrelated UI insertions (menus, side panels, Work outputs, etc.).
        if (
          el.matches?.(`${EDITOR_SELECTOR}, ${MESSAGE_SELECTOR}, pre, code`) ||
          el.querySelector?.(`${EDITOR_SELECTOR}, ${MESSAGE_SELECTOR}, pre, code`)
        ) {
          queueMutationRoot(el);
          hasRelevantMutation = true;
        }
      }
    }

    if (hasRelevantMutation) scheduleMutationFlush();

    if (location.href !== lastKnownUrl) {
      lastKnownUrl = location.href;
      restoredDraftKey = null;
      lastDraftSavedKey = null;
      clearTimeout(routeRefreshTimer);
      routeRefreshTimer = setTimeout(() => applyAll(), 160);
    }
  }

  function setupObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setupCounterFallback() {
    if (delegatedEditorEventsReady) return;
    delegatedEditorEventsReady = true;

    const handle = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const editor = target.closest?.(EDITOR_SELECTOR);
      if (!editor) return;
      if (editor !== currentEditor) bindEditor(editor);
      scheduleEditorRefresh(editor);
    };

    // One delegated event path survives React/ProseMirror node replacement and
    // avoids attaching duplicate listeners to every composer instance.
    document.addEventListener("input", handle, true);
    document.addEventListener("compositionend", handle, true);
    document.addEventListener("focusin", handle, true);
    document.addEventListener("paste", (event) => setTimeout(() => handle(event), 0), true);
  }

  function setupShortcuts() {
    if (shortcutsReady) return;
    shortcutsReady = true;
    document.addEventListener("keydown", (event) => {
      if (!(event.altKey && event.shiftKey)) return;
      const key = event.key.toLowerCase();
      if (key === "a") {
        event.preventDefault();
        setMode("auto");
      } else if (key === "r") {
        event.preventDefault();
        setMode("rtl");
      } else if (key === "l") {
        event.preventDefault();
        setMode("ltr");
      } else if (key === "t") {
        event.preventDefault();
        toggleTextTools();
      } else if (key === "f") {
        event.preventDefault();
        toggleFocusMode();
      }
    }, true);
  }

  if (isExtensionContextAlive()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes[STORAGE_KEY]) {
          settings = { ...DEFAULTS, ...(changes[STORAGE_KEY].newValue || {}) };
          normalizeSettings();
          applyAll();
        }
      });
    } catch (error) {
      handleExtensionApiError(error);
    }
  }

  function init() {
    loadSettings(() => {
      // Do not inject width/font overrides until persisted settings are loaded.
      // This removes the wide/broken first paint that previously required
      // touching the popup sliders before the layout became correct.
      applyAll();
      setupObserver();
      setupCounterFallback();
      setupShortcuts();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
