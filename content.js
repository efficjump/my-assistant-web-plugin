(() => {
if (globalThis.__myAssistantWebPluginLoaded) {
  return;
}
globalThis.__myAssistantWebPluginLoaded = true;

const assistantPageState = {
  elementsByRef: new Map(),
  picker: null,
  domRevision: 0,
  documentId: createDocumentId(),
  scopes: [],
  observedRoots: new WeakSet(),
  mutationObservers: []
};

observePageMutations();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleContentMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: serializeContentError(error) }));
  return true;
});

async function handleContentMessage(message) {
  switch (message?.type) {
    case "PING":
      return { ready: true };
    case "COLLECT_PAGE_CONTEXT":
      return collectPageContext(message.options || {});
    case "EXECUTE_PAGE_ACTIONS":
      return executePageActions(message.actions || []);
    case "UNDO_PAGE_ACTIONS":
      return undoPageActions(message.undoActions || []);
    case "START_ELEMENT_PICKER":
      return startElementPicker();
    default:
      throw new Error(`Unknown content message type: ${message?.type || "missing"}`);
  }
}

function collectPageContext(options) {
  assistantPageState.elementsByRef.clear();
  assistantPageState.scopes = collectDomScopes();
  observeDomScopes(assistantPageState.scopes);

  const maxTextChars = clampNumber(options.maxTextChars, 4000, 50000, 16000);
  const maxElements = clampNumber(options.maxElements, 20, 180, 80);
  const redactSensitiveData = options.redactSensitiveData !== false;
  const interactiveElements = collectInteractiveElements(maxElements, redactSensitiveData);
  const visibleText = redactSensitiveData
    ? redactSensitiveText(collectVisibleText(maxTextChars))
    : collectVisibleText(maxTextChars);
  const documentTextExcerpt = redactSensitiveData
    ? redactSensitiveText(normalizeWhitespace(document.body?.innerText || "").slice(0, maxTextChars))
    : normalizeWhitespace(document.body?.innerText || "").slice(0, maxTextChars);

  return {
    documentId: assistantPageState.documentId,
    url: sanitizeUrlForContext(location.href, redactSensitiveData),
    title: redactSensitiveData ? redactSensitiveText(document.title) : document.title,
    language: document.documentElement.lang || "",
    timestamp: new Date().toISOString(),
    pageState: collectPageState(redactSensitiveData),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      devicePixelRatio: window.devicePixelRatio || 1
    },
    selection: redactSensitiveData ? redactSensitiveText(getSelectionText()) : getSelectionText(),
    visibleText,
    documentTextExcerpt,
    headings: collectHeadings(24, redactSensitiveData),
    landmarks: collectLandmarks(24, redactSensitiveData),
    forms: collectForms(12, redactSensitiveData),
    tables: collectTables(10, redactSensitiveData),
    iframes: collectIframes(12, redactSensitiveData),
    liveRegions: collectLiveRegions(20, redactSensitiveData),
    domScopes: assistantPageState.scopes.map((scope) => ({
      id: scope.id,
      kind: scope.kind,
      parentId: scope.parentId || "",
      sameOrigin: scope.sameOrigin !== false
    })),
    interactiveElements
  };
}

function createDocumentId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const entropy = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).join("-")
    : `${Date.now()}-${Math.random()}`;
  return `document-${entropy}`;
}

function collectDomScopes() {
  const scopes = [];
  const seenRoots = new Set();

  const visit = (root, descriptor) => {
    if (!root || seenRoots.has(root) || typeof root.querySelectorAll !== "function") {
      return;
    }
    seenRoots.add(root);
    const scope = {
      root,
      id: descriptor.id,
      kind: descriptor.kind,
      parentId: descriptor.parentId || "",
      sameOrigin: descriptor.sameOrigin !== false
    };
    scopes.push(scope);

    const elements = Array.from(root.querySelectorAll("*"));
    let shadowIndex = 0;
    let frameIndex = 0;
    for (const element of elements) {
      if (element.shadowRoot) {
        shadowIndex += 1;
        visit(element.shadowRoot, {
          id: `${scope.id}/shadow-${shadowIndex}`,
          kind: "shadow-root",
          parentId: scope.id
        });
      }
      if (element.tagName?.toLowerCase() === "iframe") {
        frameIndex += 1;
        try {
          const frameDocument = element.contentDocument;
          if (frameDocument?.documentElement) {
            visit(frameDocument, {
              id: `${scope.id}/frame-${frameIndex}`,
              kind: "iframe",
              parentId: scope.id,
              sameOrigin: true
            });
          }
        } catch {
          // Cross-origin frames remain metadata-only and are never traversed.
        }
      }
    }
  };

  visit(document, { id: "top", kind: "document", sameOrigin: true });
  return scopes;
}

function getDomScopes() {
  return assistantPageState.scopes.length ? assistantPageState.scopes : collectDomScopes();
}

function queryAllDom(selector) {
  const results = [];
  const seen = new Set();
  for (const scope of getDomScopes()) {
    for (const element of Array.from(scope.root.querySelectorAll(selector))) {
      if (!seen.has(element)) {
        seen.add(element);
        results.push(element);
      }
    }
  }
  return results;
}

