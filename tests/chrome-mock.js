(() => {
  const stored = {
    settings: {
      apiEndpoint: `${location.origin}/mock-ai`,
      model: "mock-agent",
      includeScreenshot: false,
      agentMode: "auto",
      bridgeEnabled: true,
      bridgeEndpoint: `ws://${location.hostname}:${location.port}/extension`,
      bridgeRequireApproval: true
    }
  };
  const runtimeListeners = [];
  const bridgeStatus = {
    enabled: true,
    endpoint: stored.settings.bridgeEndpoint,
    phase: "connected",
    connected: true,
    paired: true,
    requireApproval: true,
    brokerId: "mock-broker",
    lastError: "",
    connectedAt: Date.now(),
    protocolVersion: "1.0",
    runtime: {
      armed: true,
      sharedTab: {
        tabId: 7,
        title: "Agent test dashboard",
        url: "https://example.test/dashboard"
      },
      sessionActive: false,
      activeSessionCount: 0,
      pendingApprovalCount: 0
    }
  };
  const pageContext = {
    documentId: "mock-dashboard-document",
    url: "https://example.test/dashboard",
    title: "Agent test dashboard",
    language: "ko",
    timestamp: new Date().toISOString(),
    pageState: { readyState: "complete", domRevision: 1, scrollHeight: 900, scrollWidth: 1200 },
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    observationScope: { kind: "visual-viewport", description: "Mock visual viewport" },
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
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      },
      sendMessage(message, callback) {
        let data = {};
        if (message.type === "GET_ACTIVE_TAB") {
          data = { id: 7, title: pageContext.title, url: pageContext.url };
        } else if (message.type === "COLLECT_PAGE_CONTEXT") {
          data = pageContext;
        } else if (message.type === "CALL_AI") {
          const verifierRequested = Array.isArray(message.request?.responseSchema?.required)
            && message.request.responseSchema.required.includes("evidenceIds");
          const initialDecisionRequested = Array.isArray(message.request?.responseSchema?.required)
            && message.request.responseSchema.required.includes("turnIntent");
          const evidenceIds = Array.from(new Set(
            String(message.request?.user || "").match(/ev-[a-z0-9_-]+/gi) || []
          ));
          const latestUserMessageMatch = String(message.request?.user || "").match(
            /"latestUserMessage":\s*("(?:\\.|[^"\\])*")/
          );
          const latestUserMessage = latestUserMessageMatch
            ? JSON.parse(latestUserMessageMatch[1])
            : "Review the current visible page.";
          const result = verifierRequested
            ? {
                version: "1.0",
                status: evidenceIds.length ? "verified" : "needs_more_evidence",
                message: evidenceIds.length
                  ? "현재 화면 관찰 근거와 답변이 일치합니다."
                  : "현재 화면 관찰 근거가 필요합니다.",
                evidenceIds: evidenceIds.slice(0, 1),
                missingEvidence: evidenceIds.length ? [] : ["현재 화면 관찰"],
                confidence: evidenceIds.length ? 0.98 : 0.2
              }
            : initialDecisionRequested
              ? {
                  turnIntent: {
                    version: "1.0",
                    mode: "standalone",
                    objective: latestUserMessage,
                    contextSummary: "",
                    repeatPolicy: "once",
                    repeatLimit: 1,
                    deliverable: {
                      kind: "answer",
                      itemDescription: "",
                      targetCount: null,
                      fields: [],
                      includeCriteria: [],
                      formats: []
                    },
                    completionCriteria: ["현재 화면 근거를 사용한 답변이 제공됩니다."],
                    reason: "최신 메시지는 독립적으로 이해할 수 있는 요청입니다."
                  },
                  ...decision
                }
              : decision;
          const text = JSON.stringify(result);
          data = {
            status: 200,
            text,
            json: result,
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
        } else if (message.type === "GET_BRIDGE_STATUS") {
          data = bridgeStatus;
        } else if (message.type === "LIST_EXTERNAL_APPROVALS") {
          data = { operations: [], status: bridgeStatus };
        } else if (message.type === "CONFIGURE_BRIDGE") {
          Object.assign(bridgeStatus, {
            enabled: Boolean(message.settings.bridgeEnabled),
            endpoint: message.settings.bridgeEndpoint || "",
            requireApproval: message.settings.bridgeRequireApproval !== false
          });
          data = bridgeStatus;
        } else if (message.type === "CONNECT_BRIDGE" || message.type === "PAIR_BRIDGE") {
          Object.assign(bridgeStatus, { enabled: true, connected: true, paired: true, phase: "connected" });
          data = bridgeStatus;
        } else if (message.type === "DISCONNECT_BRIDGE" || message.type === "REVOKE_BRIDGE") {
          Object.assign(bridgeStatus, {
            connected: false,
            paired: message.type !== "REVOKE_BRIDGE",
            phase: "disconnected"
          });
          data = bridgeStatus;
        } else if (message.type === "ATTACH_BRIDGE_TAB") {
          bridgeStatus.runtime.armed = true;
          data = bridgeStatus;
        } else if (message.type === "DETACH_BRIDGE_TAB") {
          bridgeStatus.runtime.armed = false;
          bridgeStatus.runtime.sharedTab = null;
          data = bridgeStatus;
        }
        queueMicrotask(() => callback({ ok: true, data }));
      }
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    permissions: {
      async contains() {
        return true;
      },
      async request() {
        return true;
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
