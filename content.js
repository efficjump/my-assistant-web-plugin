(() => {
if (globalThis.__myAssistantWebPluginLoaded) {
  return;
}
globalThis.__myAssistantWebPluginLoaded = true;

const assistantDocumentId = createDocumentId();
const assistantPageState = {
  elementsByRef: new Map(),
  elementBindings: new WeakMap(),
  elementStateBindings: new WeakMap(),
  elementRefs: new WeakMap(),
  elementRefCounters: { e: 0, s: 0, v: 0 },
  picker: null,
  domRevision: 0,
  documentId: assistantDocumentId,
  refNamespace: createRefNamespace(assistantDocumentId),
  scopes: [],
  observedRoots: new WeakSet(),
  mutationObservers: [],
  visualOccluderCache: new WeakMap(),
  includeChildFrames: true,
  redactSensitiveData: true,
  collectionCache: null,
  observationProbe: null,
  visualRevision: 0,
  visualListenersInstalled: false
};

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem"
]);

const NATIVE_INTERACTIVE_TAGS = new Set([
  "a",
  "area",
  "audio",
  "button",
  "input",
  "label",
  "select",
  "summary",
  "textarea",
  "video"
]);
const MAX_COLLECTION_LINK_SCAN = 12000;

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
    case "COLLECT_FRAME_CONTEXT":
      return collectFrameContext(message.options || {});
    case "VERIFY_OBSERVATION_PROBE":
      return verifyObservationProbe();
    case "WAIT_FOR_PAGE_SETTLE":
      return waitForPageSettle(message.options || {});
    case "EXECUTE_PAGE_ACTIONS":
      return executePageActions(message.actions || [], message.executionBindings || []);
    case "VERIFY_PAGE_ACTION_EFFECT":
      return verifyPageActionEffect(message.action || {}, message.beforeFingerprint || "");
    case "UNDO_PAGE_ACTIONS":
      return undoPageActions(message.undoActions || []);
    case "START_ELEMENT_PICKER":
      return startElementPicker();
    default:
      throw new Error(`Unknown content message type: ${message?.type || "missing"}`);
  }
}

function collectPageContext(options) {
  const collectionStartedAt = performance.now();
  assistantPageState.collectionCache = createCollectionCache();
  try {
  assistantPageState.elementsByRef.clear();
  assistantPageState.visualOccluderCache = new WeakMap();
  assistantPageState.includeChildFrames = options.includeChildFrames !== false;
  assistantPageState.scopes = measureCollectionPhase(
    "domScopes",
    () => collectDomScopes(assistantPageState.includeChildFrames)
  );
  observeDomScopes(assistantPageState.scopes);

  const maxTextChars = clampNumber(options.maxTextChars, 4000, 50000, 16000);
  const maxElements = clampNumber(options.maxElements, 1, 500, 80);
  const elementOffset = Math.floor(clampNumber(options.elementOffset, 0, Number.MAX_SAFE_INTEGER, 0));
  const elementSearch = normalizeLocalElementSearch({
    query: options.elementQuery,
    roles: options.elementRoles,
    nearText: options.elementNearText
  });
  const redactSensitiveData = options.redactSensitiveData !== false;
  assistantPageState.redactSensitiveData = redactSensitiveData;
  const interactiveElementCollection = measureCollectionPhase(
    "interactiveElements",
    () => collectInteractiveElements({
      limit: maxElements,
      offset: elementOffset,
      search: elementSearch,
      redactSensitiveData
    })
  );
  const interactiveElements = interactiveElementCollection.elements;
  const scrollRegions = measureCollectionPhase(
    "scrollRegions",
    () => collectScrollRegions(
      Math.max(6, Math.min(24, Math.ceil(maxElements / 4))),
      redactSensitiveData
    )
  );
  const visualSurfaces = measureCollectionPhase(
    "visualSurfaces",
    () => collectVisualSurfaces(
      Math.max(4, Math.min(16, Math.ceil(maxElements / 5))),
      redactSensitiveData
    )
  );
  const frameBoundaries = measureCollectionPhase(
    "frameBoundaries",
    () => collectFrameBoundaries(36, redactSensitiveData)
  );
  const iframes = collectIframes(frameBoundaries, 12);
  const collectedVisibleText = measureCollectionPhase(
    "visibleText",
    () => collectVisibleText(maxTextChars)
  );
  const visibleText = redactSensitiveData
    ? redactSensitiveText(collectedVisibleText)
    : collectedVisibleText;
  const semanticContext = measureCollectionPhase("semanticContext", () => ({
    headings: collectHeadings(24, redactSensitiveData),
    landmarks: collectLandmarks(24, redactSensitiveData),
    forms: collectForms(12, redactSensitiveData),
    tables: collectTables(10, redactSensitiveData),
    liveRegions: collectLiveRegions(20, redactSensitiveData)
  }));
  const observationProbe = measureCollectionPhase(
    "observationProbe",
    () => createObservationProbe()
  );
  const collectionCache = assistantPageState.collectionCache;

  const context = {
    documentId: assistantPageState.documentId,
    refScope: {
      namespace: assistantPageState.refNamespace,
      documentId: assistantPageState.documentId,
      policy: "Only refs returned by this observation are executable."
    },
    url: sanitizeUrlForContext(location.href, redactSensitiveData),
    title: redactSensitiveData ? redactSensitiveText(document.title) : document.title,
    frameName: redactSensitiveData ? redactSensitiveText(window.name || "") : window.name || "",
    frameNameBinding: window.name || "",
    frameNameDigest: window.name ? hashState(String(window.name)) : "",
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
    // Kept as a compatibility alias, but deliberately scoped to the visual viewport.
    documentTextExcerpt: visibleText,
    observationScope: {
      kind: "visual-viewport",
      includes: ["painted text", "visually exposed controls", "visible scroll regions", "visible visual surfaces"],
      excludes: ["offscreen content", "clipped content", "occluded content", "hidden DOM"]
    },
    headings: semanticContext.headings,
    landmarks: semanticContext.landmarks,
    forms: semanticContext.forms,
    tables: semanticContext.tables,
    iframes,
    frameBoundaries,
    liveRegions: semanticContext.liveRegions,
    domScopes: assistantPageState.scopes.map((scope) => ({
      id: scope.id,
      kind: scope.kind,
      parentId: scope.parentId || "",
      sameOrigin: scope.sameOrigin !== false
    })),
    interactiveElementStats: interactiveElementCollection.stats,
    interactiveElements,
    scrollRegions,
    visualSurfaces,
    automationCapabilities: buildLocalAutomationCapabilities({
      scrollRegions,
      visualSurfaces,
      iframes
    }),
    observationProbe,
    collectionDiagnostics: {
      durationMs: roundDuration(performance.now() - collectionStartedAt),
      phaseDurationsMs: Object.fromEntries(
        Array.from(collectionCache.phaseDurations.entries())
          .map(([name, duration]) => [name, roundDuration(duration)])
      ),
      domScopeCount: assistantPageState.scopes.length,
      scannedElementCount: collectionCache.scannedElementCount,
      queryCount: collectionCache.queryCount,
      cacheHits: { ...collectionCache.cacheHits }
    }
  };
  return context;
  } finally {
    for (const scope of assistantPageState.scopes) {
      scope.elements = null;
    }
    assistantPageState.collectionCache = null;
  }
}

function createObservationProbe() {
  const targets = Array.from(assistantPageState.elementsByRef.entries())
    .map(([ref, record]) => ({ ref, element: record.element }))
    .filter((entry) => entry.element?.isConnected);
  const frameElements = queryAllDom("iframe,frame");
  const probe = {
    version: "1.0",
    documentId: assistantPageState.documentId,
    targets,
    frameElements,
    baseline: null
  };
  probe.baseline = readObservationProbeDescriptor(probe);
  assistantPageState.observationProbe = probe;
  return {
    version: probe.version,
    documentId: probe.documentId,
    digest: probe.baseline.digest,
    targetCount: targets.length,
    frameBoundaryCount: frameElements.length
  };
}

function verifyObservationProbe() {
  const probe = assistantPageState.observationProbe;
  if (!probe || probe.documentId !== assistantPageState.documentId) {
    return {
      version: "1.0",
      documentId: assistantPageState.documentId,
      digest: "",
      matchesBaseline: false,
      reason: "observation_probe_missing"
    };
  }
  const currentHeader = readObservationProbeHeader();
  if (
    currentHeader.domRevision !== probe.baseline.header.domRevision
    || currentHeader.visualRevision !== probe.baseline.header.visualRevision
    || currentHeader.viewportWidth !== probe.baseline.header.viewportWidth
    || currentHeader.viewportHeight !== probe.baseline.header.viewportHeight
    || currentHeader.scrollX !== probe.baseline.header.scrollX
    || currentHeader.scrollY !== probe.baseline.header.scrollY
  ) {
    return {
      version: probe.version,
      documentId: probe.documentId,
      digest: hashObservationProbe(currentHeader),
      matchesBaseline: false,
      reason: "observation_header_changed"
    };
  }

  assistantPageState.collectionCache = createCollectionCache();
  assistantPageState.visualOccluderCache = new WeakMap();
  try {
    const descriptor = readObservationProbeDescriptor(probe);
    return {
      version: probe.version,
      documentId: probe.documentId,
      digest: descriptor.digest,
      matchesBaseline: descriptor.digest === probe.baseline.digest,
      reason: descriptor.digest === probe.baseline.digest
        ? ""
        : "observation_geometry_changed"
    };
  } finally {
    assistantPageState.collectionCache = null;
  }
}

function waitForPageSettle(options = {}) {
  const quietMs = clampNumber(options.quietMs, 80, 1000, 180);
  const timeoutMs = clampNumber(options.timeoutMs, quietMs, 5000, Math.max(quietMs * 5, 900));
  const pollMs = clampNumber(options.pollMs, 25, Math.min(100, quietMs), Math.min(50, quietMs));
  const startedAt = performance.now();
  let lastChangedAt = startedAt;
  let lastSignal = readPageSettleSignal();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      const now = performance.now();
      resolve({
        settled: !timedOut,
        timedOut: Boolean(timedOut),
        elapsedMs: roundDuration(now - startedAt),
        stableForMs: roundDuration(now - lastChangedAt),
        signal: readPageSettleSignal()
      });
    };
    const check = () => {
      const now = performance.now();
      const signal = readPageSettleSignal();
      if (JSON.stringify(signal) !== JSON.stringify(lastSignal)) {
        lastSignal = signal;
        lastChangedAt = now;
      }
      if (
        signal.readyState !== "loading"
        && now - lastChangedAt >= quietMs
      ) {
        finish(false);
      }
    };
    const intervalId = window.setInterval(check, pollMs);
    const timeoutId = window.setTimeout(() => finish(true), timeoutMs);
    check();
  });
}

function readPageSettleSignal() {
  return {
    documentId: assistantPageState.documentId,
    url: sanitizeUrlForContext(location.href, true),
    readyState: document.readyState,
    domRevision: assistantPageState.domRevision,
    visualRevision: assistantPageState.visualRevision,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY)
  };
}

function readObservationProbeDescriptor(probe) {
  const header = readObservationProbeHeader();
  const targets = probe.targets.map(({ ref, element }) => {
    if (!element?.isConnected) {
      return { ref, connected: false };
    }
    const point = findExposedPoint(element);
    const rect = getGlobalRect(element);
    return {
      ref,
      connected: true,
      binding: createElementBinding(element),
      stateBinding: createElementStateBinding(element),
      exposed: Boolean(point),
      rect: compactProbeRect(rect),
      hitPoint: point
        ? { x: Math.round(point.globalX), y: Math.round(point.globalY) }
        : null,
      scrollTop: ref.startsWith("s") ? Math.round(element.scrollTop) : null,
      scrollLeft: ref.startsWith("s") ? Math.round(element.scrollLeft) : null
    };
  });
  const frames = probe.frameElements.map((element, index) => ({
    index,
    connected: Boolean(element?.isConnected),
    exposed: Boolean(element?.isConnected && findExposedPoint(element)),
    rect: element?.isConnected ? compactProbeRect(getGlobalRect(element)) : null,
    src: element?.isConnected
      ? sanitizeFrameBoundaryUrl(
          element.getAttribute("src")
            || (element.hasAttribute("srcdoc") ? "about:srcdoc" : element.src || "about:blank"),
          true
        )
      : ""
  }));
  const payload = { header, targets, frames };
  return {
    header,
    digest: hashObservationProbe(payload)
  };
}

function readObservationProbeHeader() {
  return {
    documentId: assistantPageState.documentId,
    url: sanitizeUrlForContext(location.href, true),
    domRevision: assistantPageState.domRevision,
    visualRevision: assistantPageState.visualRevision,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY)
  };
}

function compactProbeRect(rect) {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function hashObservationProbe(value) {
  const text = JSON.stringify(value);
  const hashes = [2166136261, 2246822507, 3266489909, 668265263];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      hashes[hashIndex] ^= code + hashIndex * 97;
      hashes[hashIndex] = Math.imul(hashes[hashIndex], 16777619 + hashIndex * 2);
    }
  }
  return hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, "0")).join("");
}

function collectFrameContext(options = {}) {
  assistantPageState.collectionCache = createCollectionCache();
  try {
    assistantPageState.visualOccluderCache = new WeakMap();
    assistantPageState.includeChildFrames = false;
    assistantPageState.scopes = collectDomScopes(false);
    observeDomScopes(assistantPageState.scopes);
    const redactSensitiveData = options.redactSensitiveData !== false;
    assistantPageState.redactSensitiveData = redactSensitiveData;
    return {
      documentId: assistantPageState.documentId,
      url: sanitizeUrlForContext(location.href, redactSensitiveData),
      frameName: redactSensitiveData ? redactSensitiveText(window.name || "") : window.name || "",
      frameNameBinding: window.name || "",
      frameNameDigest: window.name ? hashState(String(window.name)) : "",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY)
      },
      pageState: {
        domRevision: assistantPageState.domRevision,
        visualRevision: assistantPageState.visualRevision
      },
      frameBoundaries: collectFrameBoundaries(72, redactSensitiveData)
    };
  } finally {
    for (const scope of assistantPageState.scopes) {
      scope.elements = null;
    }
    assistantPageState.collectionCache = null;
  }
}

function createCollectionCache() {
  return {
    queryResults: new Map(),
    styles: new WeakMap(),
    rects: new WeakMap(),
    globalRects: new WeakMap(),
    rendered: new WeakMap(),
    exposedPoints: new WeakMap(),
    textExposure: new WeakMap(),
    imageMapGeometries: new WeakMap(),
    phaseDurations: new Map(),
    scannedElementCount: 0,
    queryCount: 0,
    cacheHits: {
      query: 0,
      style: 0,
      rect: 0,
      globalRect: 0,
      rendered: 0,
      exposedPoint: 0,
      textExposure: 0
    }
  };
}

function measureCollectionPhase(name, callback) {
  const startedAt = performance.now();
  try {
    return callback();
  } finally {
    const cache = assistantPageState.collectionCache;
    if (cache) {
      cache.phaseDurations.set(
        name,
        (cache.phaseDurations.get(name) || 0) + performance.now() - startedAt
      );
    }
  }
}