function deepQuerySelector(selector) {
  for (const scope of getDomScopes()) {
    try {
      const element = scope.root.querySelector(selector);
      if (element) {
        return element;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function findScopeForElement(element) {
  const root = element?.getRootNode?.();
  return getDomScopes().find((scope) => scope.root === root) || { id: "top", kind: "document" };
}

function getGlobalRect(element) {
  const rect = element.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let currentWindow = element.ownerDocument?.defaultView;
  const visited = new Set();
  while (currentWindow && currentWindow !== window && !visited.has(currentWindow)) {
    visited.add(currentWindow);
    const frame = currentWindow.frameElement;
    if (!frame) {
      break;
    }
    const frameRect = frame.getBoundingClientRect();
    x += frameRect.left;
    y += frameRect.top;
    currentWindow = frame.ownerDocument?.defaultView;
  }
  return { left: x, top: y, right: x + rect.width, bottom: y + rect.height, width: rect.width, height: rect.height };
}

function isDomInstance(element, constructorName) {
  const Constructor = element?.ownerDocument?.defaultView?.[constructorName] || globalThis[constructorName];
  return Boolean(Constructor && element instanceof Constructor);
}

function collectInteractiveElements(maxElements, redactSensitiveData) {
  const selector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='menuitem']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='tab']",
    "[role='option']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  const scopeByElement = new Map();
  const candidates = queryAllDom(selector)
    .filter((element) => isVisible(element) && isNearViewport(element, 140))
    .filter((element) => {
      scopeByElement.set(element, findScopeForElement(element));
      return true;
    })
    .slice(0, maxElements);

  return candidates.map((element, index) => {
    const ref = `e${index + 1}`;
    const info = describeInteractiveElement(element, ref, {
      redactSensitiveData,
      scope: scopeByElement.get(element)
    });
    assistantPageState.elementsByRef.set(ref, {
      element,
      selector: info.selector,
      label: info.label
    });
    return info;
  });
}

function describeInteractiveElement(element, ref, options = {}) {
  const tag = element.tagName.toLowerCase();
  const rect = getGlobalRect(element);
  const inputType = tag === "input" ? String(element.getAttribute("type") || "text").toLowerCase() : "";
  const controlType = "type" in element ? String(element.getAttribute("type") || element.type || "").toLowerCase() : "";
  const rawValue = readElementValue(element, inputType);
  const value = options.redactSensitiveData ? redactSensitiveValue(rawValue, element, inputType) : rawValue;
  const href = tag === "a" ? element.href : "";
  const formAction = readFormAction(element);
  const form = isDomInstance(element, "HTMLFormElement") ? element : element.form || element.closest?.("form");
  const autocomplete = element.getAttribute("autocomplete") || "";
  const accessibleName = getAccessibleName(element);
  const label = options.redactSensitiveData ? redactSensitiveText(accessibleName) : accessibleName;

  return removeEmptyValues({
    ref,
    scope: options.scope?.id || "top",
    tag,
    role: element.getAttribute("role") || inferredRole(element, inputType),
    type: inputType || controlType || undefined,
    label,
    value,
    name: element.getAttribute("name") || undefined,
    placeholder: element.getAttribute("placeholder") || undefined,
    autocomplete: autocomplete || undefined,
    required: "required" in element ? Boolean(element.required) : undefined,
    readOnly: "readOnly" in element ? Boolean(element.readOnly) : undefined,
    sensitive: isSensitiveElement(element, inputType, autocomplete),
    checked: "checked" in element ? Boolean(element.checked) : undefined,
    disabled: "disabled" in element ? Boolean(element.disabled) : undefined,
    href: href ? truncate(sanitizeUrlForContext(href, options.redactSensitiveData), 220) : undefined,
    formAction: formAction ? truncate(sanitizeUrlForContext(formAction, options.redactSensitiveData), 220) : undefined,
    formMethod: form ? String(form.method || "get").toLowerCase() : undefined,
    options: isDomInstance(element, "HTMLSelectElement")
      ? Array.from(element.options).slice(0, 60).map((option) => ({
        value: truncate(option.value, 160),
        label: truncate(normalizeWhitespace(option.textContent || ""), 160),
        selected: option.selected,
        disabled: option.disabled
      }))
      : undefined,
    selector: buildCssSelector(element),
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  });
}

function readFormAction(element) {
  const form = isDomInstance(element, "HTMLFormElement") ? element : element.form || element.closest?.("form");
  if (!form) {
    return "";
  }

  return form.action || location.href;
}

function inferredRole(element, inputType) {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") {
    return "link";
  }
  if (tag === "button" || inputType === "button" || inputType === "submit" || inputType === "reset") {
    return "button";
  }
  if (inputType === "checkbox") {
    return "checkbox";
  }
  if (inputType === "radio") {
    return "radio";
  }
  if (tag === "select") {
    return "combobox";
  }
  if (tag === "textarea" || tag === "input" || element.isContentEditable) {
    return "textbox";
  }
  return tag;
}

function readElementValue(element, inputType) {
  if (inputType === "password") {
    return "[password]";
  }
  if (["HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"].some((name) => isDomInstance(element, name))) {
    return truncate(element.value || "", 240);
  }
  if (element.isContentEditable) {
    return truncate(normalizeWhitespace(element.innerText || element.textContent || ""), 240);
  }
  return undefined;
}

function collectHeadings(limit, redactSensitiveData) {
  return queryAllDom("h1,h2,h3,[role='heading']")
    .filter((element) => isVisible(element))
    .slice(0, limit)
    .map((element) => ({
      level: Number(element.getAttribute("aria-level")) || Number(element.tagName.slice(1)) || undefined,
      text: redactContextText(element.textContent || "", 220, redactSensitiveData)
    }))
    .filter((item) => item.text);
}

function collectLandmarks(limit, redactSensitiveData) {
  const selector = [
    "main",
    "nav",
    "header",
    "footer",
    "aside",
    "section",
    "[role='main']",
    "[role='navigation']",
    "[role='search']",
    "[role='banner']",
    "[role='contentinfo']",
    "[role='complementary']",
    "[aria-label]"
  ].join(",");

  return queryAllDom(selector)
    .filter((element) => isVisible(element))
    .slice(0, limit)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || inferredRole(element, ""),
      label: redactContextText(getAccessibleName(element), 260, redactSensitiveData),
      text: redactContextText(element.innerText || element.textContent || "", 280, redactSensitiveData)
    }))
    .filter((item) => item.label || item.text);
}

