(function initializeAgentRunStoreV2(globalScope) {
  "use strict";

  const Runtime = globalScope.WebAgentRuntimeV2
    || (typeof require === "function" ? require("./runtime.js") : null);
  if (!Runtime) {
    throw new Error("WebAgentRuntimeV2 must be loaded before run-store.js.");
  }

  const DEFAULT_STORAGE_KEY = "agentRuntimeV2Runs";

  function createRunStore(options = {}) {
    const storage = options.storage;
    if (!storage?.get || !storage?.set) {
      throw new Error("Agent Runtime v2 run store requires a storage area.");
    }
    const key = String(options.key || DEFAULT_STORAGE_KEY);
    const maxRuns = normalizePositiveInteger(options.maxRuns, 40);
    let writeQueue = Promise.resolve();

    async function readAll() {
      const stored = await storage.get(key);
      const value = stored?.[key];
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    }

    async function writeAll(runs) {
      const entries = Object.entries(runs)
        .sort(([, left], [, right]) => (
          String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || ""))
        ))
        .slice(0, maxRuns);
      await storage.set({ [key]: Object.fromEntries(entries) });
    }

    function enqueue(operation) {
      const next = writeQueue.catch(() => {}).then(operation);
      writeQueue = next.catch(() => {});
      return next;
    }

    async function put(run) {
      return enqueue(async () => {
        const runs = await readAll();
        const snapshot = Runtime.snapshotForStorage(run);
        runs[snapshot.runId] = snapshot;
        await writeAll(runs);
        return snapshot;
      });
    }

    async function applyEvent(runId, event, initialRun = null) {
      return enqueue(async () => {
        const runs = await readAll();
        const source = runs[runId] || initialRun;
        if (!source) {
          throw new Error(`Agent Runtime v2 run was not initialized: ${runId}`);
        }
        const next = Runtime.reduceRun(source, event, options.limits || {});
        const snapshot = Runtime.snapshotForStorage(next);
        runs[runId] = snapshot;
        await writeAll(runs);
        return snapshot;
      });
    }

    async function get(runId) {
      const runs = await readAll();
      return runs[runId] || null;
    }

    async function getActiveForTab(targetTabId) {
      const tabId = Number(targetTabId);
      const runs = Object.values(await readAll())
        .filter((run) => Number(run?.targetTabId) === tabId && Runtime.isRunActive(run))
        .sort((left, right) => (
          String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
        ));
      return runs[0] || null;
    }

    async function remove(runId) {
      return enqueue(async () => {
        const runs = await readAll();
        const existed = Boolean(runs[runId]);
        delete runs[runId];
        await writeAll(runs);
        return { removed: existed };
      });
    }

    return Object.freeze({
      readAll,
      put,
      applyEvent,
      get,
      getActiveForTab,
      remove
    });
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  const api = Object.freeze({
    DEFAULT_STORAGE_KEY,
    createRunStore
  });

  globalScope.WebAgentRunStoreV2 = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