function roundDuration(value) {
  return Math.round(Number(value || 0) * 10) / 10;
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

function createRefNamespace(documentId) {
  const normalized = String(documentId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12);
  return normalized || Math.floor(Date.now()).toString(36);
}

function getOrCreateElementRef(element, kind) {
  const prefix = ["e", "s", "v"].includes(kind) ? kind : "e";
  const existing = assistantPageState.elementRefs.get(element) || {};
  if (existing[prefix]) {
    return existing[prefix];
  }
  assistantPageState.elementRefCounters[prefix] += 1;
  const ref = `${prefix}${assistantPageState.refNamespace}-${assistantPageState.elementRefCounters[prefix].toString(36)}`;
  existing[prefix] = ref;
  assistantPageState.elementRefs.set(element, existing);
  return ref;
}

function collectDomScopes(includeChildFrames = true) {
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
      sameOrigin: descriptor.sameOrigin !== false,
      elements: []
    };
    scopes.push(scope);

    const elements = Array.from(root.querySelectorAll("*"));
    scope.elements = assistantPageState.collectionCache ? elements : null;
    if (assistantPageState.collectionCache) {
      assistantPageState.collectionCache.scannedElementCount += elements.length;
    }
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
      if (includeChildFrames && ["iframe", "frame"].includes(element.tagName?.toLowerCase())) {
        frameIndex += 1;
        try {
          const frameDocument = element.contentDocument;
          if (frameDocument?.documentElement) {
            visit(frameDocument, {
              id: `${scope.id}/frame-${frameIndex}`,
              kind: element.tagName.toLowerCase(),
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
  return assistantPageState.scopes.length
    ? assistantPageState.scopes
    : collectDomScopes(assistantPageState.includeChildFrames);
}

function queryAllDom(selector) {
  const cache = assistantPageState.collectionCache;
  if (cache?.queryResults.has(selector)) {
    cache.cacheHits.query += 1;
    return cache.queryResults.get(selector);
  }
  const results = [];
  const seen = new Set();
  if (cache) {
    cache.queryCount += 1;
  }
  for (const scope of getDomScopes()) {
    const scopedElements = selector === "*" && Array.isArray(scope.elements)
      ? scope.elements
      : Array.from(scope.root.querySelectorAll(selector));
    for (const element of scopedElements) {
      if (!seen.has(element)) {
        seen.add(element);
        results.push(element);
      }
    }
  }
  cache?.queryResults.set(selector, results);
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
  const cache = assistantPageState.collectionCache;
  if (cache?.globalRects.has(element)) {
    cache.cacheHits.globalRect += 1;
    return cache.globalRects.get(element);
  }
  if (element.tagName?.toLowerCase() === "area") {
    const imageMapGeometry = getImageMapAreaGeometry(element);
    if (imageMapGeometry?.globalRect) {
      cache?.globalRects.set(element, imageMapGeometry.globalRect);
      return imageMapGeometry.globalRect;
    }
  }
  const rect = getElementRect(element);
  let x = rect.left;
  let y = rect.top;
  let width = rect.width;
  let height = rect.height;
  let currentWindow = element.ownerDocument?.defaultView;
  const visited = new Set();
  while (currentWindow && currentWindow !== window && !visited.has(currentWindow)) {
    visited.add(currentWindow);
    const frame = currentWindow.frameElement;
    if (!frame) {
      break;
    }
    const frameRect = getElementRect(frame);
    const scaleX = frame.offsetWidth ? frameRect.width / frame.offsetWidth : 1;
    const scaleY = frame.offsetHeight ? frameRect.height / frame.offsetHeight : 1;
    x = frameRect.left + (frame.clientLeft + x) * scaleX;
    y = frameRect.top + (frame.clientTop + y) * scaleY;
    width *= scaleX;
    height *= scaleY;
    currentWindow = frame.ownerDocument?.defaultView;
  }
  const globalRect = { left: x, top: y, right: x + width, bottom: y + height, width, height };
  cache?.globalRects.set(element, globalRect);
  return globalRect;
}

function getElementStyle(element) {
  const cache = assistantPageState.collectionCache;
  if (cache?.styles.has(element)) {
    cache.cacheHits.style += 1;
    return cache.styles.get(element);
  }
  const style = (element.ownerDocument?.defaultView || window).getComputedStyle(element);
  cache?.styles.set(element, style);
  return style;
}

function getElementRect(element) {
  const cache = assistantPageState.collectionCache;
  if (cache?.rects.has(element)) {
    cache.cacheHits.rect += 1;
    return cache.rects.get(element);
  }
  const rect = element.getBoundingClientRect();
  cache?.rects.set(element, rect);
  return rect;
}

function isDomInstance(element, constructorName) {
  const Constructor = element?.ownerDocument?.defaultView?.[constructorName] || globalThis[constructorName];
  return Boolean(Constructor && element instanceof Constructor);
}

function collectInteractiveElements(options) {
  const limit = Math.floor(clampNumber(options?.limit, 1, 500, 80));
  const offset = Math.floor(clampNumber(options?.offset, 0, Number.MAX_SAFE_INTEGER, 0));
  const search = normalizeLocalElementSearch(options?.search || { query: options?.query });
  const searchActive = isLocalElementSearchActive(search);
  const redactSensitiveData = options?.redactSensitiveData !== false;
  const seen = new Set();
  const candidates = [];
  const contextCache = new WeakMap();
  const identityPrefilterActive = Boolean(
    searchActive
    && (
      search.roles.length
      || (search.query && search.nearText)
    )
  );
  let potentialCandidateCount = 0;
  for (const [discoveryIndex, rawElement] of queryAllDom("*").entries()) {
    if (!isPotentiallyInteractive(rawElement)) {
      continue;
    }
    const element = canonicalInteractiveCandidate(rawElement);
    if (!element || seen.has(element)) {
      continue;
    }
    potentialCandidateCount += 1;
    if (identityPrefilterActive && !matchesInteractiveSearchIdentity(element, search)) {
      continue;
    }
    const rawHitPoint = findExposedPoint(rawElement);
    if (!rawHitPoint) {
      continue;
    }
    const hitPoint = element === rawElement ? rawHitPoint : findExposedPoint(element);
    if (!hitPoint) {
      continue;
    }
    seen.add(element);
    const searchRecord = searchActive
      ? buildInteractiveSearchRecord(element, contextCache)
      : null;
    const searchMatch = searchActive
      ? scoreInteractiveCandidateForSearch(searchRecord, search)
      : null;
    candidates.push({
      element,
      hitPoint,
      scope: findScopeForElement(element),
      rect: getGlobalRect(element),
      discoveryIndex,
      searchRecord,
      searchMatch
    });
  }

  const matchingCandidates = searchActive
    ? candidates
      .filter((candidate) => candidate.searchMatch?.matched)
      .sort((left, right) => (
        right.searchMatch.score - left.searchMatch.score
        || compareInteractiveCandidatesByVisualPosition(left, right)
      ))
    : candidates.sort(compareInteractiveCandidatesByVisualPosition);
  const includedCandidates = matchingCandidates.slice(offset, offset + limit);
  const elements = includedCandidates.map((candidate, index) => {
    const { element } = candidate;
    const ref = getOrCreateElementRef(element, "e");
    const info = describeInteractiveElement(element, ref, {
      redactSensitiveData,
      scope: candidate.scope,
      hitPoint: candidate.hitPoint,
      rect: candidate.rect
    });
    info.binding = createElementBinding(element);
    info.stateBinding = createElementStateBinding(element);
    if (searchActive) {
      info.searchMatch = buildPublicSearchMatch(candidate, redactSensitiveData);
    }
    assistantPageState.elementsByRef.set(ref, {
      element,
      selector: info.selector,
      label: info.label,
      binding: info.binding,
      stateBinding: info.stateBinding
    });
    return info;
  });

  return {
    elements,
    stats: {
      total: matchingCandidates.length,
      availableTotal: identityPrefilterActive ? null : candidates.length,
      potentialTotal: potentialCandidateCount,
      identityPrefilterApplied: identityPrefilterActive,
      included: elements.length,
      offset,
      query: search.query,
      search,
      orderDigest: digestInteractiveCandidateOrder(matchingCandidates),
      truncated: offset + elements.length < matchingCandidates.length
    }
  };
}

function matchesInteractiveSearchIdentity(element, search) {
  const record = buildInteractiveSearchRecord(element, new WeakMap(), {
    includeContext: false
  });
  const roleValues = new Set([
    record.normalizedFields.role,
    record.normalizedFields.tag,
    record.normalizedFields.type
  ].filter(Boolean));
  if (
    search.roles.length
    && !search.roles.some((role) => roleValues.has(normalizeSearchText(role)))
  ) {
    return false;
  }
  if (!search.query) {
    return true;
  }
  return scoreSearchTerms(search.query, record, {
    label: 360,
    role: 180,
    tag: 120,
    type: 150,
    name: 170,
    placeholder: 220,
    title: 220,
    description: 180,
    testId: 130,
    context: 0
  }).matched;
}

function digestInteractiveCandidateOrder(candidates) {
  const source = (candidates || []).map((candidate) => [
    candidate.discoveryIndex,
    candidate.element.tagName?.toLowerCase() || "",
    getAccessibleName(candidate.element),
    Math.round(candidate.rect.left),
    Math.round(candidate.rect.top),
    Math.round(candidate.rect.width),
    Math.round(candidate.rect.height),
    Math.round(candidate.searchMatch?.score || 0)
  ]);
  let hash = 2166136261;
  const text = JSON.stringify(source);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeLocalElementSearch(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    query: normalizeWhitespace(source.query || "").slice(0, 500),
    roles: Array.from(new Set(
      (Array.isArray(source.roles) ? source.roles : [])
        .map((role) => normalizeSearchText(role).slice(0, 80))
        .filter(Boolean)
    )).slice(0, 12),
    nearText: normalizeWhitespace(source.nearText ?? source.near_text ?? "").slice(0, 500)
  };
}

function isLocalElementSearchActive(search) {
  return Boolean(search.query || search.nearText || search.roles.length);
}

function buildInteractiveSearchRecord(element, contextCache, options = {}) {
  const tag = element.tagName?.toLowerCase() || "";
  const inputType = tag === "input" ? String(element.type || "").toLowerCase() : "";
  const controlType = "type" in element
    ? String(element.getAttribute("type") || element.type || "").toLowerCase()
    : "";
  const role = normalizeSearchText(element.getAttribute("role") || inferredRole(element, inputType));
  const fields = {
    label: getAccessibleName(element),
    role,
    tag,
    type: inputType || controlType,
    name: element.getAttribute("name") || "",
    placeholder: element.getAttribute("placeholder") || "",
    title: element.getAttribute("title") || "",
    description: element.getAttribute("aria-description") || "",
    testId: element.getAttribute("data-testid")
      || element.getAttribute("data-test")
      || element.getAttribute("data-cy")
      || ""
  };
  const contextParts = options.includeContext === false
    ? []
    : collectInteractiveSearchContext(element, contextCache);
  return {
    fields,
    normalizedFields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, normalizeSearchText(value)])
    ),
    contextParts,
    normalizedContext: normalizeSearchText(contextParts.map((part) => part.text).join(" "))
  };
}

function collectInteractiveSearchContext(element, contextCache) {
  const parts = [];
  const seenText = new Set();
  const append = (kind, source, maxChars, options = {}) => {
    if (!source) {
      return;
    }
    let text = contextCache.get(source)?.[options.cacheKey || kind];
    if (text === undefined) {
      text = options.accessibleOnly
        ? getSemanticContainerName(source)
        : collectVisibleTextWithin(source, options.rejectTruncated ? maxChars + 1 : maxChars);
      const cached = contextCache.get(source) || {};
      cached[options.cacheKey || kind] = text;
      contextCache.set(source, cached);
    }
    const completeText = normalizeWhitespace(text);
    if (options.rejectTruncated && completeText.length > maxChars) {
      return;
    }
    const normalized = completeText.slice(0, maxChars);
    const key = normalizeSearchText(normalized);
    if (!normalized || seenText.has(key)) {
      return;
    }
    seenText.add(key);
    parts.push({ kind, text: normalized });
  };

  const cell = element.closest?.("td,th,[role='cell'],[role='gridcell'],[role='columnheader'],[role='rowheader']");
  const row = element.closest?.("tr,[role='row']");
  const semanticContainer = element.closest?.(
    "fieldset,form,[role='dialog'],[role='region'],[role='group'],[role='tabpanel'],nav,section,main,aside,article"
  );
  const collection = element.closest?.("table,[role='table'],[role='grid'],[role='tree'],[role='listbox'],[role='menu']");

  let ancestor = element.parentElement;
  for (let depth = 1; ancestor && depth <= 5; depth += 1) {
    const tag = ancestor.tagName?.toLowerCase() || "";
    if (["html", "body"].includes(tag)) {
      break;
    }
    append(`ancestor-${depth}`, ancestor, 520, {
      cacheKey: "bounded-visible-520",
      rejectTruncated: true
    });
    ancestor = ancestor.parentElement;
  }

  append("cell", cell, 240, { cacheKey: "visible-240" });
  append("row", row, 560, { cacheKey: "visible-560" });
  const heading = findNearestContextHeading(element, semanticContainer);
  append("heading", heading, 220, { cacheKey: "visible-220" });
  append("collection", collection, 260, { cacheKey: "semantic", accessibleOnly: true });
  append("region", semanticContainer, 260, { cacheKey: "semantic", accessibleOnly: true });
  return parts.slice(0, 9);
}

function getSemanticContainerName(element) {
  if (!element) {
    return "";
  }
  const tag = element.tagName?.toLowerCase() || "";
  const caption = tag === "table"
    ? element.querySelector?.(":scope > caption")
    : tag === "fieldset"
      ? element.querySelector?.(":scope > legend")
      : null;
  const heading = element.querySelector?.(
    ":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6"
  );
  const labelledBy = String(element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .map((id) => element.getRootNode?.().getElementById?.(id)?.textContent || element.ownerDocument?.getElementById(id)?.textContent || "")
    .join(" ");
  return normalizeWhitespace([
    element.getAttribute("aria-label"),
    labelledBy,
    element.getAttribute("title"),
    caption ? getAccessibleName(caption) : "",
    collectVisibleTextWithin(heading, 180)
  ].filter(Boolean).join(" "));
}

function findNearestContextHeading(element, container) {
  if (!container || !element) {
    return null;
  }
  const headings = Array.from(container.querySelectorAll?.("h1,h2,h3,h4,h5,h6,[role='heading']") || [])
    .filter((heading) => isElementVisuallyExposed(heading));
  if (!headings.length) {
    return null;
  }
  const elementRect = getElementRect(element);
  const preceding = headings
    .filter((heading) => getElementRect(heading).top <= elementRect.top + 1)
    .sort((left, right) => getElementRect(right).top - getElementRect(left).top);
  return preceding[0] || headings[0];
}

function scoreInteractiveCandidateForSearch(record, search) {
  if (!record) {
    return { matched: false, score: 0, matchedFields: [], contextSnippet: "" };
  }
  const roleValues = new Set([
    record.normalizedFields.role,
    record.normalizedFields.tag,
    record.normalizedFields.type
  ].filter(Boolean));
  const roleMatched = !search.roles.length || search.roles.some((role) => roleValues.has(normalizeSearchText(role)));
  if (!roleMatched) {
    return { matched: false, score: 0, matchedFields: [], contextSnippet: "" };
  }

  const queryMatch = scoreSearchTerms(search.query, record, {
    label: 360,
    role: 180,
    tag: 120,
    type: 150,
    name: 170,
    placeholder: 220,
    title: 220,
    description: 180,
    testId: 130,
    context: 0,
    contextByKind: {}
  });
  if (search.query && !queryMatch.matched) {
    return { matched: false, score: 0, matchedFields: [], contextSnippet: "" };
  }

  const nearMatch = scoreSearchTerms(search.nearText, record, {
    label: 35,
    role: 15,
    tag: 10,
    type: 10,
    name: 15,
    placeholder: 25,
    title: 35,
    description: 35,
    testId: 10,
    context: 80,
    contextByKind: {
      "ancestor-1": 520,
      "ancestor-2": 440,
      cell: 400,
      "ancestor-3": 330,
      row: 260,
      "ancestor-4": 210,
      heading: 160,
      "ancestor-5": 130,
      collection: 100,
      region: 80
    }
  });
  if (search.nearText && !nearMatch.matched) {
    return { matched: false, score: 0, matchedFields: [], contextSnippet: "" };
  }

  const matchedFields = Array.from(new Set([
    ...(search.roles.length ? ["role"] : []),
    ...queryMatch.matchedFields,
    ...nearMatch.matchedFields
  ]));
  const contextSnippet = findBestSearchContextSnippet(record, [
    search.nearText,
    search.query
  ]);
  return {
    matched: true,
    score: (search.roles.length ? 120 : 0) + queryMatch.score + nearMatch.score,
    matchedFields,
    contextSnippet
  };
}

function scoreSearchTerms(value, record, weights) {
  const normalizedQuery = normalizeSearchText(value);
  if (!normalizedQuery) {
    return { matched: true, score: 0, matchedFields: [] };
  }
  const tokens = tokenizeSearchText(normalizedQuery);
  const matchedFields = [];
  const matchedTokens = new Set();
  let score = 0;
  for (const [field, fieldValue] of Object.entries(record.normalizedFields || {})) {
    if (!fieldValue) {
      continue;
    }
    const weight = Number(weights[field] || 0);
    if (!weight) {
      continue;
    }
    const fieldMatch = scoreSearchField(normalizedQuery, tokens, fieldValue, weight);
    if (fieldMatch.score) {
      matchedFields.push(field);
      score += fieldMatch.score;
      fieldMatch.matchedTokens.forEach((token) => matchedTokens.add(token));
    }
  }

  const contextParts = Array.isArray(record.contextParts) && record.contextParts.length
    ? record.contextParts
    : record.normalizedContext
      ? [{ kind: "context", text: record.normalizedContext }]
      : [];
  const contextMatches = contextParts
    .map((part, partIndex) => {
      const kind = String(part?.kind || "context");
      const fieldValue = normalizeSearchText(part?.text || "");
      const weight = Number(weights.contextByKind?.[kind] ?? weights.context ?? 0);
      const match = fieldValue && weight
        ? scoreSearchField(normalizedQuery, tokens, fieldValue, weight)
        : { score: 0, matchedTokens: [] };
      return { ...match, partIndex };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.partIndex - right.partIndex)[0];
  if (contextMatches) {
    matchedFields.push("context");
    score += contextMatches.score;
    contextMatches.matchedTokens.forEach((token) => matchedTokens.add(token));
  }

  const requiredTokenMatches = tokens.length > 2 ? Math.ceil(tokens.length / 2) : 1;
  const matched = score > 0 && matchedTokens.size >= requiredTokenMatches;
  return {
    matched,
    score: matched ? score : 0,
    matchedFields: matched ? matchedFields : []
  };
}

function scoreSearchField(normalizedQuery, tokens, fieldValue, weight) {
  let score = 0;
  if (fieldValue === normalizedQuery) {
    score += weight * 3;
  } else if (fieldValue.includes(normalizedQuery) || normalizedQuery.includes(fieldValue)) {
    score += weight * 2;
  }
  const matchedTokens = [];
  for (const token of tokens) {
    if (fieldValue.includes(token)) {
      matchedTokens.push(token);
      score += weight + Math.min(60, token.length * 6);
    }
  }
  return { score, matchedTokens };
}

function findBestSearchContextSnippet(record, searchValues) {
  const queries = searchValues
    .map(normalizeSearchText)
    .filter(Boolean);
  const rankedParts = record.contextParts.map((part, partIndex) => {
    const text = normalizeSearchText(part.text);
    let score = 0;
    for (const [queryIndex, query] of queries.entries()) {
      const priority = queries.length - queryIndex;
      const tokens = tokenizeSearchText(query);
      const matchedTokens = tokens.filter((token) => text.includes(token));
      if (text.includes(query)) {
        score += priority * 1000;
      }
      if (tokens.length) {
        score += priority * Math.round((matchedTokens.length / tokens.length) * 100);
      }
    }
    return { part, partIndex, score };
  });
  const matchingPart = rankedParts
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.partIndex - right.partIndex)[0]
    ?.part || record.contextParts[0];
  return matchingPart ? `${matchingPart.kind}: ${matchingPart.text}` : "";
}

function buildPublicSearchMatch(candidate, redactSensitiveData) {
  const snippet = candidate.searchMatch?.contextSnippet || "";
  return removeEmptyValues({
    score: Math.round(candidate.searchMatch?.score || 0),
    matchedFields: candidate.searchMatch?.matchedFields || [],
    contextSnippet: truncate(
      redactSensitiveData ? redactSensitiveText(snippet) : snippet,
      360
    )
  });
}

function normalizeSearchText(value) {
  return normalizeWhitespace(value).toLocaleLowerCase();
}

function tokenizeSearchText(value) {
  const normalized = normalizeSearchText(value);
  const words = normalized.match(/[\p{L}\p{N}_-]+|[^\p{L}\p{N}\s]/gu) || [];
  return Array.from(new Set(words.filter((token) => token.length > 0))).slice(0, 32);
}

function compareInteractiveCandidatesByVisualPosition(left, right) {
  const topDifference = left.rect.top - right.rect.top;
  if (Math.abs(topDifference) > 1) {
    return topDifference;
  }
  const leftDifference = left.rect.left - right.rect.left;
  if (Math.abs(leftDifference) > 1) {
    return leftDifference;
  }
  return left.discoveryIndex - right.discoveryIndex;
}

function isPotentiallyInteractive(element) {
  const tag = element.tagName?.toLowerCase() || "";
  if (!tag || ["html", "body"].includes(tag) || shouldSkipElement(element) || isVisualSurfaceElement(element)) {
    return false;
  }

  if (hasStrongInteractionSignal(element)) {
    return true;
  }

  const ownerWindow = element.ownerDocument?.defaultView || window;
  const rect = getElementRect(element);
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= ownerWindow.innerHeight ||
    rect.left >= ownerWindow.innerWidth
  ) {
    return false;
  }
  return getElementStyle(element).cursor === "pointer" && hasActionDescriptor(element);
}

function hasStrongInteractionSignal(element) {
  const tag = element.tagName?.toLowerCase() || "";

  if (["a", "area"].includes(tag) && hasElementHref(element)) {
    return true;
  }
  if (tag === "label") {
    return Boolean(element.htmlFor || element.querySelector?.("input,textarea,select,button"));
  }
  if (["audio", "video"].includes(tag) && !element.hasAttribute("controls")) {
    return false;
  }
  if (NATIVE_INTERACTIVE_TAGS.has(tag) && !["a", "area"].includes(tag)) {
    return String(element.getAttribute("type") || "").toLowerCase() !== "hidden";
  }

  const role = String(element.getAttribute("role") || "").trim().toLowerCase();
  if (INTERACTIVE_ROLES.has(role)) {
    return true;
  }
  if (element.isContentEditable || element.tabIndex >= 0) {
    return true;
  }
  if (
    typeof element.onclick === "function" ||
    element.hasAttribute("onclick") ||
    element.draggable ||
    element.hasAttribute("aria-haspopup") ||
    element.hasAttribute("aria-expanded") ||
    element.hasAttribute("aria-pressed") ||
    element.hasAttribute("aria-checked")
  ) {
    return true;
  }
  return false;
}

function hasElementHref(element) {
  return Boolean(
    element.hasAttribute?.("href")
    || element.hasAttribute?.("xlink:href")
    || String(element.href?.baseVal || "").trim()
  );
}

function readElementHref(element) {
  const raw = typeof element.href === "string"
    ? element.href
    : element.href?.baseVal
      || element.getAttribute?.("href")
      || element.getAttribute?.("xlink:href")
      || "";
  try {
    return raw ? new URL(String(raw), element.ownerDocument?.baseURI || location.href).href : "";
  } catch {
    return String(raw || "");
  }
}

function canonicalInteractiveCandidate(element) {
  if (element.tagName?.toLowerCase() === "label" && element.control && isElementVisuallyExposed(element.control)) {
    return element.control;
  }
  if (hasStrongInteractionSignal(element)) {
    return element;
  }

  let ancestor = getLocalComposedParentElement(element);
  while (ancestor?.ownerDocument === element.ownerDocument) {
    if (hasStrongInteractionSignal(ancestor)) {
      return ancestor;
    }
    ancestor = getLocalComposedParentElement(ancestor);
  }

  const ownerWindow = element.ownerDocument?.defaultView || window;
  const hasPointerChild = Array.from(element.children || []).some((child) => (
    !shouldSkipElement(child) &&
    getElementStyle(child).cursor === "pointer" &&
    hasActionDescriptor(child)
  ));
  return hasPointerChild ? null : element;
}

function findConcreteCompositeControl(element) {
  const role = String(element.getAttribute?.("role") || "").trim().toLowerCase();
  if (!["menuitem", "treeitem"].includes(role)) {
    return null;
  }
  const controls = Array.from(element.querySelectorAll?.(
    "a[href],area[href],button,input:not([type='hidden']),select,textarea,[role='link'],[role='button']"
  ) || []).filter((candidate) => {
    const style = getElementStyle(candidate);
    return (
      candidate !== element
      && hasStrongInteractionSignal(candidate)
      && !shouldSkipElement(candidate)
      && style.display !== "none"
      && !["hidden", "collapse"].includes(style.visibility)
      && clampNumber(style.opacity, 0, 1, 1) > 0.01
    );
  });
  if (controls.length !== 1) {
    return null;
  }
  const parentLabel = normalizeWhitespace(getAccessibleName(element));
  const controlLabel = normalizeWhitespace(
    getAccessibleName(controls[0])
    || controls[0].innerText
    || controls[0].textContent
  );
  if (
    !controlLabel
    || !findExposedPoint(element)
    || (
      parentLabel
      && parentLabel !== controlLabel
      && !parentLabel.includes(controlLabel)
    )
  ) {
    return null;
  }
  return controls[0];
}

function hasActionDescriptor(element) {
  if (
    element.hasAttribute("aria-label") ||
    element.hasAttribute("title") ||
    element.hasAttribute("data-testid") ||
    element.hasAttribute("data-test") ||
    element.hasAttribute("data-cy")
  ) {
    return true;
  }
  return Boolean(normalizeWhitespace(element.innerText || element.textContent || ""));
}

function describeInteractiveElement(element, ref, options = {}) {
  const tag = element.tagName.toLowerCase();
  const compositeControl = findConcreteCompositeControl(element);
  const actionControl = compositeControl || element;
  const actionTag = actionControl.tagName?.toLowerCase() || tag;
  const rect = options.rect || getGlobalRect(element);
  const inputType = tag === "input" ? String(element.getAttribute("type") || "text").toLowerCase() : "";
  const controlType = "type" in element ? String(element.getAttribute("type") || element.type || "").toLowerCase() : "";
  const rawValue = readElementValue(element, inputType);
  const value = options.redactSensitiveData ? redactSensitiveValue(rawValue, element, inputType) : rawValue;
  const href = ["a", "area"].includes(actionTag) ? readElementHref(actionControl) : "";
  const formAction = readFormAction(actionControl);
  const form = isDomInstance(actionControl, "HTMLFormElement")
    ? actionControl
    : actionControl.form || actionControl.closest?.("form");
  const autocomplete = element.getAttribute("autocomplete") || "";
  const accessibleName = getAccessibleName(element);
  const label = options.redactSensitiveData ? redactSensitiveText(accessibleName) : accessibleName;

  return removeEmptyValues({
    ref,
    scope: options.scope?.id || "top",
    tag,
    role: element.getAttribute("role") || inferredRole(element, inputType),
    activationTag: compositeControl ? actionTag : undefined,
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
    ariaDisabled: element.getAttribute("aria-disabled") === "true" || undefined,
    ariaHasPopup: element.getAttribute("aria-haspopup") || undefined,
    ariaExpanded: element.hasAttribute("aria-expanded")
      ? element.getAttribute("aria-expanded")
      : undefined,
    actionability: ("disabled" in element && element.disabled) || element.getAttribute("aria-disabled") === "true"
      ? "disabled"
      : "interactive",
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
    optionsSource: isDomInstance(element, "HTMLSelectElement")
      ? "control-metadata-not-necessarily-visible"
      : undefined,
    selector: buildCssSelector(element),
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    hitPoint: options.hitPoint
      ? { x: Math.round(options.hitPoint.globalX), y: Math.round(options.hitPoint.globalY) }
      : undefined
  });
}

function createElementBinding(element) {
  if (!element?.tagName) {
    return "";
  }
  const existing = assistantPageState.elementBindings.get(element);
  if (existing) {
    return existing;
  }
  const binding = createOpaqueElementToken("binding");
  assistantPageState.elementBindings.set(element, binding);
  return binding;
}

function createElementStateBinding(element) {
  if (!element?.tagName) {
    return "";
  }
  const tag = element.tagName.toLowerCase();
  const inputType = tag === "input"
    ? String(element.getAttribute("type") || "text").toLowerCase()
    : "";
  const compositeControl = findConcreteCompositeControl(element);
  const actionControl = compositeControl || element;
  const form = isDomInstance(actionControl, "HTMLFormElement")
    ? actionControl
    : actionControl.form || actionControl.closest?.("form");
  const signature = JSON.stringify({
    tag,
    role: element.getAttribute("role") || inferredRole(element, inputType),
    type: inputType || ("type" in element ? String(element.type || "").toLowerCase() : ""),
    name: element.getAttribute("name") || "",
    accessibleName: getAccessibleName(element),
    activationTag: compositeControl?.tagName?.toLowerCase() || "",
    href: ["a", "area"].includes(actionControl.tagName?.toLowerCase())
      ? readElementHref(actionControl)
      : "",
    formAction: readFormAction(actionControl),
    formMethod: form ? String(form.method || "get").toLowerCase() : "",
    disabled: "disabled" in element ? Boolean(element.disabled) : false,
    ariaDisabled: element.getAttribute("aria-disabled") === "true",
    readOnly: "readOnly" in element ? Boolean(element.readOnly) : false,
    checked: "checked" in element ? Boolean(element.checked) : null,
    value: "value" in element ? String(element.value ?? "") : "",
    ariaExpanded: element.getAttribute("aria-expanded") || "",
    ariaSelected: element.getAttribute("aria-selected") || "",
    options: isDomInstance(element, "HTMLSelectElement")
      ? Array.from(element.options).map((option) => ({
          value: String(option.value ?? ""),
          label: normalizeWhitespace(option.textContent || ""),
          selected: Boolean(option.selected),
          disabled: Boolean(option.disabled)
        }))
      : []
  });
  const existing = assistantPageState.elementStateBindings.get(element);
  if (existing?.signature === signature) {
    return existing.binding;
  }
  const binding = createOpaqueElementToken("state");
  assistantPageState.elementStateBindings.set(element, { signature, binding });
  return binding;
}

function createOpaqueElementToken(kind) {
  const entropy = globalThis.crypto?.randomUUID?.()
    || Array.from(globalThis.crypto?.getRandomValues?.(new Uint32Array(4)) || [
      Date.now(),
      Math.random() * 0xffffffff,
      performance.now() * 1000,
      Math.random() * 0xffffffff
    ]).map((value) => Math.floor(Number(value) || 0).toString(16).padStart(8, "0")).join("");
  return `${kind}-v1-${entropy}`;
}

function collectScrollRegions(limit, redactSensitiveData) {
  const candidates = queryAllDom("*")
    .filter((element) => isScrollableRegion(element) && isElementVisuallyExposed(element))
    .map((element, discoveryIndex) => ({
      element,
      discoveryIndex,
      rect: getGlobalRect(element),
      scope: findScopeForElement(element)
    }))
    .sort(compareInteractiveCandidatesByVisualPosition)
    .slice(0, limit);

  return candidates.map(({ element, rect, scope }, index) => {
    const ref = getOrCreateElementRef(element, "s");
    const labelSource = getAccessibleName(element)
      || collectVisibleTextWithin(element, 180)
      || element.getAttribute("role")
      || element.tagName.toLowerCase();
    const label = redactSensitiveData ? redactSensitiveText(labelSource) : labelSource;
    const region = removeEmptyValues({
      ref,
      scope: scope?.id || "top",
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "region",
      label: truncate(label, 180),
      selector: buildCssSelector(element),
      actionability: "scrollable",
      scrollTop: Math.round(element.scrollTop),
      scrollLeft: Math.round(element.scrollLeft),
      maxScrollTop: Math.max(0, Math.round(element.scrollHeight - element.clientHeight)),
      maxScrollLeft: Math.max(0, Math.round(element.scrollWidth - element.clientWidth)),
      rect: rectToJson(rect)
    });
    region.binding = createElementBinding(element);
    region.stateBinding = createElementStateBinding(element);
    assistantPageState.elementsByRef.set(ref, {
      element,
      selector: region.selector,
      label: region.label,
      binding: region.binding,
      stateBinding: region.stateBinding
    });
    return region;
  });
}

function isScrollableRegion(element) {
  const tag = element.tagName?.toLowerCase() || "";
  if (!tag || ["html", "body"].includes(tag) || shouldSkipElement(element)) {
    return false;
  }
  const ownerWindow = element.ownerDocument?.defaultView || window;
  const style = getElementStyle(element);
  const scrollableY = element.scrollHeight > element.clientHeight + 2
    && ["auto", "scroll", "overlay"].includes(String(style.overflowY || "").toLowerCase());
  const scrollableX = element.scrollWidth > element.clientWidth + 2
    && ["auto", "scroll", "overlay"].includes(String(style.overflowX || "").toLowerCase());
  return scrollableY || scrollableX;
}

function collectVisualSurfaces(limit, redactSensitiveData) {
  const candidates = queryAllDom("canvas,[role='application']")
    .filter((element) => isElementVisuallyExposed(element))
    .map((element, discoveryIndex) => ({
      element,
      discoveryIndex,
      rect: getGlobalRect(element),
      scope: findScopeForElement(element)
    }))
    .sort(compareInteractiveCandidatesByVisualPosition)
    .slice(0, limit);

  return candidates.map(({ element, rect, scope }, index) => {
    const ref = getOrCreateElementRef(element, "v");
    const tag = element.tagName.toLowerCase();
    const labelSource = getAccessibleName(element)
      || element.getAttribute("title")
      || `${tag} visual surface`;
    const label = redactSensitiveData ? redactSensitiveText(labelSource) : labelSource;
    const surface = removeEmptyValues({
      ref,
      scope: scope?.id || "top",
      kind: tag === "canvas" ? "canvas" : "application",
      tag,
      role: element.getAttribute("role") || (tag === "canvas" ? "img" : "application"),
      label: truncate(label, 180),
      selector: buildCssSelector(element),
      actionability: "visual-coordinate-only",
      rect: rectToJson(rect)
    });
    surface.binding = createElementBinding(element);
    surface.stateBinding = createElementStateBinding(element);
    assistantPageState.elementsByRef.set(ref, {
      element,
      selector: surface.selector,
      label: surface.label,
      binding: surface.binding,
      stateBinding: surface.stateBinding
    });
    return surface;
  });
}

function buildLocalAutomationCapabilities({ scrollRegions, visualSurfaces, iframes }) {
  const gaps = [];
  const inaccessibleFrames = (iframes || [])
    .filter((frame) => frame.contentAccess !== "same-origin")
    .map((frame) => ({
      code: "frame_access_required",
      title: frame.title || "Embedded frame",
      src: frame.src || ""
    }));
  if (inaccessibleFrames.length) {
    gaps.push({
      code: "frame_access_required",
      count: inaccessibleFrames.length,
      frames: inaccessibleFrames,
      next: "Grant the embedded frame origins and re-observe before claiming or controlling their contents."
    });
  }
  if ((visualSurfaces || []).length) {
    gaps.push({
      code: "visual_surface",
      count: visualSurfaces.length,
      refs: visualSurfaces.map((surface) => surface.ref),
      next: "Use screenshot-grounded visual targeting only when no DOM control represents the visible target."
    });
  }
  return {
    mode: "dom",
    scrollRegionCount: (scrollRegions || []).length,
    visualSurfaceCount: (visualSurfaces || []).length,
    gaps
  };
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
  if (["a", "area"].includes(tag)) {
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
    .filter((element) => isElementVisuallyExposed(element))
    .slice(0, limit)
    .map((element) => ({
      level: Number(element.getAttribute("aria-level")) || Number(element.tagName.slice(1)) || undefined,
      text: redactContextText(collectVisibleTextWithin(element, 220), 220, redactSensitiveData)
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
    .filter((element) => isElementVisuallyExposed(element))
    .slice(0, limit)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || inferredRole(element, ""),
      label: redactContextText(getAccessibleName(element), 260, redactSensitiveData),
      text: redactContextText(collectVisibleTextWithin(element, 280), 280, redactSensitiveData)
    }))
    .filter((item) => item.label || item.text);
}

function collectForms(limit, redactSensitiveData) {
  return queryAllDom("form")
    .filter((form) => isElementVisuallyExposed(form))
    .slice(0, limit)
    .map((form) => ({
      label: redactContextText(getAccessibleName(form) || form.getAttribute("name") || "", 260, redactSensitiveData),
      action: truncate(sanitizeUrlForContext(form.action || location.href, redactSensitiveData), 220),
      method: String(form.method || "get").toLowerCase(),
      fields: Array.from(form.querySelectorAll("input,textarea,select,button"))
        .filter((element) => isElementVisuallyExposed(element))
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
    .filter((table) => isElementVisuallyExposed(table))
    .slice(0, limit)
    .map((table) => {
      const rows = Array.from(table.rows)
        .filter((row) => isElementVisuallyExposed(row))
        .slice(0, 12);
      return {
        caption: table.caption && isElementVisuallyExposed(table.caption)
          ? redactContextText(collectVisibleTextWithin(table.caption, 220), 220, redactSensitiveData)
          : "",
        headers: Array.from(table.querySelectorAll("th"))
          .filter((cell) => isElementVisuallyExposed(cell))
          .slice(0, 20)
          .map((cell) => redactContextText(collectVisibleTextWithin(cell, 120), 120, redactSensitiveData)),
        rows: rows.map((row) => Array.from(row.cells)
          .filter((cell) => isElementVisuallyExposed(cell))
          .slice(0, 12)
          .map((cell) => redactContextText(collectVisibleTextWithin(cell, 120), 120, redactSensitiveData)))
      };
    });
}

function collectFrameBoundaries(limit, redactSensitiveData) {
  return queryAllDom("iframe,frame")
    .slice(0, limit)
    .map((frameElement, index) => {
      const tag = frameElement.tagName.toLowerCase();
      const visuallyExposed = isElementVisuallyExposed(frameElement);
      const rect = getGlobalRect(frameElement);
      const scaleX = frameElement.offsetWidth ? rect.width / frameElement.offsetWidth : 1;
      const scaleY = frameElement.offsetHeight ? rect.height / frameElement.offsetHeight : 1;
      const declaredSource = frameElement.getAttribute("src")
        || (frameElement.hasAttribute("srcdoc") ? "about:srcdoc" : frameElement.src || "about:blank");
      return removeEmptyValues({
        id: `frame-boundary-${index + 1}`,
        tag,
        name: redactContextText(
          frameElement.getAttribute("name") || "",
          180,
          redactSensitiveData
        ),
        nameDigest: frameElement.getAttribute("name")
          ? hashState(String(frameElement.getAttribute("name")))
          : "",
        nameBinding: frameElement.getAttribute("name") || "",
        src: truncate(sanitizeFrameBoundaryUrl(declaredSource, redactSensitiveData), 220),
        visuallyExposed,
        fullyExposed: visuallyExposed && isElementFullyExposed(frameElement),
        contentAccess: getIframeContentAccess(frameElement),
        title: visuallyExposed
          ? redactContextText(
              frameElement.title
                || frameElement.getAttribute("aria-label")
                || frameElement.getAttribute("name")
                || "",
              260,
              redactSensitiveData
            )
          : undefined,
        rect: visuallyExposed ? rectToJson(rect) : undefined,
        contentRect: visuallyExposed
          ? {
              x: Math.round(rect.left + frameElement.clientLeft * scaleX),
              y: Math.round(rect.top + frameElement.clientTop * scaleY),
              width: Math.round(frameElement.clientWidth * scaleX),
              height: Math.round(frameElement.clientHeight * scaleY)
            }
          : undefined,
        childViewport: visuallyExposed
          ? {
              width: Math.round(frameElement.clientWidth),
              height: Math.round(frameElement.clientHeight)
            }
          : undefined
      });
    });
}

function collectIframes(frameBoundaries, limit) {
  return (frameBoundaries || [])
    .filter((frame) => frame.visuallyExposed)
    .slice(0, limit)
    .map((frame) => removeEmptyValues({
      title: frame.title,
      src: frame.src,
      contentAccess: frame.contentAccess,
      rect: frame.rect
    }));
}

function sanitizeFrameBoundaryUrl(value, redactSensitiveData) {
  const sanitized = sanitizeUrlForContext(value, redactSensitiveData);
  try {
    const url = new URL(sanitized, location.href);
    if (["http:", "https:", "about:"].includes(url.protocol)) {
      return url.toString();
    }
    return url.protocol;
  } catch {
    return String(sanitized || "").split(/[?#]/u)[0];
  }
}

function getIframeContentAccess(iframe) {
  try {
    return iframe.contentDocument?.documentElement ? "same-origin" : "metadata-only";
  } catch {
    return "metadata-only";
  }
}

function isElementFullyExposed(element) {
  if (!isElementBoxRendered(element)) {
    return false;
  }
  const rect = getElementRect(element);
  const visibleRect = clipLocalRectForElement(element, rect);
  if (
    !visibleRect
    || Math.abs(visibleRect.left - rect.left) > 1
    || Math.abs(visibleRect.top - rect.top) > 1
    || Math.abs(visibleRect.right - rect.right) > 1
    || Math.abs(visibleRect.bottom - rect.bottom) > 1
  ) {
    return false;
  }

  const columns = Math.max(2, Math.min(24, Math.ceil(rect.width / 12)));
  const rows = Math.max(2, Math.min(24, Math.ceil(rect.height / 12)));
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = rect.left + rect.width * (column + 0.5) / columns;
      const y = rect.top + rect.height * (row + 0.5) / rows;
      const hitTarget = hitTestForElement(element, x, y);
      if (
        !hitTarget
        || !(hitTarget === element || element.contains(hitTarget))
        || hasPointerTransparentOccluder(element, x, y)
      ) {
        return false;
      }
    }
  }
  return true;
}

function collectPageState(redactSensitiveData) {
  const active = document.activeElement;
  return {
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    domRevision: assistantPageState.domRevision,
    visualRevision: assistantPageState.visualRevision,
    scrollWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
    scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
    activeElement: active && active !== document.body && isElementVisuallyExposed(active)
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
    .filter((element) => isElementVisuallyExposed(element))
    .slice(0, limit)
    .map((element) => ({
      role: element.getAttribute("role") || "",
      ariaLive: element.getAttribute("aria-live") || "",
      label: redactContextText(getAccessibleName(element), 260, redactSensitiveData),
      text: redactContextText(collectVisibleTextWithin(element, 500), 500, redactSensitiveData)
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
    const walker = ownerDocument.createTreeWalker(
      root,
      ownerWindow.NodeFilter.SHOW_ELEMENT | ownerWindow.NodeFilter.SHOW_TEXT,
      {
      acceptNode(node) {
        if (node.nodeType === ownerWindow.Node.ELEMENT_NODE) {
          return shouldSkipElement(node) || isElementSubtreeDefinitelyHidden(node)
            ? ownerWindow.NodeFilter.FILTER_REJECT
            : ownerWindow.NodeFilter.FILTER_SKIP;
        }
        const text = normalizeWhitespace(node.nodeValue || "");
        if (!text) {
          return ownerWindow.NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || shouldSkipElement(parent) || !isTextNodeVisuallyExposed(node)) {
          return ownerWindow.NodeFilter.FILTER_REJECT;
        }
        return ownerWindow.NodeFilter.FILTER_ACCEPT;
      }
      }
    );

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

function collectVisibleTextWithin(element, maxChars) {
  const ownerDocument = element?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView || window;
  if (!ownerDocument || !element || maxChars <= 0) {
    return "";
  }

  const parts = [];
  let length = 0;
  const walker = ownerDocument.createTreeWalker(
    element,
    ownerWindow.NodeFilter.SHOW_ELEMENT | ownerWindow.NodeFilter.SHOW_TEXT,
    {
    acceptNode(node) {
      if (node.nodeType === ownerWindow.Node.ELEMENT_NODE) {
        return shouldSkipElement(node) || isElementSubtreeDefinitelyHidden(node)
          ? ownerWindow.NodeFilter.FILTER_REJECT
          : ownerWindow.NodeFilter.FILTER_SKIP;
      }
      const text = normalizeWhitespace(node.nodeValue || "");
      if (!text || !isTextNodeVisuallyExposed(node)) {
        return ownerWindow.NodeFilter.FILTER_REJECT;
      }
      return ownerWindow.NodeFilter.FILTER_ACCEPT;
    }
    }
  );

  while (walker.nextNode() && length < maxChars) {
    const text = normalizeWhitespace(walker.currentNode.nodeValue || "");
    const remaining = maxChars - length;
    parts.push(text.slice(0, remaining));
    length += text.length + 1;
  }
  return normalizeWhitespace(parts.join("\n"));
}

function isElementSubtreeDefinitelyHidden(element) {
  const style = getElementStyle(element);
  return (
    style.display === "none"
    || style.contentVisibility === "hidden"
    || clampNumber(style.opacity, 0, 1, 1) <= 0.01
  );
}

async function executePageActions(actions, executionBindings = []) {
  if (!Array.isArray(actions)) {
    throw new Error("Actions must be an array.");
  }
  const bindingsByActionId = indexContentExecutionBindings(actions, executionBindings);
  const results = [];
  for (const [index, action] of actions.entries()) {
    const normalized = normalizeAction(action);
    const runtimeBinding = bindingsByActionId.get(String(normalized.id || "")) || null;
    if (runtimeBinding) {
      Object.defineProperty(normalized, "_runtimeBinding", {
        value: runtimeBinding,
        enumerable: false,
        configurable: false,
        writable: false
      });
    }
    try {
      assertRuntimeDocumentBinding(normalized);
      bindResolvedActionTarget(normalized);
      const before = captureActionState(normalized);
      const undo = buildUndoForAction(normalized);
      const result = await executeSingleAction(normalized);
      const after = result?.mayNavigate
        ? null
        : await observeInitialActionState(before, normalized, { allowObservedMutation: true });
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
        error: error.message || String(error),
        code: error.code || "action_failed",
        details: error.details && typeof error.details === "object" ? error.details : null
      });
      break;
    }
    if (index < actions.length - 1) {
      await delay(30);
    }
  }

  return { results };
}

function indexContentExecutionBindings(actions, executionBindings) {
  if (!Array.isArray(executionBindings)) {
    throw new Error("Execution bindings must be an array.");
  }
  const indexed = new Map();
  if (!executionBindings.length) {
    return indexed;
  }
  const actionIds = (actions || []).map((action) => String(action?.id || ""));
  if (
    actionIds.some((actionId) => !actionId)
    || new Set(actionIds).size !== actionIds.length
  ) {
    throw new Error("Every bound action must have a unique action ID.");
  }
  const expectedIds = new Set(actionIds);
  for (const binding of executionBindings) {
    const actionId = String(binding?.actionId || "");
    if (!actionId || indexed.has(actionId) || !expectedIds.has(actionId)) {
      throw new Error("Every execution binding must match exactly one action ID.");
    }
    indexed.set(actionId, binding);
  }
  if (indexed.size !== expectedIds.size) {
    throw new Error("Every action must have an execution binding.");
  }
  return indexed;
}

function assertRuntimeDocumentBinding(action) {
  const runtimeBinding = action?._runtimeBinding || null;
  if (
    runtimeBinding?.documentId
    && runtimeBinding.documentId !== assistantPageState.documentId
  ) {
    throw createContentControlError(
      "stale_target",
      "The observed document changed before the action could execute.",
      {
        expectedDocumentId: runtimeBinding.documentId,
        currentDocumentId: assistantPageState.documentId
      }
    );
  }
}

function bindResolvedActionTarget(action) {
  if (!action || !(action.ref || action.selector || action.text) || action.type === "wait_for") {
    return;
  }
  const element = resolveElement(action);
  Object.defineProperty(action, "_resolvedTarget", {
    value: {
      element,
      binding: createElementBinding(element),
      stateBinding: createElementStateBinding(element)
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
}

async function observeInitialActionState(before, action, options = {}) {
  if (action?.type !== "wait") {
    await waitForRenderOpportunity();
  }
  let after = captureActionState(action, options);
  if (before?.fingerprint !== after.fingerprint || action?.type === "wait") {
    return after;
  }

  const initialSignal = JSON.stringify(readPageSettleSignal());
  const deadline = performance.now() + 220;
  while (performance.now() < deadline) {
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
    if (JSON.stringify(readPageSettleSignal()) === initialSignal) {
      continue;
    }
    after = captureActionState(action, options);
    if (before?.fingerprint !== after.fingerprint) {
      return after;
    }
  }
  return captureActionState(action, options);
}

function waitForRenderOpportunity() {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      window.clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = window.setTimeout(finish, 50);
    window.requestAnimationFrame(finish);
  });
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
      results.push({
        index,
        ok: false,
        type: undo?.type || "undo",
        error: error.message || String(error),
        code: error.code || "undo_failed",
        details: error.details && typeof error.details === "object" ? error.details : null
      });
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
    const target = action.ref || action.selector || action.text ? resolveElement(action) : null;
    if (target && isScrollableRegion(target)) {
      return {
        type: "restoreElementScroll",
        selector: buildCssSelector(target),
        x: target.scrollLeft,
        y: target.scrollTop
      };
    }
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
    window.scrollTo({ left: Number(undo.x) || 0, top: Number(undo.y) || 0, behavior: "auto" });
    return { restoredScroll: true };
  }

  if (undo.type === "restoreElementScroll") {
    const target = undo.selector ? deepQuerySelector(String(undo.selector)) : null;
    if (!target || !isScrollableRegion(target)) {
      throw createContentControlError(
        "scroll_region_missing",
        "The scroll region is no longer available for undo."
      );
    }
    target.scrollTo({ left: Number(undo.x) || 0, top: Number(undo.y) || 0, behavior: "auto" });
    return { restoredElementScroll: true };
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
    case "visual_click":
      return visualClickSurface(action);
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
    case "extract": {
      const extracted = {
        text: collectVisibleText(8000),
        selection: getSelectionText()
      };
      if (isStructuredCollectionAction(action)) {
        extracted.collection = collectStructuredRecords(action);
      }
      return extracted;
    }
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

function isStructuredCollectionAction(action) {
  return Boolean(
    action?._resolvedTarget?.element
    && action.ref
    && normalizeWhitespace(action.collectionId)
    && normalizeWhitespace(action.collectionName)
    && Number.isFinite(Number(action.targetCount))
    && Number(action.targetCount) > 0
  );
}

function collectStructuredRecords(action) {
  const exemplar = resolveElement(action);
  const ownerDocument = exemplar.ownerDocument;
  const collectionId = normalizeWhitespace(action.collectionId);
  const collectionName = normalizeWhitespace(action.collectionName);
  const targetCount = Math.max(1, Math.floor(Number(action.targetCount)));
  const exemplarLink = findCollectionLink(exemplar);
  const linkSource = collectCollectionLinkSource(exemplar, ownerDocument, targetCount);
  const documentLinks = linkSource.links;
  const scanWindow = selectCollectionLinkScanWindow(
    documentLinks,
    exemplarLink,
    targetCount
  );
  const renderedLinks = scanWindow.links
    .map((link) => describeCollectionLink(link))
    .filter((descriptor) => descriptor.url);
  const exemplarDescriptor = exemplarLink
    ? renderedLinks.find((descriptor) => descriptor.element === exemplarLink)
      || describeCollectionLink(exemplarLink)
    : null;
  const shapedLinks = exemplarDescriptor?.url
    ? renderedLinks.filter((descriptor) => collectionUrlsShareShape(
      exemplarDescriptor.url,
      descriptor.url
    ))
    : [];
  const repeatedBoundary = inferRepeatedCollectionBoundary(
    exemplar,
    exemplarDescriptor,
    shapedLinks
  );
  const scopedLinks = repeatedBoundary
    ? shapedLinks.filter((descriptor) => (
      composedElementContains(repeatedBoundary.root, descriptor.element)
    ))
    : shapedLinks;
  const groupedLinks = groupCollectionLinksByUrl(scopedLinks);
  const exemplarGroup = exemplarDescriptor?.url
    ? groupedLinks.find((group) => group.url === exemplarDescriptor.url)
      || groupCollectionLinksByUrl([exemplarDescriptor])[0]
    : null;
  const requiresNumericTitlePair = collectionLinkGroupHasNumericTitlePair(exemplarGroup);
  const exemplarContainer = findCollectionRecordContainer(exemplarGroup, repeatedBoundary);
  const exemplarPath = collectionRelativeElementPath(
    exemplarDescriptor?.element,
    exemplarContainer
  );
  const collectionStrategy = repeatedBoundary
    ? "repeated-container-and-url-shape"
    : exemplarDescriptor?.url
      ? "url-shape"
      : "repeated-container";

  let recordCandidates = groupedLinks
    .filter((group) => (
      !requiresNumericTitlePair
      || collectionLinkGroupHasNumericTitlePair(group)
    ))
    .map((group) => buildCollectionRecord({
      action,
      group,
      repeatedBoundary,
      exemplarPath,
      strategy: collectionStrategy
    }))
    .filter((record) => record.title || record.text || record.context);

  if (!recordCandidates.length) {
    recordCandidates = collectRepeatedContainerRecords({
      action,
      exemplar,
      ownerDocument,
      targetCount
    });
  }

  const seenKeys = new Set();
  const records = recordCandidates
    .filter((record) => {
      if (!record.key || seenKeys.has(record.key)) {
        return false;
      }
      seenKeys.add(record.key);
      return true;
    })
    .slice(0, targetCount);
  const sourceSliceDigest = hashObservationProbe(records.map((record) => record.key));
  const pageIdentity = {
    url: sanitizeUrlForContext(
      String(ownerDocument.location?.href || location.href),
      assistantPageState.redactSensitiveData
    ),
    documentId: assistantPageState.documentId,
    domRevision: assistantPageState.domRevision,
    sourceSliceDigest
  };

  return {
    collectionId,
    collectionName,
    targetCount,
    returnedCount: records.length,
    records,
    pageIdentity,
    scope: "rendered-document",
    sourceSliceDigest,
    provenance: {
      source: "bound-exemplar",
      exemplarRef: String(action.ref),
      strategy: collectionStrategy,
      scanSource: linkSource.source,
      scannedLinkCount: scanWindow.links.length,
      totalRenderedLinkCount: documentLinks.length,
      scanTruncated: scanWindow.truncated,
      matchedLinkCount: scopedLinks.length,
      inferredRecordCount: recordCandidates.length,
      excludedSingleLinkRecords: requiresNumericTitlePair
    }
  };
}

function collectCollectionLinkSource(exemplar, ownerDocument, targetCount) {
  const structuralBoundary = inferStructuralCollectionBoundary(exemplar);
  if (structuralBoundary?.root?.querySelectorAll) {
    const localLinks = Array.from(
      structuralBoundary.root.querySelectorAll("a[href],area[href]")
    ).filter((link) => (
      link.ownerDocument === ownerDocument
      && link.isConnected
      && isElementTreeRendered(link)
    ));
    const distinctUrls = new Set(
      localLinks.map((link) => canonicalizeCollectionUrl(readElementHref(link))).filter(Boolean)
    );
    const minimumDistinctRecords = Math.max(1, Math.min(Number(targetCount) || 1, 4));
    if (distinctUrls.size >= minimumDistinctRecords) {
      return { links: localLinks, source: "repeated-ancestor" };
    }
  }
  return {
    links: queryAllDom("a[href],area[href]")
      .filter((link) => (
        link.ownerDocument === ownerDocument
        && link.isConnected
        && isElementTreeRendered(link)
      )),
    source: "document-fallback"
  };
}

function selectCollectionLinkScanWindow(links, exemplar, targetCount) {
  if (!links.length) {
    return { links: [], truncated: false };
  }
  const desiredSize = Math.min(
    MAX_COLLECTION_LINK_SCAN,
    Math.max(96, Math.ceil(targetCount * 12))
  );
  if (links.length <= desiredSize) {
    return { links, truncated: false };
  }
  const exemplarIndex = Math.max(0, links.indexOf(exemplar));
  const beforeCount = Math.floor(desiredSize / 2);
  let start = Math.max(0, exemplarIndex - beforeCount);
  let end = Math.min(links.length, start + desiredSize);
  start = Math.max(0, end - desiredSize);
  return {
    links: links.slice(start, end),
    truncated: true
  };
}

function findCollectionLink(element) {
  let current = element;
  while (current?.ownerDocument === element?.ownerDocument) {
    if (
      ["a", "area"].includes(current.tagName?.toLowerCase())
      && hasElementHref(current)
      && isElementTreeRendered(current)
    ) {
      return current;
    }
    current = getLocalComposedParentElement(current);
  }
  return Array.from(element?.querySelectorAll?.("a[href],area[href]") || [])
    .find((link) => isElementTreeRendered(link))
    || null;
}

function describeCollectionLink(link) {
  return {
    element: link,
    url: canonicalizeCollectionUrl(readElementHref(link)),
    labels: collectCollectionLinkLabels(link)
  };
}

function canonicalizeCollectionUrl(value) {
  try {
    const parsed = new URL(String(value || ""), location.href);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    parsed.hash = "";
    const sortedParameters = Array.from(parsed.searchParams.entries())
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      ));
    parsed.search = "";
    for (const [key, parameterValue] of sortedParameters) {
      parsed.searchParams.append(key, parameterValue);
    }
    return parsed.href;
  } catch {
    return "";
  }
}

function collectionUrlsShareShape(exemplarValue, candidateValue) {
  let exemplar;
  let candidate;
  try {
    exemplar = new URL(exemplarValue);
    candidate = new URL(candidateValue);
  } catch {
    return exemplarValue === candidateValue;
  }
  if (exemplar.origin !== candidate.origin) {
    return false;
  }

  const exemplarKeys = Array.from(new Set(exemplar.searchParams.keys())).sort();
  const candidateKeys = Array.from(new Set(candidate.searchParams.keys())).sort();
  if (exemplarKeys.length || candidateKeys.length) {
    return (
      exemplar.pathname === candidate.pathname
      && exemplarKeys.length === candidateKeys.length
      && exemplarKeys.every((key, index) => key === candidateKeys[index])
    );
  }
  if (exemplar.pathname === candidate.pathname) {
    return true;
  }

  const exemplarSegments = exemplar.pathname.split("/").filter(Boolean);
  const candidateSegments = candidate.pathname.split("/").filter(Boolean);
  if (exemplarSegments.length !== candidateSegments.length) {
    return false;
  }
  const differingIndexes = exemplarSegments
    .map((segment, index) => segment === candidateSegments[index] ? -1 : index)
    .filter((index) => index >= 0);
  if (differingIndexes.length !== 1) {
    return false;
  }
  const differingIndex = differingIndexes[0];
  const hasStablePathContext = exemplarSegments.some((
    segment,
    index
  ) => index !== differingIndex && segment === candidateSegments[index]);
  return (
    hasStablePathContext
    || (
      isCollectionIdentifierSegment(exemplarSegments[differingIndex])
      && isCollectionIdentifierSegment(candidateSegments[differingIndex])
    )
  );
}

function isCollectionIdentifierSegment(value) {
  const text = String(value || "");
  return (
    /^\d+$/.test(text)
    || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text)
    || /^[0-9a-f]{16,}$/i.test(text)
  );
}

function inferRepeatedCollectionBoundary(exemplar, exemplarDescriptor, shapedLinks) {
  if (!exemplarDescriptor?.url || shapedLinks.length < 2) {
    return inferStructuralCollectionBoundary(exemplar);
  }
  let current = exemplarDescriptor.element;
  const ownerDocument = exemplar.ownerDocument;
  while (
    current
    && current.ownerDocument === ownerDocument
    && current !== ownerDocument.documentElement
  ) {
    const parent = getLocalComposedParentElement(current);
    if (!parent || parent.ownerDocument !== ownerDocument) {
      break;
    }
    const children = Array.from(parent.children || [])
      .filter((child) => isElementTreeRendered(child));
    const matchingChildren = children
      .map((child) => ({
        element: child,
        links: shapedLinks.filter((descriptor) => composedElementContains(
          child,
          descriptor.element
        ))
      }))
      .filter((entry) => entry.links.length);
    const distinctUrls = new Set(
      matchingChildren.flatMap((entry) => entry.links.map((descriptor) => descriptor.url))
    );
    const exemplarContainer = matchingChildren.find((entry) => (
      composedElementContains(entry.element, exemplarDescriptor.element)
    ))?.element;
    if (exemplarContainer && matchingChildren.length >= 2 && distinctUrls.size >= 2) {
      return {
        root: parent,
        exemplarContainer,
        containers: matchingChildren.map((entry) => entry.element),
        strategy: "repeated-url-containers"
      };
    }
    current = parent;
  }
  return inferStructuralCollectionBoundary(exemplar);
}

function inferStructuralCollectionBoundary(exemplar) {
  const ownerDocument = exemplar?.ownerDocument;
  let current = getLocalComposedParentElement(exemplar);
  while (
    current
    && current.ownerDocument === ownerDocument
    && current !== ownerDocument.documentElement
  ) {
    const parent = getLocalComposedParentElement(current);
    if (!parent || parent.ownerDocument !== ownerDocument) {
      break;
    }
    const fingerprint = collectionContainerFingerprint(current);
    const matchingChildren = Array.from(parent.children || []).filter((child) => (
      child !== current
      && isElementTreeRendered(child)
      && collectionContainerFingerprint(child) === fingerprint
      && collectRenderedRecordText(child, 120)
    ));
    if (matchingChildren.length) {
      return {
        root: parent,
        exemplarContainer: current,
        containers: [current, ...matchingChildren],
        strategy: "repeated-structure"
      };
    }
    current = parent;
  }
  return null;
}

function collectionContainerFingerprint(element) {
  const tag = element?.tagName?.toLowerCase() || "";
  const role = normalizeWhitespace(element?.getAttribute?.("role") || "");
  const childTags = Array.from(element?.children || [])
    .slice(0, 12)
    .map((child) => child.tagName?.toLowerCase() || "")
    .join(",");
  const linkCount = Array.from(element?.querySelectorAll?.("a[href],area[href]") || [])
    .filter((link) => isElementTreeRendered(link))
    .length;
  return `${tag}|${role}|${childTags}|${Math.min(linkCount, 3)}`;
}

function composedElementContains(container, element) {
  let current = element;
  while (current) {
    if (current === container) {
      return true;
    }
    current = getLocalComposedParentElement(current);
  }
  return false;
}

function groupCollectionLinksByUrl(descriptors) {
  const groups = new Map();
  for (const descriptor of descriptors) {
    if (!descriptor?.url) {
      continue;
    }
    if (!groups.has(descriptor.url)) {
      groups.set(descriptor.url, {
        url: descriptor.url,
        links: []
      });
    }
    groups.get(descriptor.url).links.push(descriptor);
  }
  return Array.from(groups.values());
}

function collectCollectionLinkLabels(link) {
  const rawText = collectRenderedRecordText(link, 1200);
  const candidates = [
    { value: normalizeWhitespace(link.getAttribute("title") || ""), source: "title", priority: 4 },
    { value: normalizeWhitespace(link.getAttribute("aria-label") || ""), source: "aria-label", priority: 3 },
    { value: rawText, source: "rendered-text", priority: 2 },
    { value: normalizeWhitespace(getAccessibleName(link)), source: "accessible-name", priority: 1 }
  ];
  const seen = new Set();
  return candidates.filter((candidate) => {
    candidate.value = redactCollectionText(candidate.value);
    const identity = `${candidate.source}:${candidate.value}`;
    if (!candidate.value || seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
}

function isNumericCollectionLabel(value) {
  const text = normalizeWhitespace(value);
  return (
    /\p{N}/u.test(text)
    && /^[\p{N}\s.,#()[\]{}:+/_-]+$/u.test(text)
  );
}

function collectionLinkGroupHasNumericTitlePair(group) {
  if (!group?.links?.length || group.links.length < 2) {
    return false;
  }
  return group.links.some((descriptor) => (
    (descriptor.labels || []).some((label) => isNumericCollectionLabel(label.value))
  ));
}

function selectCollectionTitle(group, preferredPath = "") {
  const labels = (group?.links || []).flatMap((descriptor) => {
    const path = collectionRelativeElementPath(
      descriptor.element,
      findCollectionRecordContainer(group, null)
    );
    return (descriptor.labels || []).map((label) => ({
      ...label,
      preferred: Boolean(preferredPath && path === preferredPath),
      relationship: collectionLabelRelationship(label, descriptor.labels)
    }));
  });
  return labels
    .slice()
    .sort((left, right) => {
      const leftDescriptive = isNumericCollectionLabel(left.value) ? 0 : 1;
      const rightDescriptive = isNumericCollectionLabel(right.value) ? 0 : 1;
      return (
        right.relationship - left.relationship
        || rightDescriptive - leftDescriptive
        || Number(right.preferred) - Number(left.preferred)
        || collectionLabelSpecificity(right) - collectionLabelSpecificity(left)
        || right.priority - left.priority
        || right.value.length - left.value.length
      );
    })[0]
    || { value: "", source: "none" };
}

function collectionLabelRelationship(label, siblingLabels) {
  if (label?.source === "rendered-text") {
    return 3;
  }
  const renderedText = (siblingLabels || []).find(
    (candidate) => candidate.source === "rendered-text"
  )?.value || "";
  if (!renderedText) {
    return 1;
  }
  if (
    ["title", "aria-label", "accessible-name"].includes(label?.source)
    && collectionLabelExpandsRenderedText(label.value, renderedText)
  ) {
    return 4;
  }
  return 0;
}

function collectionLabelExpandsRenderedText(candidate, renderedText) {
  const candidateText = normalizeWhitespace(candidate).normalize("NFKC").toLocaleLowerCase();
  const renderedBase = normalizeWhitespace(renderedText)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/(?:\u2026|\.{2,})+\s*$/u, "")
    .trim();
  const candidateTokens = new Set(candidateText.match(/[\p{L}\p{N}]+/gu) || []);
  const renderedTokens = new Set(renderedBase.match(/[\p{L}\p{N}]+/gu) || []);
  const sharedTokenCount = Array.from(renderedTokens).filter(
    (token) => candidateTokens.has(token)
  ).length;
  return Boolean(
    renderedBase.length >= 2
    && candidateText.length > renderedBase.length
    && (
      candidateText.startsWith(renderedBase)
      || (
        sharedTokenCount >= 2
        && sharedTokenCount / Math.max(1, renderedTokens.size) >= 0.5
      )
    )
  );
}

function collectionLabelSpecificity(label) {
  const text = normalizeWhitespace(label?.value || "");
  const lengthScore = Math.min(text.length, 240);
  const wordScore = Math.min(text.split(/\s+/).filter(Boolean).length, 24) * 3;
  return lengthScore + wordScore + Number(label?.priority || 0) * 4;
}

function buildCollectionRecord({
  action,
  group,
  repeatedBoundary,
  exemplarPath,
  strategy
}) {
  const titleDescriptor = selectCollectionTitle(group, exemplarPath);
  const recordContainer = findCollectionRecordContainer(group, repeatedBoundary);
  const context = redactCollectionText(collectRenderedRecordText(recordContainer, 1600));
  const outputUrl = sanitizeUrlForContext(group.url, assistantPageState.redactSensitiveData);
  const key = outputUrl === group.url ? group.url : `url:${hashObservationProbe(group.url)}`;
  return {
    key,
    title: truncate(titleDescriptor.value, 1200),
    url: outputUrl,
    text: truncate(titleDescriptor.value || context, 1600),
    context: truncate(context || titleDescriptor.value, 1600),
    provenance: {
      source: "rendered-document",
      collectionId: normalizeWhitespace(action.collectionId),
      exemplarRef: String(action.ref),
      strategy,
      labelSource: titleDescriptor.source,
      linkCount: group.links.length,
      numericTitlePair: collectionLinkGroupHasNumericTitlePair(group),
      containerTag: recordContainer?.tagName?.toLowerCase() || ""
    }
  };
}

function collectionRelativeElementPath(element, container) {
  if (!element || !container || !composedElementContains(container, element)) {
    return "";
  }
  const parts = [];
  let current = element;
  while (current && current !== container) {
    const parent = getLocalComposedParentElement(current);
    if (!parent) {
      return "";
    }
    const siblings = Array.from(parent.children || []);
    parts.unshift(`${current.tagName?.toLowerCase() || ""}:${siblings.indexOf(current)}`);
    current = parent;
  }
  return current === container ? parts.join("/") : "";
}

function findCollectionRecordContainer(group, repeatedBoundary) {
  const firstLink = group?.links?.[0]?.element;
  if (!firstLink) {
    return null;
  }
  if (repeatedBoundary?.root) {
    const directContainer = Array.from(repeatedBoundary.root.children || [])
      .find((child) => composedElementContains(child, firstLink));
    if (directContainer) {
      return directContainer;
    }
  }
  if (group.links.length > 1) {
    let current = firstLink;
    while (current) {
      if (group.links.every((descriptor) => composedElementContains(current, descriptor.element))) {
        return current;
      }
      current = getLocalComposedParentElement(current);
    }
  }
  return getLocalComposedParentElement(firstLink) || firstLink;
}

function collectRepeatedContainerRecords({
  action,
  exemplar,
  ownerDocument,
  targetCount
}) {
  const boundary = inferStructuralCollectionBoundary(exemplar);
  if (!boundary?.containers?.length) {
    const context = collectRenderedRecordText(exemplar, 1600);
    const title = normalizeWhitespace(
      exemplar.getAttribute?.("title")
      || exemplar.getAttribute?.("aria-label")
      || getAccessibleName(exemplar)
      || context
    );
    if (!title && !context) {
      return [];
    }
    return [buildTextCollectionRecord({
      action,
      element: exemplar,
      title,
      context,
      strategy: "bound-exemplar"
    })];
  }
  return boundary.containers
    .filter((container) => (
      container.ownerDocument === ownerDocument
      && isElementTreeRendered(container)
    ))
    .slice(0, targetCount)
    .map((container) => {
      const link = Array.from(container.querySelectorAll?.("a[href],area[href]") || [])
        .find((candidate) => isElementTreeRendered(candidate));
      const descriptor = link ? describeCollectionLink(link) : null;
      const titleDescriptor = descriptor
        ? selectCollectionTitle({ links: [descriptor] })
        : { value: "", source: "rendered-text" };
      const context = collectRenderedRecordText(container, 1600);
      return buildTextCollectionRecord({
        action,
        element: container,
        title: titleDescriptor.value || context,
        context,
        url: descriptor?.url || "",
        labelSource: titleDescriptor.source,
        strategy: boundary.strategy
      });
    });
}

function buildTextCollectionRecord({
  action,
  element,
  title,
  context,
  url = "",
  labelSource = "rendered-text",
  strategy
}) {
  const normalizedTitle = normalizeWhitespace(title);
  const normalizedContext = redactCollectionText(normalizeWhitespace(context));
  const safeTitle = redactCollectionText(normalizedTitle);
  const outputUrl = sanitizeUrlForContext(url, assistantPageState.redactSensitiveData);
  const key = outputUrl === url && outputUrl
    ? outputUrl
    : url
      ? `url:${hashObservationProbe(url)}`
      : `record:${hashObservationProbe({
    title: normalizedTitle,
    context: normalizedContext
      })}`;
  return {
    key,
    title: truncate(safeTitle, 1200),
    url: outputUrl,
    text: truncate(safeTitle || normalizedContext, 1600),
    context: truncate(normalizedContext || safeTitle, 1600),
    provenance: {
      source: "rendered-document",
      collectionId: normalizeWhitespace(action.collectionId),
      exemplarRef: String(action.ref),
      strategy,
      labelSource,
      linkCount: outputUrl ? 1 : 0,
      numericTitlePair: false,
      containerTag: element?.tagName?.toLowerCase() || ""
    }
  };
}

function redactCollectionText(value) {
  const text = normalizeWhitespace(value);
  return assistantPageState.redactSensitiveData
    ? redactSensitiveText(text)
    : text;
}

function collectRenderedRecordText(element, maxChars) {
  const ownerDocument = element?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView || window;
  if (!element || !ownerDocument || maxChars <= 0 || !isElementTreeRendered(element)) {
    return "";
  }
  const parts = [];
  let length = 0;
  const walker = ownerDocument.createTreeWalker(
    element,
    ownerWindow.NodeFilter.SHOW_ELEMENT | ownerWindow.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === ownerWindow.Node.ELEMENT_NODE) {
          return shouldSkipElement(node) || !isElementTreeRendered(node)
            ? ownerWindow.NodeFilter.FILTER_REJECT
            : ownerWindow.NodeFilter.FILTER_SKIP;
        }
        const text = normalizeWhitespace(node.nodeValue || "");
        const parent = node.parentElement;
        if (!text || !parent || shouldSkipElement(parent) || !isElementTreeRendered(parent)) {
          return ownerWindow.NodeFilter.FILTER_REJECT;
        }
        return ownerWindow.NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  while (walker.nextNode() && length < maxChars) {
    const text = normalizeWhitespace(walker.currentNode.nodeValue || "");
    const remaining = maxChars - length;
    parts.push(text.slice(0, remaining));
    length += text.length + 1;
  }
  return normalizeWhitespace(parts.join(" "));
}

async function waitForCondition(action) {
  let condition;
  try {
    condition = JSON.parse(String(action.conditionJson || ""));
  } catch {
    throw new Error("wait_for conditionJson must be valid JSON.");
  }
  const boundConditionTargets = bindWaitConditionTargets(action, condition);
  const timeoutMs = clampNumber(action.ms, 250, 30000, 10000);
  const startedAt = Date.now();
  const evaluationState = {
    startedAt,
    boundConditionTargets
  };
  let lastResult = evaluateWaitCondition(condition, evaluationState);
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
      try {
        assistantPageState.scopes = collectDomScopes(assistantPageState.includeChildFrames);
        lastResult = evaluateWaitCondition(condition, evaluationState);
        if (lastResult.matched) {
          finish(null, {
            matched: true,
            elapsedMs: Date.now() - startedAt,
            observation: lastResult.observation
          });
        }
      } catch (error) {
        finish(error);
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

function bindWaitConditionTargets(action, condition) {
  const targets = new WeakMap();
  const runtimeBindings = Array.isArray(action?._runtimeBinding?.conditionBindings)
    ? action._runtimeBinding.conditionBindings
    : [];
  const pending = [condition];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const lookup = {
      ref: String(current.ref || ""),
      selector: String(current.selector || ""),
      text: String(current.text || "")
    };
    if (lookup.ref || lookup.selector || lookup.text) {
      const conditionBinding = runtimeBindings.find((binding) => (
        String(binding?.ref || "") === lookup.ref
        && String(binding?.selector || "") === lookup.selector
        && String(binding?.text || "") === lookup.text
      )) || null;
      if (runtimeBindings.length && !conditionBinding) {
        throw createContentControlError(
          "stale_target",
          "A wait condition target is not bound to the current observation."
        );
      }
      const lookupAction = {
        type: "wait_for",
        ...lookup
      };
      if (conditionBinding) {
        Object.defineProperty(lookupAction, "_runtimeBinding", {
          value: conditionBinding,
          enumerable: false
        });
      }
      const element = resolveElement(lookupAction);
      targets.set(current, {
        element,
        binding: createElementBinding(element)
      });
    }
    pending.push(...Object.values(current));
  }
  return targets;
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
    const element = tryResolveWaitElement(condition, state);
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

function tryResolveWaitElement(condition, state) {
  const boundTarget = state?.boundConditionTargets?.get(condition);
  if (boundTarget) {
    const currentBinding = boundTarget.element?.isConnected
      ? createElementBinding(boundTarget.element)
      : "";
    if (!currentBinding || currentBinding !== boundTarget.binding) {
      throw createContentControlError(
        "stale_target",
        "A wait condition element was replaced before the condition completed."
      );
    }
    return boundTarget.element;
  }
  try {
    return resolveElement({
      ref: condition.ref,
      selector: condition.selector,
      text: condition.text,
      type: "wait_for"
    });
  } catch (error) {
    if (error?.code === "stale_target") {
      throw error;
    }
    return null;
  }
}

function readElementState(element, stateName) {
  if (stateName === "visible") {
    return isElementVisuallyExposed(element);
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
  resolveElement(action);
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
  if (isVisualSurfaceElement(element)) {
    throw createContentControlError(
      "visual_action_required",
      "A canvas or application surface requires a screenshot-bound visual action."
    );
  }
  prepareElementForAction(element);
  resolveElement(action);
  assistantPageState.visualOccluderCache = new WeakMap();
  let point = findExposedPoint(element);
  if (!point) {
    throw createContentControlError(
      "target_not_exposed",
      "Resolved target is not exposed to the user or is covered by another element. Re-observe the page before clicking."
    );
  }
  dispatchPointerSequence(element, point, { activate: true });
  resolveElement(action);
  assistantPageState.visualOccluderCache = new WeakMap();
  point = findExposedPoint(element);
  if (!point) {
    throw createContentControlError(
      "stale_target",
      "The target changed or became covered during pointer preparation. Re-observe the page."
    );
  }
  const compositeControl = findConcreteCompositeControl(element);
  const actionControl = compositeControl || element;
  const mayNavigate = actionMayUnloadPage(actionControl);
  const mainWorldActivation = buildMainWorldAnchorActivation(actionControl, point);
  if (mainWorldActivation) {
    return {
      clicked: getAccessibleName(element) || element.tagName.toLowerCase(),
      mayNavigate: false,
      point: { x: Math.round(point.globalX), y: Math.round(point.globalY) },
      inputSequence: "pointer-mouse-click",
      mainWorldActivation
    };
  }
  activateDeepestHitTarget(actionControl, point);
  return {
    clicked: getAccessibleName(element) || element.tagName.toLowerCase(),
    mayNavigate,
    point: { x: Math.round(point.globalX), y: Math.round(point.globalY) },
    inputSequence: "pointer-mouse-click"
  };
}

function buildMainWorldAnchorActivation(element, point) {
  if (
    !isDomInstance(element, "HTMLAnchorElement")
    && !isDomInstance(element, "HTMLAreaElement")
  ) {
    return null;
  }
  const declaredHref = String(element.getAttribute("href") || "").trim();
  if (!/^javascript:/i.test(declaredHref)) {
    return null;
  }
  return {
    selector: buildCssSelector(element),
    declaredHref,
    point: {
      x: Math.round(point.x),
      y: Math.round(point.y)
    }
  };
}

function fillElement(action) {
  const element = resolveElement(action);
  const value = action.value === undefined || action.value === null ? "" : String(action.value);
  prepareElementForAction(element);
  resolveElement(action);

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
  resolveElement(action);

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
  resolveElement(action);
  element.focus();
  return { focused: getAccessibleName(element) || element.tagName.toLowerCase() };
}

function hoverElement(action) {
  const element = resolveElement(action);
  prepareElementForAction(element);
  resolveElement(action);
  assistantPageState.visualOccluderCache = new WeakMap();
  const point = findExposedPoint(element);
  if (!point) {
    throw new Error("Resolved target is not exposed to the user or is covered by another element. Re-observe the page before hovering.");
  }
  dispatchPointerSequence(element, point, { activate: false });
  return {
    hovered: getAccessibleName(element) || element.tagName.toLowerCase(),
    point: { x: Math.round(point.globalX), y: Math.round(point.globalY) }
  };
}

function submitElement(action) {
  const element = resolveElement(action);
  prepareElementForAction(element);
  resolveElement(action);
  const form = isDomInstance(element, "HTMLFormElement") ? element : element.closest("form");
  if (!form) {
    throw new Error("No form found for submit action.");
  }

  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
  } else {
    form.submit();
  }
  return { submitted: true, mayNavigate: true };
}

function pressKey(action) {
  const key = String(action.key || "").trim();
  if (!key) {
    throw new Error("Key is required for press action.");
  }

  const element = action.ref || action.selector || action.text
    ? resolveElement(action)
    : document.activeElement || document.body;
  prepareElementForAction(element);
  if (action.ref || action.selector || action.text) {
    resolveElement(action);
  }

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
    if (action.ref || action.selector || action.text) {
      resolveElement(action);
    }
    element.form.requestSubmit?.();
    return { pressed: key, mayNavigate: true };
  }

  return { pressed: key };
}

function scrollPage(action) {
  if (action.ref || action.selector || action.text) {
    const element = resolveElement(action);
    resolveElement(action);
    if (isScrollableRegion(element)) {
      const direction = String(action.direction || "down").toLowerCase();
      const verticalAmount = clampNumber(
        action.amount,
        40,
        Math.max(40, element.scrollHeight),
        Math.max(40, Math.round(element.clientHeight * 0.75))
      );
      const horizontalAmount = clampNumber(
        action.amount,
        40,
        Math.max(40, element.scrollWidth),
        Math.max(40, Math.round(element.clientWidth * 0.75))
      );
      const vector = {
        up: { top: -verticalAmount, left: 0 },
        down: { top: verticalAmount, left: 0 },
        left: { top: 0, left: -horizontalAmount },
        right: { top: 0, left: horizontalAmount }
      }[direction] || { top: verticalAmount, left: 0 };
      element.scrollBy({ ...vector, behavior: "auto" });
      return {
        target: getAccessibleName(element) || element.tagName.toLowerCase(),
        direction,
        amount: direction === "left" || direction === "right" ? horizontalAmount : verticalAmount,
        scrollTop: Math.round(element.scrollTop),
        scrollLeft: Math.round(element.scrollLeft)
      };
    }
    element.scrollIntoView({
      block: String(action.block || "center"),
      inline: String(action.inline || "nearest"),
      behavior: "auto"
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

  window.scrollBy({ ...vector, behavior: "auto" });
  return { direction, amount };
}

function visualClickSurface(action) {
  const surface = resolveElement(action);
  const tag = surface.tagName?.toLowerCase() || "";
  if (!isVisualSurfaceElement(surface)) {
    throw createContentControlError(
      "visual_surface_changed",
      "The referenced visual surface is no longer a canvas or application surface."
    );
  }
  const xNormalized = Number(action.xNormalized);
  const yNormalized = Number(action.yNormalized);
  if (
    !Number.isFinite(xNormalized)
    || xNormalized < 0
    || xNormalized > 1000
    || !Number.isFinite(yNormalized)
    || yNormalized < 0
    || yNormalized > 1000
  ) {
    throw createContentControlError(
      "visual_coordinate_invalid",
      "Visual coordinates must be normalized numbers from 0 through 1000."
    );
  }
  const visibleRect = clipLocalRectForElement(surface, getElementRect(surface));
  if (!visibleRect) {
    throw createContentControlError(
      "visual_surface_not_exposed",
      "The referenced visual surface is no longer exposed in the current viewport."
    );
  }
  const localRect = getElementRect(surface);
  const x = localRect.left + localRect.width * xNormalized / 1000;
  const y = localRect.top + localRect.height * yNormalized / 1000;
  if (
    x < visibleRect.left
    || x > visibleRect.right
    || y < visibleRect.top
    || y > visibleRect.bottom
  ) {
    throw createContentControlError(
      "visual_coordinate_clipped",
      "The proposed visual point is outside the exposed portion of its surface."
    );
  }
  const root = surface.getRootNode?.() || surface.ownerDocument;
  const hitTarget = typeof root.elementFromPoint === "function"
    ? root.elementFromPoint(x, y)
    : surface.ownerDocument?.elementFromPoint(x, y);
  if (!hitTarget || !(hitTarget === surface || surface.contains(hitTarget))) {
    throw createContentControlError(
      "visual_target_occluded",
      "Another element now covers the proposed visual point. Re-observe the page before acting."
    );
  }
  if (hitTarget !== surface && findInteractiveAncestorWithin(hitTarget, surface)) {
    throw createContentControlError(
      "visual_dom_target_available",
      "The proposed point resolves to a normal DOM control. Re-observe and use its element ref instead."
    );
  }
  if (
    ("disabled" in hitTarget && hitTarget.disabled)
    || hitTarget.getAttribute?.("aria-disabled") === "true"
  ) {
    throw createContentControlError("visual_target_disabled", "The visual target is disabled.");
  }

  const point = {
    x,
    y,
    globalX: x,
    globalY: y,
    hitTarget
  };
  dispatchPointerSequence(surface, point, { activate: true });
  resolveElement(action);
  const ownerWindow = hitTarget.ownerDocument?.defaultView || window;
  hitTarget.dispatchEvent(new ownerWindow.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons: 0,
    view: ownerWindow
  }));
  return {
    clicked: String(action.targetDescription || getAccessibleName(surface) || tag),
    surface: getAccessibleName(surface) || tag,
    point: { x: Math.round(x), y: Math.round(y) },
    normalizedPoint: { x: xNormalized, y: yNormalized },
    inputSequence: "visual-pointer-mouse-click"
  };
}

function isVisualSurfaceElement(element) {
  return Boolean(
    element?.tagName?.toLowerCase() === "canvas"
    || element?.getAttribute?.("role") === "application"
  );
}

function findInteractiveAncestorWithin(element, boundary) {
  let current = element;
  while (current && current !== boundary) {
    if (hasStrongInteractionSignal(current)) {
      return current;
    }
    current = getLocalComposedParentElement(current);
  }
  return null;
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

  location.assign(resolved.href);
  return { url: resolved.href, mayNavigate: true };
}

function resolveElement(action) {
  const runtimeBinding = action?._runtimeBinding || null;
  assertRuntimeDocumentBinding(action);
  if (action?._resolvedTarget) {
    return validateResolvedElementBinding(action, action._resolvedTarget);
  }
  if (action.ref) {
    const found = assistantPageState.elementsByRef.get(String(action.ref));
    const currentBinding = found?.element?.isConnected
      ? createElementBinding(found.element)
      : "";
    const currentStateBinding = found?.element?.isConnected
      ? createElementStateBinding(found.element)
      : "";
    if (
      !found?.element?.isConnected
      || !currentBinding
      || currentBinding !== found.binding
      || (runtimeBinding?.targetBinding && currentBinding !== runtimeBinding.targetBinding)
      || !currentStateBinding
      || currentStateBinding !== found.stateBinding
      || (
        runtimeBinding?.targetStateBinding
        && currentStateBinding !== runtimeBinding.targetStateBinding
      )
    ) {
      throw createContentControlError(
        "stale_target",
        "The observed element reference changed before the action could execute. Re-observe the page.",
        { ref: String(action.ref) }
      );
    }
    return found.element;
  }

  if (action.selector) {
    const selected = deepQuerySelector(String(action.selector));
    if (selected) {
      return validateLookupElementBinding(action, selected, {
        selector: String(action.selector)
      });
    }
  }

  if (action.text) {
    const text = normalizeWhitespace(String(action.text)).toLowerCase();
    const matched = queryAllDom("*")
      .filter((element) => isPotentiallyInteractive(element))
      .filter((element) => isElementVisuallyExposed(element))
      .find((element) => getAccessibleName(element).toLowerCase().includes(text));
    if (matched) {
      return validateLookupElementBinding(action, matched, {
        text: String(action.text)
      });
    }
  }

  throw createContentControlError(
    "element_not_found",
    `Element not found for action: ${action.ref || action.selector || action.text || action.type}`,
    { ref: action.ref || "", selector: action.selector || "", text: action.text || "" }
  );
}

function validateLookupElementBinding(action, element, details = {}) {
  const runtimeBinding = action?._runtimeBinding || null;
  const currentBinding = createElementBinding(element);
  const currentStateBinding = createElementStateBinding(element);
  if (
    (runtimeBinding?.targetBinding && currentBinding !== runtimeBinding.targetBinding)
    || (
      runtimeBinding?.targetStateBinding
      && currentStateBinding !== runtimeBinding.targetStateBinding
    )
  ) {
    throw createContentControlError(
      "stale_target",
      "The lookup now resolves to a different element or element state. Re-observe the page.",
      details
    );
  }
  return element;
}

function validateResolvedElementBinding(action, resolved) {
  const element = resolved?.element || null;
  const currentBinding = element?.isConnected ? createElementBinding(element) : "";
  if (!element?.isConnected || !currentBinding || currentBinding !== resolved.binding) {
    throw createContentControlError(
      "stale_target",
      "The resolved element was replaced before the action completed. Re-observe the page."
    );
  }
  const runtimeBinding = action?._runtimeBinding || null;
  if (runtimeBinding?.targetBinding && currentBinding !== runtimeBinding.targetBinding) {
    throw createContentControlError(
      "stale_target",
      "The resolved element no longer matches the observed target binding."
    );
  }
  if (!action?._allowObservedMutation) {
    const currentStateBinding = createElementStateBinding(element);
    if (
      !currentStateBinding
      || currentStateBinding !== resolved.stateBinding
      || (
        runtimeBinding?.targetStateBinding
        && currentStateBinding !== runtimeBinding.targetStateBinding
      )
    ) {
      throw createContentControlError(
        "stale_target",
        "The resolved element state changed before the action could execute. Re-observe the page."
      );
    }
  }
  return element;
}

function prepareElementForAction(element) {
  if (!element?.ownerDocument || !element?.tagName) {
    throw new Error("Resolved target is not an actionable element.");
  }

  if ("disabled" in element && element.disabled) {
    throw new Error("Resolved target is disabled.");
  }
  if (element.getAttribute("aria-disabled") === "true") {
    throw new Error("Resolved target is aria-disabled.");
  }
  const imageMapGeometry = element.tagName.toLowerCase() === "area"
    ? getImageMapAreaGeometry(element)
    : null;
  const renderedTarget = imageMapGeometry?.image || element;
  if (!isElementBoxRendered(renderedTarget)) {
    throw new Error("Resolved target is not rendered.");
  }

  if (isDomInstance(renderedTarget, "HTMLElement")) {
    renderedTarget.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    element.focus({ preventScroll: true });
  } else {
    renderedTarget.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  }

  highlightElement(element);
}

function dispatchPointerSequence(element, point, options = {}) {
  const ownerWindow = element.ownerDocument?.defaultView || window;
  const target = point.hitTarget || element;
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.globalX,
    screenY: point.globalY,
    button: 0,
    buttons: 0,
    view: ownerWindow
  };

  if (ownerWindow.PointerEvent) {
    for (const type of ["pointerover", "pointerenter", "pointermove", ...(options.activate ? ["pointerdown"] : [])]) {
      target.dispatchEvent(new ownerWindow.PointerEvent(type, {
        ...common,
        bubbles: type !== "pointerenter",
        buttons: type === "pointerdown" ? 1 : 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      }));
    }
  }
  for (const type of ["mouseover", "mouseenter", "mousemove", ...(options.activate ? ["mousedown"] : [])]) {
    target.dispatchEvent(new ownerWindow.MouseEvent(type, {
      ...common,
      bubbles: type !== "mouseenter",
      buttons: type === "mousedown" ? 1 : 0
    }));
  }

  if (!options.activate) {
    return;
  }
  element.focus?.({ preventScroll: true });
  if (ownerWindow.PointerEvent) {
    target.dispatchEvent(new ownerWindow.PointerEvent("pointerup", {
      ...common,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    }));
  }
  target.dispatchEvent(new ownerWindow.MouseEvent("mouseup", common));
}

function activateDeepestHitTarget(element, point) {
  const target = point.hitTarget && (point.hitTarget === element || element.contains(point.hitTarget))
    ? point.hitTarget
    : element;
  if (typeof target.click === "function") {
    target.click();
    return;
  }

  const ownerWindow = target.ownerDocument?.defaultView || window;
  target.dispatchEvent(new ownerWindow.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.globalX,
    screenY: point.globalY,
    button: 0,
    buttons: 0,
    view: ownerWindow
  }));
}

function actionMayUnloadPage(element) {
  if (
    (isDomInstance(element, "HTMLAnchorElement") || isDomInstance(element, "HTMLAreaElement"))
    && readElementHref(element)
  ) {
    const declaredHref = String(element.getAttribute("href") || "").trim();
    if (/^javascript:/i.test(declaredHref) || declaredHref.startsWith("#")) {
      return false;
    }
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

function captureActionState(action, options = {}) {
  const lookupAction = options.allowObservedMutation
    ? Object.assign(Object.create(null), action)
    : action;
  if (options.allowObservedMutation) {
    Object.defineProperty(lookupAction, "_allowObservedMutation", {
      value: true,
      enumerable: false
    });
    if (action?._resolvedTarget) {
      Object.defineProperty(lookupAction, "_resolvedTarget", {
        value: action._resolvedTarget,
        enumerable: false
      });
    }
    if (action?._runtimeBinding) {
      Object.defineProperty(lookupAction, "_runtimeBinding", {
        value: action._runtimeBinding,
        enumerable: false
      });
    }
  }
  let target = null;
  try {
    target = lookupAction.ref || lookupAction.selector || lookupAction.text
      ? resolveElement(lookupAction)
      : null;
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
    visualRevision: assistantPageState.visualRevision,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    target: targetState,
    liveText: collectLiveRegions(8).map((item) => item.text).join("\n"),
    visibleText: collectVisibleText(2000)
  };
  const semanticSnapshot = {
    url: snapshot.url,
    title: snapshot.title,
    scrollX: snapshot.scrollX,
    scrollY: snapshot.scrollY,
    target: snapshot.target,
    liveText: snapshot.liveText,
    visibleText: snapshot.visibleText
  };
  return {
    ...snapshot,
    fingerprint: hashState(semanticSnapshot),
    semanticFingerprint: hashState(semanticSnapshot)
  };
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
  const changed = before?.semanticFingerprint !== after.semanticFingerprint;
  const ambientChanged = Boolean(
    before
    && (
      before.domRevision !== after.domRevision
      || before.visualRevision !== after.visualRevision
    )
  );
  const beforeTarget = summarizeActionTargetTransition(before?.target);
  const afterTarget = summarizeActionTargetTransition(after.target);
  return {
    changed,
    materialChanged: changed,
    ambientChanged,
    indeterminate: !changed && ambientChanged,
    reason: changed
      ? "material observable page state changed"
      : ambientChanged
        ? "only ambient page revisions changed"
        : "no observable page state change",
    beforeFingerprint: before?.fingerprint || "",
    afterFingerprint: after.fingerprint,
    urlChanged: before?.url !== after.url,
    domChanged: before?.domRevision !== after.domRevision,
    targetChanged: JSON.stringify(before?.target || null) !== JSON.stringify(after.target || null),
    valueChanged: before?.target?.value !== after.target?.value,
    beforeTarget,
    afterTarget
  };
}

function summarizeActionTargetTransition(target) {
  if (!target) {
    return null;
  }
  return {
    tag: target.tag || "",
    label: target.label || "",
    checked: target.checked,
    expanded: target.expanded,
    selected: target.selected,
    disabled: target.disabled,
    text: target.text || ""
  };
}

function verifyPageActionEffect(action, beforeFingerprint) {
  const after = captureActionState(normalizeAction(action), { allowObservedMutation: true });
  const changed = Boolean(beforeFingerprint) && beforeFingerprint !== after.fingerprint;
  return {
    changed,
    reason: changed ? "observable page state changed" : "no observable page state change",
    beforeFingerprint: String(beforeFingerprint || ""),
    afterFingerprint: after.fingerprint
  };
}

function observePageMutations() {
  const start = () => {
    if (!document.documentElement) {
      return;
    }
    installVisualRevisionListeners();
    assistantPageState.scopes = collectDomScopes(assistantPageState.includeChildFrames);
    observeDomScopes(assistantPageState.scopes);
  };
  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
}

function installVisualRevisionListeners() {
  if (assistantPageState.visualListenersInstalled) {
    return;
  }
  assistantPageState.visualListenersInstalled = true;
  const markVisualChange = () => {
    assistantPageState.visualRevision += 1;
  };
  window.addEventListener("scroll", markVisualChange, true);
  window.addEventListener("resize", markVisualChange, true);
  window.addEventListener("orientationchange", markVisualChange, true);
  document.addEventListener("animationstart", markVisualChange, true);
  document.addEventListener("animationiteration", markVisualChange, true);
  document.addEventListener("animationend", markVisualChange, true);
  document.addEventListener("transitionrun", markVisualChange, true);
  document.addEventListener("transitionend", markVisualChange, true);
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
  const rect = getGlobalRect(element);
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

  const alt = element.getAttribute("alt");
  if (alt) {
    return truncate(normalizeWhitespace(alt), 260);
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
  for (const name of ["data-testid", "data-test", "data-cy", "name", "aria-label", "placeholder", "title", "alt"]) {
    const value = element.getAttribute(name);
    if (value && value.length <= 90) {
      return { name, value };
    }
  }
  return null;
}

function isElementTreeRendered(element) {
  if (!element?.ownerDocument || !element?.tagName) {
    return false;
  }
  const cache = assistantPageState.collectionCache;
  if (cache?.rendered.has(element)) {
    cache.cacheHits.rendered += 1;
    return cache.rendered.get(element);
  }
  const remember = (value) => {
    cache?.rendered.set(element, value);
    return value;
  };

  let current = element;
  let cumulativeOpacity = 1;
  while (current?.ownerDocument) {
    const style = getElementStyle(current);
    if (
      style.display === "none" ||
      style.contentVisibility === "hidden" ||
      (current === element && ["hidden", "collapse"].includes(style.visibility))
    ) {
      return remember(false);
    }
    cumulativeOpacity *= clampNumber(style.opacity, 0, 1, 1);
    if (cumulativeOpacity <= 0.01) {
      return remember(false);
    }
    current = getComposedParentElement(current);
  }

  return remember(true);
}

function isElementBoxRendered(element) {
  if (!isElementTreeRendered(element)) {
    return false;
  }
  const rect = getElementRect(element);
  return rect.width > 0 && rect.height > 0;
}

function isElementVisuallyExposed(element) {
  return Boolean(findExposedPoint(element));
}

function getImageMapAreaGeometry(area) {
  const cache = assistantPageState.collectionCache;
  if (cache?.imageMapGeometries.has(area)) {
    return cache.imageMapGeometries.get(area);
  }
  const remember = (value) => {
    cache?.imageMapGeometries.set(area, value);
    return value;
  };
  const map = area.closest?.("map");
  const mapName = String(map?.name || map?.id || "").trim();
  if (!mapName || !hasElementHref(area)) {
    return remember(null);
  }
  const normalizedMapName = `#${mapName}`.toLowerCase();
  const image = queryAllDom("img[usemap],input[type='image'][usemap],object[usemap]")
    .find((candidate) => (
      candidate.ownerDocument === area.ownerDocument
      && String(candidate.getAttribute("usemap") || "").trim().toLowerCase() === normalizedMapName
      && isElementBoxRendered(candidate)
    ));
  if (!image) {
    return remember(null);
  }

  const imageRect = getElementRect(image);
  const coordinateWidth = Math.max(1, Number(image.naturalWidth || image.width || image.clientWidth || imageRect.width));
  const coordinateHeight = Math.max(1, Number(image.naturalHeight || image.height || image.clientHeight || imageRect.height));
  const localArea = resolveImageMapShape(
    String(area.shape || area.getAttribute("shape") || "rect").toLowerCase(),
    String(area.coords || area.getAttribute("coords") || ""),
    coordinateWidth,
    coordinateHeight
  );
  if (!localArea) {
    return remember(null);
  }
  const scaleX = imageRect.width / coordinateWidth;
  const scaleY = imageRect.height / coordinateHeight;
  const localRect = {
    left: imageRect.left + localArea.left * scaleX,
    top: imageRect.top + localArea.top * scaleY,
    right: imageRect.left + localArea.right * scaleX,
    bottom: imageRect.top + localArea.bottom * scaleY,
    width: Math.max(0, (localArea.right - localArea.left) * scaleX),
    height: Math.max(0, (localArea.bottom - localArea.top) * scaleY)
  };
  const localPoint = {
    x: imageRect.left + localArea.pointX * scaleX,
    y: imageRect.top + localArea.pointY * scaleY
  };
  const imageGlobalRect = getGlobalRect(image);
  const globalRect = {
    left: imageGlobalRect.left + localArea.left * (imageGlobalRect.width / coordinateWidth),
    top: imageGlobalRect.top + localArea.top * (imageGlobalRect.height / coordinateHeight),
    right: imageGlobalRect.left + localArea.right * (imageGlobalRect.width / coordinateWidth),
    bottom: imageGlobalRect.top + localArea.bottom * (imageGlobalRect.height / coordinateHeight),
    width: Math.max(0, (localArea.right - localArea.left) * (imageGlobalRect.width / coordinateWidth)),
    height: Math.max(0, (localArea.bottom - localArea.top) * (imageGlobalRect.height / coordinateHeight))
  };
  return remember({ image, localRect, localPoint, globalRect });
}

function resolveImageMapShape(shape, coordsSource, width, height) {
  const coords = String(coordsSource || "")
    .split(/[\s,]+/u)
    .map(Number)
    .filter(Number.isFinite);
  if (shape === "default") {
    return { left: 0, top: 0, right: width, bottom: height, pointX: width / 2, pointY: height / 2 };
  }
  if (shape === "circle" && coords.length >= 3) {
    const [centerX, centerY, radius] = coords;
    if (radius <= 0) return null;
    return {
      left: Math.max(0, centerX - radius),
      top: Math.max(0, centerY - radius),
      right: Math.min(width, centerX + radius),
      bottom: Math.min(height, centerY + radius),
      pointX: centerX,
      pointY: centerY
    };
  }
  if (["poly", "polygon"].includes(shape) && coords.length >= 6) {
    const points = [];
    for (let index = 0; index + 1 < coords.length; index += 2) {
      points.push({ x: coords[index], y: coords[index + 1] });
    }
    const left = Math.max(0, Math.min(...points.map((point) => point.x)));
    const top = Math.max(0, Math.min(...points.map((point) => point.y)));
    const right = Math.min(width, Math.max(...points.map((point) => point.x)));
    const bottom = Math.min(height, Math.max(...points.map((point) => point.y)));
    const centroid = {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length
    };
    const fallback = findPointInsidePolygon(points, { left, top, right, bottom });
    const point = isPointInsidePolygon(centroid, points) ? centroid : fallback;
    return point && right > left && bottom > top
      ? { left, top, right, bottom, pointX: point.x, pointY: point.y }
      : null;
  }
  if (coords.length >= 4) {
    const left = Math.max(0, Math.min(coords[0], coords[2]));
    const top = Math.max(0, Math.min(coords[1], coords[3]));
    const right = Math.min(width, Math.max(coords[0], coords[2]));
    const bottom = Math.min(height, Math.max(coords[1], coords[3]));
    return right > left && bottom > top
      ? { left, top, right, bottom, pointX: (left + right) / 2, pointY: (top + bottom) / 2 }
      : null;
  }
  return null;
}

function findPointInsidePolygon(points, bounds) {
  const columns = 7;
  const rows = 7;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const point = {
        x: bounds.left + (bounds.right - bounds.left) * (column + 0.5) / columns,
        y: bounds.top + (bounds.bottom - bounds.top) * (row + 0.5) / rows
      };
      if (isPointInsidePolygon(point, points)) {
        return point;
      }
    }
  }
  return null;
}

function isPointInsidePolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = (
      (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < (
        (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / ((previousPoint.y - currentPoint.y) || Number.EPSILON)
        + currentPoint.x
      )
    );
    if (intersects) inside = !inside;
  }
  return inside;
}

function findImageMapAreaPoint(area) {
  const geometry = getImageMapAreaGeometry(area);
  if (!geometry) {
    return null;
  }
  const visibleRect = clipLocalRectForElement(geometry.image, geometry.localRect, { includeSelf: true });
  if (
    !visibleRect
    || geometry.localPoint.x < visibleRect.left
    || geometry.localPoint.x > visibleRect.right
    || geometry.localPoint.y < visibleRect.top
    || geometry.localPoint.y > visibleRect.bottom
  ) {
    return null;
  }
  const hitTarget = hitTestForElement(geometry.image, geometry.localPoint.x, geometry.localPoint.y);
  if (
    !hitTarget
    || !(
      hitTarget === area
      || hitTarget === geometry.image
      || geometry.image.contains(hitTarget)
    )
    || hasPointerTransparentOccluder(geometry.image, geometry.localPoint.x, geometry.localPoint.y)
  ) {
    return null;
  }
  const framePoint = exposePointThroughFrameChain(
    geometry.image,
    geometry.localPoint.x,
    geometry.localPoint.y
  );
  return framePoint
    ? {
        ...geometry.localPoint,
        ...framePoint,
        hitTarget: hitTarget === area ? area : geometry.image,
        targetRect: geometry.globalRect
      }
    : null;
}

function findExposedPoint(element) {
  const cache = assistantPageState.collectionCache;
  if (cache?.exposedPoints.has(element)) {
    cache.cacheHits.exposedPoint += 1;
    return cache.exposedPoints.get(element);
  }
  const imageMapPoint = element.tagName?.toLowerCase() === "area"
    ? findImageMapAreaPoint(element)
    : null;
  if (imageMapPoint) {
    cache?.exposedPoints.set(element, imageMapPoint);
    return imageMapPoint;
  }
  if (!isElementBoxRendered(element)) {
    cache?.exposedPoints.set(element, null);
    return null;
  }
  const visibleRect = clipLocalRectForElement(element, getElementRect(element));
  if (!visibleRect) {
    cache?.exposedPoints.set(element, null);
    return null;
  }

  for (const point of sampleRectPoints(visibleRect)) {
    const hitTarget = hitTestForElement(element, point.x, point.y);
    if (!hitTarget || !(hitTarget === element || element.contains(hitTarget))) {
      continue;
    }
    if (hasPointerTransparentOccluder(element, point.x, point.y)) {
      continue;
    }
    const framePoint = exposePointThroughFrameChain(element, point.x, point.y);
    if (framePoint) {
      const exposedPoint = { ...point, ...framePoint, hitTarget };
      cache?.exposedPoints.set(element, exposedPoint);
      return exposedPoint;
    }
  }
  cache?.exposedPoints.set(element, null);
  return null;
}

function isTextNodeVisuallyExposed(textNode) {
  const cache = assistantPageState.collectionCache;
  if (cache?.textExposure.has(textNode)) {
    cache.cacheHits.textExposure += 1;
    return cache.textExposure.get(textNode);
  }
  const ownerDocument = textNode.ownerDocument || document;
  const element = textNode.parentElement;
  if (!element || !isElementTreeRendered(element)) {
    cache?.textExposure.set(textNode, false);
    return false;
  }
  const range = ownerDocument.createRange();
  range.selectNodeContents(textNode);
  const rects = Array.from(range.getClientRects());
  range.detach?.();

  const exposed = rects.some((rect) => {
    const visibleRect = clipLocalRectForElement(element, rect, { includeSelf: true });
    if (!visibleRect) {
      return false;
    }
    return sampleRectPoints(visibleRect).some((point) => {
      const hitTarget = hitTestForElement(element, point.x, point.y);
      if (!hitTarget || !(hitTarget === element || element.contains(hitTarget))) {
        return false;
      }
      if (hasPointerTransparentOccluder(element, point.x, point.y, { includeDescendants: true })) {
        return false;
      }
      return Boolean(exposePointThroughFrameChain(element, point.x, point.y));
    });
  });
  cache?.textExposure.set(textNode, exposed);
  return exposed;
}

function clipLocalRectForElement(element, sourceRect, options = {}) {
  const ownerWindow = element.ownerDocument?.defaultView || window;
  let clipped = intersectRects(normalizeRect(sourceRect), {
    left: 0,
    top: 0,
    right: ownerWindow.innerWidth,
    bottom: ownerWindow.innerHeight
  });
  if (!clipped) {
    return null;
  }

  let ancestor = options.includeSelf ? element : getLocalComposedParentElement(element);
  while (ancestor?.ownerDocument === element.ownerDocument) {
    const style = getElementStyle(ancestor);
    const clipsX = clipsOverflow(style.overflowX) || String(style.contain || "").includes("paint");
    const clipsY = clipsOverflow(style.overflowY) || String(style.contain || "").includes("paint");
    const ownerDocument = element.ownerDocument;
    const isViewportScroller = (
      ancestor === ownerDocument.documentElement
      || ancestor === ownerDocument.body
      || ancestor === ownerDocument.scrollingElement
    );
    if ((clipsX || clipsY) && !isViewportScroller) {
      const ancestorRect = normalizeRect(getElementRect(ancestor));
      clipped = intersectRects(clipped, {
        left: clipsX ? ancestorRect.left + ancestor.clientLeft : clipped.left,
        right: clipsX ? ancestorRect.left + ancestor.clientLeft + ancestor.clientWidth : clipped.right,
        top: clipsY ? ancestorRect.top + ancestor.clientTop : clipped.top,
        bottom: clipsY ? ancestorRect.top + ancestor.clientTop + ancestor.clientHeight : clipped.bottom
      });
      if (!clipped) {
        return null;
      }
    }
    ancestor = getLocalComposedParentElement(ancestor);
  }
  return clipped;
}

function getLocalComposedParentElement(element) {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode?.();
  return root?.host || null;
}

function getComposedParentElement(element) {
  const localParent = getLocalComposedParentElement(element);
  if (localParent) {
    return localParent;
  }
  const ownerWindow = element.ownerDocument?.defaultView;
  if (!ownerWindow || ownerWindow === window) {
    return null;
  }
  try {
    return ownerWindow.frameElement || null;
  } catch {
    return null;
  }
}

function clipsOverflow(value) {
  return ["auto", "clip", "hidden", "scroll"].includes(String(value || "").toLowerCase());
}

function normalizeRect(rect) {
  const left = Number(rect?.left) || 0;
  const top = Number(rect?.top) || 0;
  const right = Number.isFinite(Number(rect?.right)) ? Number(rect.right) : left + (Number(rect?.width) || 0);
  const bottom = Number.isFinite(Number(rect?.bottom)) ? Number(rect.bottom) : top + (Number(rect?.height) || 0);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function intersectRects(leftRect, rightRect) {
  const left = Math.max(leftRect.left, rightRect.left);
  const top = Math.max(leftRect.top, rightRect.top);
  const right = Math.min(leftRect.right, rightRect.right);
  const bottom = Math.min(leftRect.bottom, rightRect.bottom);
  if (right - left <= 0.5 || bottom - top <= 0.5) {
    return null;
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function sampleRectPoints(rect) {
  const insetX = Math.min(2, rect.width / 4);
  const insetY = Math.min(2, rect.height / 4);
  const left = rect.left + insetX;
  const right = rect.right - insetX;
  const top = rect.top + insetY;
  const bottom = rect.bottom - insetY;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return [
    { x: centerX, y: centerY },
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: centerX, y: top },
    { x: centerX, y: bottom },
    { x: left, y: centerY },
    { x: right, y: centerY }
  ];
}

function hitTestForElement(element, x, y) {
  const root = element.getRootNode?.();
  if (root && typeof root.elementFromPoint === "function") {
    return root.elementFromPoint(x, y);
  }
  return element.ownerDocument?.elementFromPoint(x, y) || null;
}

function hasPointerTransparentOccluder(target, x, y, options = {}) {
  const root = target.getRootNode?.() || target.ownerDocument;
  for (const occluder of getPointerTransparentOccluders(root)) {
    if (
      occluder === target ||
      occluder.hasAttribute?.("data-my-assistant-overlay") ||
      occluder.contains(target) ||
      (!options.includeDescendants && target.contains(occluder))
    ) {
      continue;
    }
    const rect = getElementRect(occluder);
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      continue;
    }
    if (elementPaintsAtPoint(occluder, x, y) && isPaintedAbove(occluder, target)) {
      return true;
    }
  }
  return false;
}

function getPointerTransparentOccluders(root) {
  const cached = assistantPageState.visualOccluderCache.get(root);
  if (cached?.revision === assistantPageState.domRevision) {
    return cached.elements;
  }

  const elements = [];
  const ownerDocument = root.nodeType === 9 ? root : root.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView || window;
  const scopeElements = getDomScopes().find((scope) => scope.root === root)?.elements;
  for (const element of (
    Array.isArray(scopeElements)
      ? scopeElements
      : Array.from(root.querySelectorAll?.("*") || [])
  )) {
    const rect = getElementRect(element);
    if (
      rect.width <= 0
      || rect.height <= 0
      || rect.bottom <= 0
      || rect.right <= 0
      || rect.top >= ownerWindow.innerHeight
      || rect.left >= ownerWindow.innerWidth
    ) {
      continue;
    }
    const style = getElementStyle(element);
    if (style.pointerEvents !== "none" || !isElementTreeRendered(element) || !elementHasVisualPaint(element, style)) {
      continue;
    }
    elements.push(element);
  }
  assistantPageState.visualOccluderCache.set(root, {
    revision: assistantPageState.domRevision,
    elements
  });
  return elements;
}

function elementHasVisualPaint(element, style) {
  if (backgroundPaints(style) || borderPaints(style)) {
    return true;
  }
  if (["canvas", "img", "picture", "svg", "video"].includes(element.tagName?.toLowerCase())) {
    return true;
  }
  for (const pseudo of ["::before", "::after"]) {
    const pseudoStyle = (element.ownerDocument?.defaultView || window).getComputedStyle(element, pseudo);
    if (
      pseudoStyle.content !== "none" &&
      pseudoStyle.content !== "normal" &&
      (backgroundPaints(pseudoStyle) || borderPaints(pseudoStyle))
    ) {
      return true;
    }
  }
  return Array.from(element.childNodes || []).some((node) => (
    node.nodeType === 3 && Boolean(normalizeWhitespace(node.nodeValue || ""))
  ));
}

function elementPaintsAtPoint(element, x, y) {
  const ownerWindow = element.ownerDocument?.defaultView || window;
  const style = getElementStyle(element);
  if (backgroundPaints(style)) {
    return true;
  }
  if (["canvas", "img", "picture", "svg", "video"].includes(element.tagName?.toLowerCase())) {
    return true;
  }

  const rect = getElementRect(element);
  if (pointTouchesPaintedBorder(style, rect, x, y)) {
    return true;
  }
  for (const node of Array.from(element.childNodes || [])) {
    if (node.nodeType !== 3 || !normalizeWhitespace(node.nodeValue || "")) {
      continue;
    }
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(node);
    const containsPoint = Array.from(range.getClientRects()).some((textRect) => (
      x >= textRect.left && x <= textRect.right && y >= textRect.top && y <= textRect.bottom
    ));
    range.detach?.();
    if (containsPoint) {
      return true;
    }
  }
  for (const pseudo of ["::before", "::after"]) {
    const pseudoStyle = ownerWindow.getComputedStyle(element, pseudo);
    if (
      pseudoStyle.content !== "none" &&
      pseudoStyle.content !== "normal" &&
      (backgroundPaints(pseudoStyle) || borderPaints(pseudoStyle))
    ) {
      return true;
    }
  }
  return false;
}

function backgroundPaints(style) {
  return (
    colorAlpha(style.backgroundColor) > 0.01 ||
    hasNonNoneCssValue(style.backgroundImage) ||
    hasNonNoneCssValue(style.backdropFilter) ||
    hasNonNoneCssValue(style.webkitBackdropFilter)
  );
}

function hasNonNoneCssValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized && normalized !== "none");
}

function borderPaints(style) {
  return ["Top", "Right", "Bottom", "Left"].some((side) => (
    style[`border${side}Style`] !== "none" &&
    Number.parseFloat(style[`border${side}Width`]) > 0 &&
    colorAlpha(style[`border${side}Color`]) > 0.01
  ));
}

function pointTouchesPaintedBorder(style, rect, x, y) {
  const sides = [
    ["Top", y - rect.top],
    ["Right", rect.right - x],
    ["Bottom", rect.bottom - y],
    ["Left", x - rect.left]
  ];
  return sides.some(([side, distance]) => (
    distance >= 0 &&
    distance <= Number.parseFloat(style[`border${side}Width`] || 0) &&
    style[`border${side}Style`] !== "none" &&
    colorAlpha(style[`border${side}Color`]) > 0.01
  ));
}

function colorAlpha(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "transparent") {
    return 0;
  }
  const rgba = normalized.match(/^rgba?\((.*)\)$/);
  if (!rgba) {
    return 1;
  }
  const parts = rgba[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 ? clampNumber(parts[3], 0, 1, 1) : 1;
}

function isPaintedAbove(candidate, target) {
  const candidateContexts = getStackingContextChain(candidate);
  const targetContexts = getStackingContextChain(target);
  let shared = 0;
  while (
    shared < candidateContexts.length &&
    shared < targetContexts.length &&
    candidateContexts[shared].element === targetContexts[shared].element
  ) {
    shared += 1;
  }

  const candidateLayer = candidateContexts[shared] || paintLayer(candidate);
  const targetLayer = targetContexts[shared] || paintLayer(target);
  if (candidateLayer.zIndex !== targetLayer.zIndex) {
    return candidateLayer.zIndex > targetLayer.zIndex;
  }
  if (candidateLayer.layer !== targetLayer.layer) {
    return candidateLayer.layer > targetLayer.layer;
  }

  const candidateAnchor = candidateLayer.element || candidate;
  const targetAnchor = targetLayer.element || target;
  if (candidateAnchor === targetAnchor || candidateAnchor.contains(targetAnchor)) {
    return false;
  }
  if (targetAnchor.contains(candidateAnchor)) {
    return true;
  }
  const position = candidateAnchor.compareDocumentPosition(targetAnchor);
  const preceding = candidateAnchor.ownerDocument?.defaultView?.Node?.DOCUMENT_POSITION_PRECEDING || 2;
  return Boolean(position & preceding);
}

function getStackingContextChain(element) {
  const chain = [];
  let current = element;
  while (current?.ownerDocument) {
    const style = getElementStyle(current);
    if (createsStackingContext(current, style)) {
      chain.unshift(paintLayer(current, style));
    }
    current = getLocalComposedParentElement(current);
  }
  return chain;
}

function createsStackingContext(element, style) {
  const position = style.position;
  const zIndex = style.zIndex;
  const parentDisplay = element.parentElement
    ? getElementStyle(element.parentElement).display
    : "";
  return (
    element === element.ownerDocument.documentElement ||
    ["fixed", "sticky"].includes(position) ||
    (zIndex !== "auto" && (position !== "static" || /^(flex|inline-flex|grid|inline-grid)$/.test(parentDisplay))) ||
    Number(style.opacity) < 1 ||
    hasNonNoneCssValue(style.transform) ||
    hasNonNoneCssValue(style.perspective) ||
    hasNonNoneCssValue(style.filter) ||
    hasNonNoneCssValue(style.backdropFilter) ||
    style.isolation === "isolate" ||
    Boolean(style.mixBlendMode && style.mixBlendMode !== "normal") ||
    /(?:paint|layout|strict|content)/.test(style.contain || "") ||
    /(?:transform|opacity|filter|perspective)/.test(style.willChange || "")
  );
}

function paintLayer(element, providedStyle) {
  const style = providedStyle || getElementStyle(element);
  const parsedZIndex = Number.parseInt(style.zIndex, 10);
  const zIndex = Number.isFinite(parsedZIndex) ? parsedZIndex : 0;
  let layer;
  if (zIndex < 0) {
    layer = 0;
  } else if (!["static", ""].includes(style.position) || createsStackingContext(element, style)) {
    layer = zIndex > 0 ? 5 : 4;
  } else if (style.float !== "none") {
    layer = 2;
  } else if (/^(inline|inline-block|inline-flex|inline-grid)$/.test(style.display)) {
    layer = 3;
  } else {
    layer = 1;
  }
  return { element, zIndex, layer };
}

function exposePointThroughFrameChain(element, localX, localY) {
  let currentElement = element;
  let currentRoot = currentElement.getRootNode?.();
  while (currentRoot?.host) {
    const host = currentRoot.host;
    const hitTarget = hitTestForElement(host, localX, localY);
    if (!hitTarget || !(hitTarget === host || host.contains(hitTarget))) {
      return null;
    }
    if (hasPointerTransparentOccluder(host, localX, localY)) {
      return null;
    }
    currentElement = host;
    currentRoot = currentElement.getRootNode?.();
  }

  let x = localX;
  let y = localY;
  let currentWindow = element.ownerDocument?.defaultView;
  const visited = new Set();
  while (currentWindow && currentWindow !== window && !visited.has(currentWindow)) {
    visited.add(currentWindow);
    let frame;
    try {
      frame = currentWindow.frameElement;
    } catch {
      return null;
    }
    if (!frame || !isElementBoxRendered(frame)) {
      return null;
    }
    const frameRect = getElementRect(frame);
    const scaleX = frame.offsetWidth ? frameRect.width / frame.offsetWidth : 1;
    const scaleY = frame.offsetHeight ? frameRect.height / frame.offsetHeight : 1;
    x = frameRect.left + (frame.clientLeft + x) * scaleX;
    y = frameRect.top + (frame.clientTop + y) * scaleY;
    const hitTarget = hitTestForElement(frame, x, y);
    if (!hitTarget || !(hitTarget === frame || frame.contains(hitTarget))) {
      return null;
    }
    if (hasPointerTransparentOccluder(frame, x, y)) {
      return null;
    }
    currentWindow = frame.ownerDocument?.defaultView;
  }
  return { globalX: x, globalY: y };
}

function shouldSkipElement(element) {
  const tag = element.tagName?.toLowerCase();
  return ["script", "style", "noscript", "template", "canvas"].includes(tag);
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
    message: error?.message || String(error),
    code: error?.code || "",
    details: error?.details && typeof error.details === "object" ? error.details : null
  };
}

function createContentControlError(code, message, details = null) {
  const error = new Error(message);
  error.name = "WebControlError";
  error.code = String(code || "control_error");
  error.details = details && typeof details === "object" ? details : null;
  return error;
}
})();