function collectForms(limit, redactSensitiveData) {
  return queryAllDom("form")
    .filter((form) => isVisible(form))
    .slice(0, limit)
    .map((form) => ({
      label: redactContextText(getAccessibleName(form) || form.getAttribute("name") || "", 260, redactSensitiveData),
      action: truncate(sanitizeUrlForContext(form.action || location.href, redactSensitiveData), 220),
      method: String(form.method || "get").toLowerCase(),
      fields: Array.from(form.querySelectorAll("input,textarea,select,button"))
        .filter((element) => isVisible(element))
        .slice(0, 30)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || element.type || "",
          label: redactContextText(getAccessibleName(element), 260, redactSensitiveData),
          required: Boolean(element.required),
          value: redactSensitiveData
            ? redactSensitiveValue(
              readElementValue(element, String(element.getAttribute("type") || "").toLowerCase()),
              element,
              String(element.getAttribute("type") || "").toLowerCase()
            )
            : readElementValue(element, String(element.getAttribute("type") || "").toLowerCase())
        }))
    }));
}

function collectTables(limit, redactSensitiveData) {
  return queryAllDom("table")
    .filter((table) => isVisible(table))
    .slice(0, limit)
    .map((table) => {
      const rows = Array.from(table.rows).slice(0, 12);
      return {
        caption: redactContextText(table.caption?.textContent || "", 220, redactSensitiveData),
        headers: Array.from(table.querySelectorAll("th")).slice(0, 20).map((cell) => redactContextText(cell.textContent || "", 120, redactSensitiveData)),
        rows: rows.map((row) => Array.from(row.cells).slice(0, 12).map((cell) => redactContextText(cell.textContent || "", 120, redactSensitiveData)))
      };
    });
}

function collectIframes(limit, redactSensitiveData) {
  return queryAllDom("iframe")
    .filter((iframe) => isVisible(iframe))
    .slice(0, limit)
    .map((iframe) => ({
      title: redactContextText(iframe.title || iframe.getAttribute("aria-label") || "", 260, redactSensitiveData),
      src: truncate(sanitizeUrlForContext(iframe.src || "", redactSensitiveData), 220),
      rect: rectToJson(getGlobalRect(iframe))
    }));
}

function collectPageState(redactSensitiveData) {
  const active = document.activeElement;
  return {
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    domRevision: assistantPageState.domRevision,
    scrollWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
    scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
    activeElement: active && active !== document.body
      ? {
        tag: active.tagName?.toLowerCase() || "",
        role: active.getAttribute?.("role") || "",
        label: redactContextText(getAccessibleName(active), 260, redactSensitiveData)
      }
      : null
  };
}

function collectLiveRegions(limit, redactSensitiveData) {
  return queryAllDom(
    "[role='alert'],[role='status'],[role='dialog'],[aria-live]:not([aria-live='off']),.error,.alert"
  )
    .filter((element) => isVisible(element))
    .slice(0, limit)
    .map((element) => ({
      role: element.getAttribute("role") || "",
      ariaLive: element.getAttribute("aria-live") || "",
      label: redactContextText(getAccessibleName(element), 260, redactSensitiveData),
      text: redactContextText(element.innerText || element.textContent || "", 500, redactSensitiveData)
    }))
    .filter((item) => item.label || item.text);
}

function collectVisibleText(maxChars) {
  const parts = [];
  let length = 0;
  for (const scope of getDomScopes()) {
    if (length >= maxChars) {
      break;
    }
    const ownerDocument = scope.root.nodeType === 9 ? scope.root : scope.root.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView || window;
    const root = scope.root.nodeType === 9 ? scope.root.body : scope.root;
    if (!root) {
      continue;
    }
    const walker = ownerDocument.createTreeWalker(root, ownerWindow.NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalizeWhitespace(node.nodeValue || "");
        if (!text) {
          return ownerWindow.NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || shouldSkipElement(parent) || !isVisible(parent) || !textNodeNearViewport(node)) {
          return ownerWindow.NodeFilter.FILTER_REJECT;
        }
        return ownerWindow.NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode() && length < maxChars) {
      const text = normalizeWhitespace(walker.currentNode.nodeValue || "");
      if (!text) {
        continue;
      }
      const remaining = maxChars - length;
      parts.push(text.slice(0, remaining));
      length += text.length + 1;
    }
  }

  return normalizeWhitespace(parts.join("\n"));
}

async function executePageActions(actions) {
  if (!Array.isArray(actions)) {
    throw new Error("Actions must be an array.");
  }

  const results = [];
  for (const [index, action] of actions.entries()) {
    const normalized = normalizeAction(action);
    try {
      const before = captureActionState(normalized);
      const undo = buildUndoForAction(normalized);
      const result = await executeSingleAction(normalized);
      if (!result?.mayNavigate) {
        await delay(normalized.type === "wait" ? 50 : 220);
      }
      const after = result?.mayNavigate ? null : captureActionState(normalized);
      const verification = compareActionStates(before, after, result);
      results.push({ index, ok: true, action: normalized, result, undo, verification });
      if (result?.mayNavigate || normalized.type === "navigate" || normalized.type === "submit") {
        break;
      }
    } catch (error) {
      results.push({
        index,
        ok: false,
        action: normalized,
        error: error.message || String(error)
      });
      break;
    }
    await delay(120);
  }

  return { results };
}

async function undoPageActions(undoActions) {
  if (!Array.isArray(undoActions)) {
    throw new Error("Undo actions must be an array.");
  }

  const results = [];
  for (const [index, undo] of undoActions.slice().reverse().entries()) {
    try {
      const result = await executeSingleUndo(undo);
      results.push({ index, ok: true, type: undo.type, result });
    } catch (error) {
      results.push({ index, ok: false, type: undo?.type || "undo", error: error.message || String(error) });
      break;
    }
    await delay(180);
  }
  return { results };
}

