(function initializeAgentToolRegistryV2(globalScope) {
  "use strict";

  const VERSION = "2.0";

  function selectTools(tools, options = {}) {
    const candidates = (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool && stringValue(tool.name).trim())
      .map((tool, index) => ({
        tool,
        index,
        score: scoreTool(tool, options.objective, options.preferredNames)
      }));
    const maxChars = normalizePositiveInteger(options.maxChars, 16000);
    const maxTools = normalizePositiveInteger(options.maxTools, candidates.length || 1);
    const allSize = JSON.stringify(candidates.map((item) => item.tool)).length;
    if (candidates.length <= maxTools && allSize <= maxChars) {
      return {
        version: VERSION,
        tools: candidates.map((item) => item.tool),
        omitted: [],
        reason: "all-tools-fit"
      };
    }

    candidates.sort((left, right) => (
      right.score - left.score
      || left.index - right.index
    ));
    const selected = [];
    const omitted = [];
    let used = 2;
    for (const candidate of candidates) {
      const size = JSON.stringify(candidate.tool).length + 1;
      if (selected.length < maxTools && (!selected.length || used + size <= maxChars)) {
        selected.push(candidate);
        used += size;
      } else {
        omitted.push(candidate.tool);
      }
    }
    selected.sort((left, right) => left.index - right.index);
    return {
      version: VERSION,
      tools: selected.map((item) => item.tool),
      omitted: omitted.map((tool) => stringValue(tool.name)),
      reason: "dynamic-relevance-selection"
    };
  }

  function scoreTool(tool, objective, preferredNames) {
    const preferred = new Set(
      (Array.isArray(preferredNames) ? preferredNames : [])
        .map((item) => normalizeText(item))
        .filter(Boolean)
    );
    const name = normalizeText(tool.name);
    let score = preferred.has(name) ? 100000 : 0;
    const goalTerms = tokenize(objective);
    const searchable = normalizeText([
      tool.name,
      tool.title,
      tool.description,
      JSON.stringify(tool.inputSchema || {})
    ].filter(Boolean).join(" "));
    for (const term of goalTerms) {
      if (name.includes(term)) {
        score += 120;
      }
      if (searchable.includes(term)) {
        score += 20;
      }
    }
    if (tool.annotations?.readOnlyHint === true) {
      score += 2;
    }
    return score;
  }

  function tokenize(value) {
    const normalized = normalizeText(value);
    const words = normalized.split(/[^\p{L}\p{N}_.-]+/u).filter((item) => item.length >= 2);
    return Array.from(new Set(words));
  }

  function normalizeText(value) {
    return stringValue(value).normalize("NFKC").toLocaleLowerCase().trim();
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  const api = Object.freeze({
    VERSION,
    selectTools,
    scoreTool,
    tokenize
  });

  globalScope.WebAgentToolRegistryV2 = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
