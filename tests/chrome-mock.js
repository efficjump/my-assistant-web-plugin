(() => {
  const stored = {
    settings: {
      apiEndpoint: "http://127.0.0.1:4173/mock-ai",
      model: "mock-agent",
      includeScreenshot: false,
      agentMode: "auto"
    }
  };
  const pageContext = {
    url: "https://example.test/dashboard",
    title: "Agent test dashboard",
    language: "ko",
    timestamp: new Date().toISOString(),
    pageState: { readyState: "complete", domRevision: 1, scrollHeight: 900, scrollWidth: 1200 },
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    selection: "",
    visibleText: "테스트 대시보드 상태는 정상입니다.",
    documentTextExcerpt: "테스트 대시보드 상태는 정상입니다.",
    headings: [{ level: 1, text: "Dashboard" }],
    landmarks: [],
    forms: [],
    tables: [],
    iframes: [],
    liveRegions: [],
    interactiveElements: [{
      ref: "e1",
      tag: "button",
      role: "button",
      type: "button",
      label: "새로고침",
      selector: "#refresh"
    }]
  };

  const decision = {
    version: "1.0",
    status: "answer",
    message: "테스트 대시보드는 정상 상태입니다.",
    summary: "현재 화면 요약",
    progress: "현재 화면의 상태 문구를 확인했습니다.",
    doneReason: "",
    completionEvidence: [],
    needsUserApproval: false,
    plan: ["현재 화면 확인", "상태 요약"],
    toolCalls: [],
    actions: [],
    verification: { required: false, expectedChange: "", successCriteria: [] }
  };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        let data = {};
        if (message.type === "GET_ACTIVE_TAB") {
          data = { id: 7, title: pageContext.title, url: pageContext.url };
        } else if (message.type === "COLLECT_PAGE_CONTEXT") {
          data = pageContext;
        } else if (message.type === "CALL_AI") {
          const text = JSON.stringify(decision);
          data = {
            status: 200,
            text,
            json: decision,
            audit: {
              version: "1.0",
              requestId: message.request?.requestId || "mock-request",
              taskType: message.request?.taskType || "chat-agent-decision",
              profile: "openai-responses",
              model: "mock-agent",
              outcome: "success",
              status: 200,
              responseId: "resp-mock",
              providerStatus: "completed",
              responseBytes: text.length,
              outputChars: text.length,
              attempts: 1,
              durationMs: 12,
              structuredOutputUsed: true,
              structuredFallbackUsed: false,
              emptyOutput: false,
              usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, cachedTokens: 0, reasoningTokens: 0 }
            }
          };
        } else if (message.type === "LIST_MCP_TOOLS") {
          data = { tools: [] };
        }
        queueMicrotask(() => callback({ ok: true, data }));
      }
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            return { [key]: stored[key] };
          }
          return { ...stored };
        },
        async set(value) {
          Object.assign(stored, value);
        },
        async remove(key) {
          delete stored[key];
        }
      },
      session: {
        async get(key) {
          return { [key]: stored[key] };
        },
        async set(value) {
          Object.assign(stored, value);
        },
        async remove(key) {
          delete stored[key];
        }
      }
    }
  };
})();