function buildUndoForAction(action) {
  if (action.type === "fill") {
    const element = resolveElement(action);
    if (isDomInstance(element, "HTMLInputElement")) {
      return {
        type: "restoreValue",
        selector: buildCssSelector(element),
        value: element.value,
        checked: element.checked,
        inputType: element.type
      };
    }
    if (isDomInstance(element, "HTMLTextAreaElement") || isDomInstance(element, "HTMLSelectElement")) {
      return {
        type: "restoreValue",
        selector: buildCssSelector(element),
        value: element.value
      };
    }
    if (element.isContentEditable) {
      return {
        type: "restoreText",
        selector: buildCssSelector(element),
        text: element.textContent || ""
      };
    }
  }

  if (action.type === "select") {
    const element = resolveElement(action);
    if (isDomInstance(element, "HTMLSelectElement")) {
      return {
        type: "restoreValue",
        selector: buildCssSelector(element),
        value: element.value
      };
    }
  }

  if (action.type === "scroll") {
    return {
      type: "restoreScroll",
      x: window.scrollX,
      y: window.scrollY
    };
  }

  if (action.type === "navigate" || action.type === "submit") {
    return { type: "historyBack" };
  }

  return null;
}

function executeSingleUndo(undo) {
  if (!undo || typeof undo !== "object") {
    throw new Error("Undo descriptor is missing.");
  }

  if (undo.type === "restoreScroll") {
    window.scrollTo({ left: Number(undo.x) || 0, top: Number(undo.y) || 0, behavior: "smooth" });
    return { restoredScroll: true };
  }

  if (undo.type === "historyBack") {
    history.back();
    return { historyBack: true };
  }

  const element = undo.selector ? document.querySelector(String(undo.selector)) : null;
  if (!element) {
    throw new Error("Undo target element was not found.");
  }
  prepareElementForAction(element);

  if (undo.type === "restoreText" && element.isContentEditable) {
    element.textContent = String(undo.text || "");
    dispatchInputEvents(element);
    return { restoredText: true };
  }

  if (undo.type === "restoreValue") {
    if (isDomInstance(element, "HTMLInputElement")) {
      if (element.type === "checkbox" || element.type === "radio") {
        element.checked = Boolean(undo.checked);
        dispatchInputEvents(element);
        return { checked: element.checked };
      }
      setNativeValue(element, String(undo.value || ""));
      dispatchInputEvents(element);
      return { value: element.value };
    }
    if (isDomInstance(element, "HTMLTextAreaElement") || isDomInstance(element, "HTMLSelectElement")) {
      setNativeValue(element, String(undo.value || ""));
      dispatchInputEvents(element);
      return { value: element.value };
    }
  }

  throw new Error(`Unsupported undo type: ${undo.type}`);
}

