(function initMarkdownRenderer(root, factory) {
  root.WebMarkdownRenderer = factory(root.marked);
})(globalThis, function createMarkdownRenderer(Markdown) {
  "use strict";

  const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:"]);
  const MAX_RENDER_DEPTH = 64;
  const ZERO_WIDTH_PREFIX = /^[\u200B\u200C\u200D\u200E\u200F\uFEFF]+/u;

  function normalizeSource(value) {
    return String(value || "").replace(ZERO_WIDTH_PREFIX, "");
  }

  function decodeMarkdownText(value, document) {
    const source = String(value || "");
    if (!source.includes("&")) {
      return source;
    }
    const DOMParserConstructor = document?.defaultView?.DOMParser || globalThis.DOMParser;
    if (typeof DOMParserConstructor !== "function") {
      return source;
    }
    try {
      const escapedAngles = source
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      const parsed = new DOMParserConstructor().parseFromString(
        `<!doctype html><body>${escapedAngles}`,
        "text/html"
      );
      return parsed.body?.textContent ?? source;
    } catch {
      return source;
    }
  }

  function normalizeBaseUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) {
        return "";
      }
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {
      return "";
    }
  }

  function safeLinkHref(value, baseUrl = "", document = null) {
    const source = decodeMarkdownText(value, document).trim();
    if (!source) {
      return "";
    }
    try {
      const normalizedBase = normalizeBaseUrl(baseUrl);
      const url = normalizedBase ? new URL(source, normalizedBase) : new URL(source);
      if (!SAFE_LINK_PROTOCOLS.has(url.protocol) || url.username || url.password) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function appendText(parent, value) {
    parent.append(parent.ownerDocument.createTextNode(
      decodeMarkdownText(value, parent.ownerDocument)
    ));
  }

  function appendInlineTokens(parent, tokens, context, depth = 0) {
    if (!Array.isArray(tokens) || depth > MAX_RENDER_DEPTH) {
      return;
    }

    for (const token of tokens) {
      if (!token || typeof token !== "object") {
        continue;
      }
      switch (token.type) {
        case "text":
        case "escape":
          if (Array.isArray(token.tokens) && token.tokens.length) {
            appendInlineTokens(parent, token.tokens, context, depth + 1);
          } else {
            appendText(parent, token.text ?? token.raw);
          }
          break;
        case "strong":
        case "em":
        case "del": {
          const element = context.document.createElement(token.type);
          appendInlineTokens(element, token.tokens, context, depth + 1);
          parent.append(element);
          break;
        }
        case "codespan": {
          const code = context.document.createElement("code");
          code.className = "markdown-inline-code";
          code.textContent = String(token.text || "");
          parent.append(code);
          break;
        }
        case "br":
          parent.append(context.document.createElement("br"));
          break;
        case "link": {
          const href = safeLinkHref(token.href, context.baseUrl, context.document);
          const target = href
            ? context.document.createElement("a")
            : context.document.createElement("span");
          if (href) {
            target.href = href;
            target.target = "_blank";
            target.rel = "noopener noreferrer";
            if (token.title) {
              target.title = decodeMarkdownText(token.title, context.document).slice(0, 240);
            }
          } else {
            target.className = "markdown-unsafe-link";
          }
          appendInlineTokens(target, token.tokens, context, depth + 1);
          parent.append(target);
          break;
        }
        case "image": {
          const href = safeLinkHref(token.href, context.baseUrl, context.document);
          const label = decodeMarkdownText(
            token.text || token.title || token.href || "",
            context.document
          ).trim();
          const target = href
            ? context.document.createElement("a")
            : context.document.createElement("span");
          target.className = href ? "markdown-image-link" : "markdown-image-link unavailable";
          if (href) {
            target.href = href;
            target.target = "_blank";
            target.rel = "noopener noreferrer";
          }
          target.textContent = label;
          parent.append(target);
          break;
        }
        case "html": {
          const code = context.document.createElement("code");
          code.className = "markdown-raw-html";
          code.textContent = String(token.raw || token.text || "");
          parent.append(code);
          break;
        }
        default:
          if (Array.isArray(token.tokens) && token.tokens.length) {
            appendInlineTokens(parent, token.tokens, context, depth + 1);
          } else {
            appendText(parent, token.text ?? token.raw);
          }
      }
    }
  }

  function appendParagraph(parent, token, context, depth) {
    const paragraph = context.document.createElement("p");
    if (Array.isArray(token.tokens)) {
      appendInlineTokens(paragraph, token.tokens, context, depth + 1);
    } else {
      appendText(paragraph, token.text ?? token.raw);
    }
    parent.append(paragraph);
  }

  function appendCodeBlock(parent, token, context) {
    const shell = context.document.createElement("div");
    shell.className = "markdown-code-shell";
    const language = String(token.lang || "").trim().match(/^[\w.+#-]{1,40}/u)?.[0] || "";
    if (language) {
      const label = context.document.createElement("div");
      label.className = "markdown-code-language";
      label.textContent = language;
      shell.append(label);
    }
    const pre = context.document.createElement("pre");
    pre.tabIndex = 0;
    const code = context.document.createElement("code");
    code.textContent = String(token.text || "");
    pre.append(code);
    shell.append(pre);
    parent.append(shell);
  }

  function appendList(parent, token, context, depth) {
    const list = context.document.createElement(token.ordered ? "ol" : "ul");
    if (token.ordered) {
      const start = Number(token.start);
      if (Number.isInteger(start) && start > 0) {
        list.start = start;
      }
    }
    if ((token.items || []).some((item) => item?.task)) {
      list.classList.add("markdown-task-list");
    }

    for (const item of token.items || []) {
      const listItem = context.document.createElement("li");
      if (item?.task) {
        listItem.className = "markdown-task-list-item";
        const checkbox = context.document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(item.checked);
        checkbox.disabled = true;
        checkbox.tabIndex = -1;
        const taskLabel = decodeMarkdownText(item.text, context.document).trim().slice(0, 240);
        if (taskLabel) {
          checkbox.setAttribute("aria-label", taskLabel);
        }
        const content = context.document.createElement("div");
        content.className = "markdown-task-content";
        appendBlockTokens(content, item.tokens, context, depth + 1);
        listItem.append(checkbox, content);
      } else {
        appendBlockTokens(listItem, item?.tokens, context, depth + 1);
      }
      list.append(listItem);
    }
    parent.append(list);
  }

  function appendTable(parent, token, context, depth) {
    const wrapper = context.document.createElement("div");
    wrapper.className = "markdown-table-scroll";
    wrapper.tabIndex = 0;

    const headerLabel = (token.header || [])
      .map((cell) => decodeMarkdownText(cell?.text, context.document).trim())
      .filter(Boolean)
      .join(" / ")
      .slice(0, 240);
    if (headerLabel) {
      wrapper.setAttribute("role", "region");
      wrapper.setAttribute("aria-label", headerLabel);
    }

    const table = context.document.createElement("table");
    const head = context.document.createElement("thead");
    const headRow = context.document.createElement("tr");
    for (const [index, cell] of (token.header || []).entries()) {
      const heading = context.document.createElement("th");
      heading.scope = "col";
      applyTableAlignment(heading, cell?.align ?? token.align?.[index]);
      appendInlineTokens(heading, cell?.tokens || [], context, depth + 1);
      headRow.append(heading);
    }
    head.append(headRow);
    table.append(head);

    const body = context.document.createElement("tbody");
    for (const row of token.rows || []) {
      const tableRow = context.document.createElement("tr");
      for (const [index, cell] of row.entries()) {
        const data = context.document.createElement("td");
        applyTableAlignment(data, cell?.align ?? token.align?.[index]);
        appendInlineTokens(data, cell?.tokens || [], context, depth + 1);
        tableRow.append(data);
      }
      body.append(tableRow);
    }
    table.append(body);
    wrapper.append(table);
    parent.append(wrapper);
  }

  function applyTableAlignment(cell, value) {
    const alignment = String(value || "").toLowerCase();
    if (["left", "center", "right"].includes(alignment)) {
      cell.classList.add(`align-${alignment}`);
    }
  }

  function appendBlockTokens(parent, tokens, context, depth = 0) {
    if (!Array.isArray(tokens) || depth > MAX_RENDER_DEPTH) {
      return;
    }

    for (const token of tokens) {
      if (!token || typeof token !== "object" || token.type === "space" || token.type === "def") {
        continue;
      }
      switch (token.type) {
        case "checkbox":
          break;
        case "heading": {
          const level = Math.min(6, Math.max(1, Number(token.depth) || 1));
          const heading = context.document.createElement(`h${level}`);
          appendInlineTokens(heading, token.tokens, context, depth + 1);
          parent.append(heading);
          break;
        }
        case "paragraph":
        case "text":
          appendParagraph(parent, token, context, depth);
          break;
        case "code":
          appendCodeBlock(parent, token, context);
          break;
        case "blockquote": {
          const quote = context.document.createElement("blockquote");
          appendBlockTokens(quote, token.tokens, context, depth + 1);
          parent.append(quote);
          break;
        }
        case "list":
          appendList(parent, token, context, depth);
          break;
        case "table":
          appendTable(parent, token, context, depth);
          break;
        case "hr":
          parent.append(context.document.createElement("hr"));
          break;
        case "html": {
          const raw = context.document.createElement("pre");
          raw.className = "markdown-raw-html-block";
          raw.tabIndex = 0;
          raw.textContent = String(token.raw || token.text || "");
          parent.append(raw);
          break;
        }
        default:
          if (Array.isArray(token.tokens) && token.tokens.length) {
            appendBlockTokens(parent, token.tokens, context, depth + 1);
          } else if (token.text || token.raw) {
            appendParagraph(parent, token, context, depth);
          }
      }
    }
  }

  function render(container, value, options = {}) {
    if (!container?.ownerDocument || typeof Markdown?.lexer !== "function") {
      return false;
    }
    const source = normalizeSource(value);
    const context = {
      document: container.ownerDocument,
      baseUrl: normalizeBaseUrl(options.baseUrl)
    };
    try {
      const tokens = Markdown.lexer(source, {
        gfm: true,
        breaks: true
      });
      const fragment = context.document.createDocumentFragment();
      appendBlockTokens(fragment, tokens, context);
      container.replaceChildren(fragment);
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    isAvailable: () => typeof Markdown?.lexer === "function",
    render,
    safeLinkHref
  });
});