async function executeSingleAction(action) {
  switch (action.type) {
    case "click":
      return clickElement(action);
    case "fill":
      return fillElement(action);
    case "select":
      return selectElement(action);
    case "focus":
      return focusElement(action);
    case "hover":
      return hoverElement(action);
    case "submit":
      return submitElement(action);
    case "press":
      return pressKey(action);
    case "scroll":
      return scrollPage(action);
    case "navigate":
      return navigatePage(action);
    case "wait":
      await delay(clampNumber(action.ms, 100, 5000, 600));
      return { waitedMs: clampNumber(action.ms, 100, 5000, 600) };
    case "wait_for":
      return waitForCondition(action);
    case "upload":
      return uploadFiles(action);
    case "extract":
      return {
        text: collectVisibleText(8000),
        selection: getSelectionText()
      };
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

async function waitForCondition(action) {
  let condition;
  try {
    condition = JSON.parse(String(action.conditionJson || ""));
  } catch {
    throw new Error("wait_for conditionJson must be valid JSON.");
  }
  const timeoutMs = clampNumber(action.ms, 250, 30000, 10000);
  const startedAt = Date.now();
  let lastResult = evaluateWaitCondition(condition, { startedAt });
  if (lastResult.matched) {
    return { matched: true, elapsedMs: 0, observation: lastResult.observation };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const observers = [];
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      observers.forEach((observer) => observer.disconnect());
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const check = () => {
      assistantPageState.scopes = collectDomScopes();
      lastResult = evaluateWaitCondition(condition, { startedAt });
      if (lastResult.matched) {
        finish(null, {
          matched: true,
          elapsedMs: Date.now() - startedAt,
          observation: lastResult.observation
        });
      }
    };
    for (const scope of getDomScopes()) {
      const target = scope.root.nodeType === 9 ? scope.root.documentElement : scope.root;
      if (!target) {
        continue;
      }
      const OwnerMutationObserver = target.ownerDocument?.defaultView?.MutationObserver || MutationObserver;
      const observer = new OwnerMutationObserver(check);
      observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
      observers.push(observer);
    }
    const intervalId = window.setInterval(check, 150);
    const timeoutId = window.setTimeout(() => {
      finish(new Error(`wait_for condition was not satisfied within ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

function evaluateWaitCondition(condition, state) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return { matched: false, observation: "invalid condition" };
  }
  if (Array.isArray(condition.all)) {
    const results = condition.all.map((item) => evaluateWaitCondition(item, state));
    return {
      matched: results.length > 0 && results.every((item) => item.matched),
      observation: results.map((item) => item.observation)
    };
  }
  if (Array.isArray(condition.any)) {
    const results = condition.any.map((item) => evaluateWaitCondition(item, state));
    return {
      matched: results.some((item) => item.matched),
      observation: results.map((item) => item.observation)
    };
  }
  if (condition.not) {
    const result = evaluateWaitCondition(condition.not, state);
    return { matched: !result.matched, observation: { not: result.observation } };
  }

  const type = String(condition.type || "").toLowerCase();
  const operator = String(condition.operator || "contains").toLowerCase();
  const expected = condition.value === undefined ? "" : String(condition.value);
  if (type === "url") {
    return compareWaitValue(location.href, expected, operator, "url");
  }
  if (type === "title") {
    return compareWaitValue(document.title, expected, operator, "title");
  }
  if (["text", "live_region"].includes(type)) {
    const actual = type === "live_region"
      ? collectLiveRegions(30, true).map((item) => `${item.label} ${item.text}`).join("\n")
      : collectVisibleText(16000);
    return compareWaitValue(actual, expected, operator, type);
  }
  if (type === "dom_stable") {
    const stableMs = clampNumber(condition.stableMs ?? condition.value, 100, 10000, 500);
    const revision = assistantPageState.domRevision;
    if (state.lastRevision !== revision) {
      state.lastRevision = revision;
      state.lastRevisionAt = Date.now();
    }
    const elapsed = Date.now() - (state.lastRevisionAt || state.startedAt);
    return { matched: elapsed >= stableMs, observation: { revision, stableForMs: elapsed } };
  }
  if (["element", "element_state"].includes(type)) {
    const element = tryResolveWaitElement(condition);
    if (operator === "not_exists") {
      return { matched: !element, observation: { exists: Boolean(element) } };
    }
    if (!element) {
      return { matched: false, observation: { exists: false } };
    }
    if (type === "element" || operator === "exists") {
      return { matched: true, observation: { exists: true, label: getAccessibleName(element) } };
    }
    const stateName = String(condition.state || "visible").toLowerCase();
    const actual = readElementState(element, stateName);
    const targetValue = condition.expected ?? condition.value ?? true;
    return {
      matched: typeof actual === "string"
        ? compareWaitValue(actual, String(targetValue), operator, stateName).matched
        : actual === parseBoolean(targetValue),
      observation: { state: stateName, actual }
    };
  }
  return { matched: false, observation: `unsupported condition type: ${type || "missing"}` };
}

function compareWaitValue(actualValue, expectedValue, operator, label) {
  const actual = String(actualValue || "");
  const expected = String(expectedValue || "");
  let matched = false;
  if (operator === "equals") {
    matched = actual === expected;
  } else if (operator === "not_contains") {
    matched = !actual.toLowerCase().includes(expected.toLowerCase());
  } else if (operator === "matches") {
    try {
      matched = new RegExp(expected.slice(0, 500), "i").test(actual);
    } catch {
      matched = false;
    }
  } else {
    matched = actual.toLowerCase().includes(expected.toLowerCase());
  }
  return { matched, observation: { label, operator, expected, actual: truncate(actual, 500) } };
}

function tryResolveWaitElement(condition) {
  try {
    return resolveElement({
      ref: condition.ref,
      selector: condition.selector,
      text: condition.text,
      type: "wait_for"
    });
  } catch {
    return null;
  }
}

function readElementState(element, stateName) {
  if (stateName === "visible") {
    return isVisible(element);
  }
  if (stateName === "enabled") {
    return !("disabled" in element) || !element.disabled;
  }
  if (stateName === "checked") {
    return Boolean(element.checked);
  }
  if (stateName === "focused") {
    return element.ownerDocument?.activeElement === element;
  }
  if (stateName === "value") {
    return String(element.value ?? element.textContent ?? "");
  }
  return false;
}

async function uploadFiles(action) {
  const element = resolveElement(action);
  if (!isDomInstance(element, "HTMLInputElement") || String(element.type || "").toLowerCase() !== "file") {
    throw new Error("upload target must be an input[type=file].");
  }
  const descriptors = Array.isArray(action.files) ? action.files.slice(0, 12) : [];
  if (!descriptors.length) {
    throw new Error("No user-selected files were supplied to the upload action.");
  }
  const ownerWindow = element.ownerDocument?.defaultView || window;
  const transfer = new ownerWindow.DataTransfer();
  for (const descriptor of descriptors) {
    const response = await fetch(String(descriptor.dataUrl || ""));
    const blob = await response.blob();
    transfer.items.add(new ownerWindow.File([blob], String(descriptor.name || "file"), {
      type: String(descriptor.type || blob.type || "application/octet-stream"),
      lastModified: Number(descriptor.lastModified) || Date.now()
    }));
  }
  element.files = transfer.files;
  element.dispatchEvent(new ownerWindow.Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new ownerWindow.Event("change", { bubbles: true, composed: true }));
  return {
    uploaded: Array.from(element.files).map((file) => ({ name: file.name, type: file.type, size: file.size }))
  };
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    throw new Error("Action must be an object.");
  }

  return {
    ...action,
    type: String(action.type || "").trim().toLowerCase()
  };
}

function clickElement(action) {
  const element = resolveElement(action);
  const mayNavigate = actionMayUnloadPage(element);
  prepareElementForAction(element);
  if (mayNavigate) {
    window.setTimeout(() => element.click(), 80);
  } else {
    element.click();
  }
  return {
    clicked: getAccessibleName(element) || element.tagName.toLowerCase(),
    mayNavigate
  };
}

function fillElement(action) {
  const element = resolveElement(action);
  const value = action.value === undefined || action.value === null ? "" : String(action.value);
  prepareElementForAction(element);

  if ("readOnly" in element && element.readOnly) {
    throw new Error("Resolved element is read-only.");
  }

  if (isDomInstance(element, "HTMLInputElement")) {
    if (element.type === "checkbox" || element.type === "radio") {
      element.checked = parseBoolean(action.checked ?? action.value);
      dispatchInputEvents(element);
      return { checked: element.checked };
    }
    setNativeValue(element, value);
    dispatchInputEvents(element);
    return { value: element.value };
  }

  if (isDomInstance(element, "HTMLTextAreaElement")) {
    setNativeValue(element, value);
    dispatchInputEvents(element);
    return { value: element.value };
  }

  if (element.isContentEditable) {
    element.textContent = value;
    dispatchInputEvents(element);
    return { value };
  }

  throw new Error("Resolved element cannot be filled.");
}

function selectElement(action) {
  const element = resolveElement(action);
  prepareElementForAction(element);

  if (!isDomInstance(element, "HTMLSelectElement")) {
    throw new Error("Resolved element is not a select control.");
  }

  const wanted = String(action.value ?? action.label ?? "");
  const option = Array.from(element.options).find((candidate) => {
    return candidate.value === wanted || normalizeWhitespace(candidate.textContent || "") === wanted;
  });

  if (!option) {
    throw new Error(`Select option not found: ${wanted}`);
  }

  element.value = option.value;
  dispatchInputEvents(element);
  return { value: element.value, label: normalizeWhitespace(option.textContent || "") };
}

function focusElement(action) {
  const element = resolveElement(action);
  prepareElementForAction(element);
  element.focus();
  return { focused: getAccessibleName(element) || element.tagName.toLowerCase() };
}

function hoverElement(action) {
  const element = resolveElement(action);
  prepareElementForAction(element);
  const rect = element.getBoundingClientRect();
  for (const type of ["pointerover", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
    const EventType = type.startsWith("pointer") && globalThis.PointerEvent ? PointerEvent : MouseEvent;
    element.dispatchEvent(new EventType(type, {
      bubbles: type !== "mouseenter",
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      view: window
    }));
  }
  return { hovered: getAccessibleName(element) || element.tagName.toLowerCase() };
}

function submitElement(action) {
  const element = resolveElement(action);
  const form = isDomInstance(element, "HTMLFormElement") ? element : element.closest("form");
  if (!form) {
    throw new Error("No form found for submit action.");
  }

  window.setTimeout(() => {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }
  }, 80);
  return { submitted: true, mayNavigate: true };
}

function pressKey(action) {
  const key = String(action.key || "").trim();
  if (!key) {
    throw new Error("Key is required for press action.");
  }

  const element = action.ref || action.selector ? resolveElement(action) : document.activeElement || document.body;
  prepareElementForAction(element);

  for (const type of ["keydown", "keypress", "keyup"]) {
    element.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code: action.code || "",
        altKey: Boolean(action.altKey),
        ctrlKey: Boolean(action.ctrlKey),
        metaKey: Boolean(action.metaKey),
        shiftKey: Boolean(action.shiftKey),
        bubbles: true,
        cancelable: true
      })
    );
  }

  if (key === "Enter" && isDomInstance(element, "HTMLInputElement") && element.form) {
    window.setTimeout(() => element.form?.requestSubmit?.(), 80);
    return { pressed: key, mayNavigate: true };
  }

  return { pressed: key };
}

function scrollPage(action) {
  if (action.ref || action.selector || action.text) {
    const element = resolveElement(action);
    element.scrollIntoView({
      block: String(action.block || "center"),
      inline: String(action.inline || "nearest"),
      behavior: "smooth"
    });
    return { target: getAccessibleName(element) || element.tagName.toLowerCase() };
  }
  const amount = clampNumber(action.amount, 80, 3000, Math.round(window.innerHeight * 0.75));
  const direction = String(action.direction || "down").toLowerCase();
  const vector = {
    up: { top: -amount, left: 0 },
    down: { top: amount, left: 0 },
    left: { top: 0, left: -amount },
    right: { top: 0, left: amount }
  }[direction] || { top: amount, left: 0 };

  window.scrollBy({ ...vector, behavior: "smooth" });
  return { direction, amount };
}

function navigatePage(action) {
  const url = String(action.url || "").trim();
  if (!url) {
    throw new Error("URL is required for navigate action.");
  }

  const resolved = new URL(url, location.href);
  if (!["http:", "https:"].includes(resolved.protocol)) {
    throw new Error("Only http and https navigation is allowed.");
  }

  window.setTimeout(() => location.assign(resolved.href), 80);
  return { url: resolved.href, mayNavigate: true };
}

function resolveElement(action) {
  if (action.ref) {
    const found = assistantPageState.elementsByRef.get(String(action.ref));
    if (found?.element?.isConnected) {
      return found.element;
    }
    if (found?.selector) {
      const selected = deepQuerySelector(found.selector);
      if (selected) {
        return selected;
      }
    }
  }

  if (action.selector) {
    const selected = deepQuerySelector(String(action.selector));
    if (selected) {
      return selected;
    }
  }

  if (action.text) {
    const text = normalizeWhitespace(String(action.text)).toLowerCase();
    const matched = queryAllDom("a,button,input,textarea,select,[role],[tabindex]")
      .filter((element) => isVisible(element))
      .find((element) => getAccessibleName(element).toLowerCase().includes(text));
    if (matched) {
      return matched;
    }
  }

  throw new Error(`Element not found for action: ${action.ref || action.selector || action.text || action.type}`);
}

function prepareElementForAction(element) {
  if (!element?.ownerDocument || !element?.tagName) {
    throw new Error("Resolved target is not an actionable element.");
  }

  if ("disabled" in element && element.disabled) {
    throw new Error("Resolved target is disabled.");
  }

  if (isDomInstance(element, "HTMLElement")) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    element.focus({ preventScroll: true });
  } else {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }

  highlightElement(element);
}

function actionMayUnloadPage(element) {
  if (isDomInstance(element, "HTMLAnchorElement") && element.href) {
    return true;
  }

  if (isDomInstance(element, "HTMLButtonElement")) {
    const type = String(element.type || "submit").toLowerCase();
    return type === "submit" && Boolean(element.form);
  }

  if (isDomInstance(element, "HTMLInputElement")) {
    const type = String(element.type || "").toLowerCase();
    return ["submit", "image"].includes(type) && Boolean(element.form);
  }

  return false;
}

function setNativeValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

function dispatchInputEvents(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function captureActionState(action) {
  let target = null;
  try {
    target = action.ref || action.selector || action.text ? resolveElement(action) : null;
  } catch {
    target = null;
  }
  const targetState = target ? {
    tag: target.tagName?.toLowerCase() || "",
    label: getAccessibleName(target),
    value: "value" in target ? truncate(String(target.value || ""), 500) : undefined,
    checked: "checked" in target ? Boolean(target.checked) : undefined,
    expanded: target.getAttribute?.("aria-expanded") || undefined,
    selected: target.getAttribute?.("aria-selected") || undefined,
    disabled: "disabled" in target ? Boolean(target.disabled) : undefined,
    text: truncate(normalizeWhitespace(target.innerText || target.textContent || ""), 500)
  } : null;
  const snapshot = {
    url: location.href,
    title: document.title,
    domRevision: assistantPageState.domRevision,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    target: targetState,
    liveText: collectLiveRegions(8).map((item) => item.text).join("\n"),
    visibleText: collectVisibleText(2000)
  };
  return { ...snapshot, fingerprint: hashState(snapshot) };
}

function compareActionStates(before, after, result) {
  if (!after) {
    return {
      changed: Boolean(result?.mayNavigate),
      reason: result?.mayNavigate ? "navigation started" : "post-action state unavailable",
      beforeFingerprint: before?.fingerprint || "",
      afterFingerprint: ""
    };
  }
  const changed = before?.fingerprint !== after.fingerprint;
  return {
    changed,
    reason: changed ? "observable page state changed" : "no observable page state change",
    beforeFingerprint: before?.fingerprint || "",
    afterFingerprint: after.fingerprint,
    urlChanged: before?.url !== after.url,
    domChanged: before?.domRevision !== after.domRevision,
    targetChanged: JSON.stringify(before?.target || null) !== JSON.stringify(after.target || null)
  };
}

function observePageMutations() {
  const start = () => {
    if (!document.documentElement) {
      return;
    }
    assistantPageState.scopes = collectDomScopes();
    observeDomScopes(assistantPageState.scopes);
  };
  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
}

function observeDomScopes(scopes) {
  for (const scope of scopes || []) {
    const target = scope.root.nodeType === 9 ? scope.root.documentElement : scope.root;
    if (!target || assistantPageState.observedRoots.has(target)) {
      continue;
    }
    const OwnerMutationObserver = target.ownerDocument?.defaultView?.MutationObserver || MutationObserver;
    const observer = new OwnerMutationObserver((mutations) => {
      if (mutations.some((mutation) => !mutation.target?.closest?.("[data-my-assistant-overlay]"))) {
        assistantPageState.domRevision += 1;
      }
    });
    observer.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
    assistantPageState.observedRoots.add(target);
    assistantPageState.mutationObservers.push(observer);
  }
}

function hashState(value) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function isSensitiveElement(element, inputType, autocomplete) {
  const descriptor = [
    inputType,
    autocomplete,
    element.getAttribute("name"),
    element.getAttribute("id"),
    getAccessibleName(element)
  ].filter(Boolean).join(" ");
  return /password|secret|token|api.?key|card|cc-|cvv|cvc|ssn|주민|비밀번호|인증.?번호/i.test(descriptor);
}

function highlightElement(element) {
  const rect = element.getBoundingClientRect();
  const overlay = getOrCreateHighlightOverlay();
  overlay.style.left = `${Math.max(0, rect.left - 4)}px`;
  overlay.style.top = `${Math.max(0, rect.top - 4)}px`;
  overlay.style.width = `${Math.max(0, rect.width + 8)}px`;
  overlay.style.height = `${Math.max(0, rect.height + 8)}px`;
  overlay.style.opacity = "1";

  window.clearTimeout(overlay.hideTimer);
  overlay.hideTimer = window.setTimeout(() => {
    overlay.style.opacity = "0";
  }, 900);
}

function getOrCreateHighlightOverlay() {
  const id = "__my_assistant_web_plugin_highlight__";
  let overlay = document.getElementById(id);
  if (overlay) {
    return overlay;
  }

  overlay = document.createElement("div");
  overlay.id = id;
  overlay.dataset.myAssistantOverlay = "true";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    border: "2px solid #0f9f95",
    borderRadius: "6px",
    boxShadow: "0 0 0 3px rgba(15, 159, 149, 0.18)",
    transition: "opacity 180ms ease",
    opacity: "0"
  });
  document.documentElement.appendChild(overlay);
  return overlay;
}

function startElementPicker() {
  if (assistantPageState.picker?.cleanup) {
    assistantPageState.picker.cleanup();
  }

  return new Promise((resolve) => {
    const overlay = getOrCreatePickerOverlay();
    const hint = getOrCreatePickerHint();
    let currentElement = null;

    const cleanup = () => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.style.opacity = "0";
      hint.remove();
      assistantPageState.picker = null;
    };

    const finish = (element) => {
      cleanup();
      if (!element) {
        resolve({ cancelled: true, element: null });
        return;
      }
      const picked = describeInteractiveElement(element, "picked", { redactSensitiveData: true });
      resolve({ cancelled: false, element: picked });
    };

    const onMouseMove = (event) => {
      const element = event.composedPath?.().find((item) => item?.tagName) || document.elementFromPoint(event.clientX, event.clientY);
      if (!element || element === overlay || element === hint || hint.contains(element)) {
        return;
      }
      currentElement = element.closest?.("a,button,input,textarea,select,[role],[tabindex],table,form,section,article,main") || element;
      const rect = getGlobalRect(currentElement);
      Object.assign(overlay.style, {
        left: `${Math.max(0, rect.left - 4)}px`,
        top: `${Math.max(0, rect.top - 4)}px`,
        width: `${Math.max(0, rect.width + 8)}px`,
        height: `${Math.max(0, rect.height + 8)}px`,
        opacity: "1"
      });
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish(currentElement);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };

    assistantPageState.picker = { cleanup };
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  });
}

function getOrCreatePickerOverlay() {
  const id = "__my_assistant_web_plugin_picker__";
  let overlay = document.getElementById(id);
  if (overlay) {
    return overlay;
  }
  overlay = document.createElement("div");
  overlay.id = id;
  overlay.dataset.myAssistantOverlay = "true";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    border: "2px solid #2563eb",
    borderRadius: "6px",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.18)",
    transition: "opacity 100ms ease",
    opacity: "0"
  });
  document.documentElement.appendChild(overlay);
  return overlay;
}

function getOrCreatePickerHint() {
  const hint = document.createElement("div");
  hint.dataset.myAssistantOverlay = "true";
  hint.textContent = "요소를 클릭하세요. Esc로 취소";
  Object.assign(hint.style, {
    position: "fixed",
    left: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    padding: "8px 10px",
    borderRadius: "8px",
    background: "#111827",
    color: "#ffffff",
    font: "12px system-ui, sans-serif",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.22)"
  });
  document.documentElement.appendChild(hint);
  return hint;
}

function getAccessibleName(element) {
  const ownerDocument = element.ownerDocument || document;
  const queryRoot = element.getRootNode?.() || ownerDocument;
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return truncate(normalizeWhitespace(ariaLabel), 260);
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelText = labelledBy
      .split(/\s+/)
      .map((id) => queryRoot.getElementById?.(id)?.textContent || ownerDocument.getElementById(id)?.textContent || "")
      .join(" ");
    if (normalizeWhitespace(labelText)) {
      return truncate(normalizeWhitespace(labelText), 260);
    }
  }

  if (element.id) {
    const explicitLabel = queryRoot.querySelector?.(`label[for="${cssAttributeEscape(element.id)}"]`) || ownerDocument.querySelector(`label[for="${cssAttributeEscape(element.id)}"]`);
    if (explicitLabel?.textContent) {
      return truncate(normalizeWhitespace(explicitLabel.textContent), 260);
    }
  }

  const wrappingLabel = element.closest("label");
  if (wrappingLabel?.textContent) {
    return truncate(normalizeWhitespace(wrappingLabel.textContent), 260);
  }

  const placeholder = element.getAttribute("placeholder");
  if (placeholder) {
    return truncate(normalizeWhitespace(placeholder), 260);
  }

  const title = element.getAttribute("title");
  if (title) {
    return truncate(normalizeWhitespace(title), 260);
  }

  if (isDomInstance(element, "HTMLInputElement") && ["submit", "button", "reset"].includes(element.type)) {
    return truncate(normalizeWhitespace(element.value), 260);
  }

  return truncate(normalizeWhitespace(element.innerText || element.textContent || element.getAttribute("value") || ""), 260);
}

function buildCssSelector(element) {
  if (!element?.ownerDocument || !element?.tagName) {
    return "";
  }

  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    let part = tag;
    const stableAttribute = getStableAttribute(current);
    if (stableAttribute) {
      part += `[${stableAttribute.name}="${cssAttributeEscape(stableAttribute.value)}"]`;
      parts.unshift(part);
      break;
    }

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }

    parts.unshift(part);
    current = parent;
    if (parts.length >= 6) {
      break;
    }
  }

  return parts.join(" > ");
}

function getStableAttribute(element) {
  for (const name of ["data-testid", "data-test", "data-cy", "name", "aria-label", "placeholder", "title"]) {
    const value = element.getAttribute(name);
    if (value && value.length <= 90) {
      return { name, value };
    }
  }
  return null;
}

function isVisible(element) {
  if (!element?.ownerDocument || !element?.tagName) {
    return false;
  }

  if (shouldSkipElement(element)) {
    return false;
  }

  const ownerWindow = element.ownerDocument?.defaultView || window;
  const style = ownerWindow.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isNearViewport(element, margin) {
  const rect = getGlobalRect(element);
  return (
    rect.bottom >= -margin &&
    rect.right >= -margin &&
    rect.top <= window.innerHeight + margin &&
    rect.left <= window.innerWidth + margin
  );
}

function textNodeNearViewport(textNode) {
  const ownerDocument = textNode.ownerDocument || document;
  const range = ownerDocument.createRange();
  range.selectNodeContents(textNode);
  const element = textNode.parentElement;
  const baseRect = element ? getGlobalRect(element) : null;
  const localElementRect = element?.getBoundingClientRect();
  const offsetX = baseRect && localElementRect ? baseRect.left - localElementRect.left : 0;
  const offsetY = baseRect && localElementRect ? baseRect.top - localElementRect.top : 0;
  const rects = Array.from(range.getClientRects()).map((rect) => ({
    left: rect.left + offsetX,
    right: rect.right + offsetX,
    top: rect.top + offsetY,
    bottom: rect.bottom + offsetY
  }));
  range.detach?.();
  return rects.some((rect) => (
    rect.bottom >= -20 &&
    rect.right >= -20 &&
    rect.top <= window.innerHeight + 20 &&
    rect.left <= window.innerWidth + 20
  ));
}

function shouldSkipElement(element) {
  const tag = element.tagName?.toLowerCase();
  return ["script", "style", "noscript", "template", "svg", "canvas"].includes(tag);
}

function getSelectionText() {
  return truncate(normalizeWhitespace(window.getSelection?.().toString() || ""), 4000);
}

function rectToJson(rect) {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[redacted-number]")
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*[^\s"'<>]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]");
}

function redactContextText(value, maxLength, redactSensitiveData) {
  const text = normalizeWhitespace(value || "");
  return truncate(redactSensitiveData ? redactSensitiveText(text) : text, maxLength);
}

function sanitizeUrlForContext(value, redactSensitiveData) {
  const text = String(value || "");
  if (!redactSensitiveData || !text) {
    return text;
  }
  try {
    const url = new URL(text, location.href);
    url.username = url.username ? "redacted" : "";
    url.password = url.password ? "redacted" : "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|secret|password|passwd|auth|key|code|credential|session|cookie|card|cvv|cvc/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return redactSensitiveText(text);
  }
}

function redactSensitiveValue(value, element, inputType) {
  if (value === undefined || value === null || value === "") {
    return value;
  }
  const name = [
    inputType,
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("autocomplete"),
    getAccessibleName(element)
  ].join(" ");
  if (/password|token|secret|key|auth|email|tel|phone|card|ssn/i.test(name)) {
    return "[redacted]";
  }
  return redactSensitiveText(value);
}

function removeEmptyValues(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value || "").trim().toLowerCase();
  if (["false", "no", "off", "0", "unchecked"].includes(normalized)) {
    return false;
  }
  if (["true", "yes", "on", "1", "checked"].includes(normalized)) {
    return true;
  }
  return Boolean(value);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function cssAttributeEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function serializeContentError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error)
  };
}
})();
