(function initializeAgentProviderDriverV2(globalScope) {
  "use strict";

  const VERSION = "2.0";
  const DEFAULT_CONTINUATION_CHAR_BUDGET = 64000;
  const DEFAULT_RECOVERY_TOKEN_CEILING = 32768;

  function buildOpenAiResponsesInput(request = {}) {
    const priorItems = normalizeContinuationItems(request.providerState?.items);
    const toolOutputs = normalizeFunctionCallOutputs(request.providerToolOutputs);
    const currentInput = buildOpenAiUserInput(request);
    return [...priorItems, ...toolOutputs, currentInput];
  }

  function buildOpenAiMessages(request = {}) {
    const priorMessages = normalizeChatMessages(request.providerState?.messages)
      .filter((message) => message.role !== "system");
    const messages = [];
    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }
    messages.push(...priorMessages);
    messages.push(buildOpenAiChatUserMessage(request));
    return messages;
  }

  function buildAnthropicMessages(request = {}) {
    const priorMessages = normalizeAnthropicMessages(request.providerState?.messages);
    return [
      ...priorMessages,
      {
        role: "user",
        content: buildAnthropicUserContent(request)
      }
    ];
  }

  function buildContinuation(options = {}) {
    const profile = stringValue(options.profile || "openai-responses");
    const request = options.request || {};
    const response = options.response || {};
    const body = options.body || {};
    const maxChars = normalizePositiveInteger(
      options.maxChars || request.providerContinuationMaxChars,
      DEFAULT_CONTINUATION_CHAR_BUDGET
    );

    if (profile === "openai-responses") {
      const items = [
        ...sanitizeResponsesInputItems(body.input),
        ...normalizeContinuationItems(response.output)
      ];
      return {
        version: VERSION,
        profile,
        responseId: stringValue(response.id),
        items: compactConversationItems(items, maxChars, {
          profile,
          summary: request.providerSummary
        }),
        updatedAt: new Date().toISOString()
      };
    }

    if (profile === "openai-chat") {
      const assistantMessage = response.choices?.[0]?.message;
      const messages = assistantMessage
        ? [...normalizeChatMessages(body.messages), cloneJson(assistantMessage)]
        : normalizeChatMessages(body.messages);
      return {
        version: VERSION,
        profile,
        responseId: stringValue(response.id),
        messages: compactConversationItems(messages, maxChars, {
          profile,
          summary: request.providerSummary
        }),
        updatedAt: new Date().toISOString()
      };
    }

    if (profile === "anthropic-messages") {
      const assistantContent = Array.isArray(response.content) ? cloneJson(response.content) : [];
      const messages = [
        ...normalizeAnthropicMessages(body.messages),
        ...(assistantContent.length ? [{ role: "assistant", content: assistantContent }] : [])
      ];
      return {
        version: VERSION,
        profile,
        responseId: stringValue(response.id),
        messages: compactConversationItems(messages, maxChars, {
          profile,
          summary: request.providerSummary
        }),
        updatedAt: new Date().toISOString()
      };
    }

    return {
      version: VERSION,
      profile,
      responseId: stringValue(response.id),
      updatedAt: new Date().toISOString()
    };
  }

  function buildIncompleteRecoveryBody(body, parsed, settings = {}) {
    if (stringValue(parsed?.status) !== "incomplete") {
      return null;
    }
    const reason = stringValue(parsed?.incomplete_details?.reason);
    if (reason !== "max_output_tokens" || !Number.isFinite(Number(body?.max_output_tokens))) {
      return null;
    }
    const current = Math.max(1, Math.floor(Number(body.max_output_tokens)));
    const configuredCeiling = normalizePositiveInteger(
      settings.maxRecoveryOutputTokens,
      DEFAULT_RECOVERY_TOKEN_CEILING
    );
    const ceiling = Math.max(current, configuredCeiling);
    const observedOutput = Math.max(0, Number(parsed?.usage?.output_tokens) || 0);
    const next = Math.min(
      ceiling,
      Math.max(
        current + Math.max(1024, Math.ceil(current * 0.5)),
        observedOutput + Math.max(2048, Math.ceil(observedOutput * 0.5))
      )
    );
    if (next <= current) {
      return null;
    }
    return {
      ...cloneJson(body),
      max_output_tokens: next
    };
  }

  function getProviderTerminalState(profile, parsed) {
    if (profile !== "openai-responses") {
      return { terminal: true, complete: true, status: "" };
    }
    const status = stringValue(parsed?.status);
    if (!status || status === "completed") {
      return { terminal: true, complete: true, status: status || "completed" };
    }
    if (status === "incomplete") {
      return {
        terminal: true,
        complete: false,
        status,
        reason: stringValue(parsed?.incomplete_details?.reason)
      };
    }
    return { terminal: false, complete: false, status };
  }

  function sanitizeResponsesInputItems(items) {
    return normalizeContinuationItems(items).map((item) => {
      if (item?.role !== "user" || !Array.isArray(item.content)) {
        return item;
      }
      const content = item.content
        .filter((entry) => entry?.type !== "input_image")
        .map(cloneJson);
      return { ...item, content };
    });
  }

  function buildOpenAiUserInput(request) {
    const content = [{ type: "input_text", text: stringValue(request.user) }];
    if (request.screenshotDataUrl) {
      content.push({ type: "input_image", image_url: request.screenshotDataUrl });
    }
    return { role: "user", content };
  }

  function buildOpenAiChatUserMessage(request) {
    if (!request.screenshotDataUrl) {
      return { role: "user", content: stringValue(request.user) };
    }
    return {
      role: "user",
      content: [
        { type: "text", text: stringValue(request.user) },
        { type: "image_url", image_url: { url: request.screenshotDataUrl } }
      ]
    };
  }

  function buildAnthropicUserContent(request) {
    const content = [];
    if (request.user) {
      content.push({ type: "text", text: request.user });
    }
    if (request.screenshotDataUrl) {
      const image = parseDataUrl(request.screenshotDataUrl);
      if (image) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.base64
          }
        });
      }
    }
    return content;
  }

  function normalizeContinuationItems(items) {
    return Array.isArray(items)
      ? items.filter((item) => item && typeof item === "object").map(cloneJson)
      : [];
  }

  function normalizeChatMessages(messages) {
    return Array.isArray(messages)
      ? messages
        .filter((message) => message && ["system", "user", "assistant", "tool"].includes(message.role))
        .map(cloneJson)
      : [];
  }

  function normalizeAnthropicMessages(messages) {
    return Array.isArray(messages)
      ? messages
        .filter((message) => message && ["user", "assistant"].includes(message.role))
        .map(cloneJson)
      : [];
  }

  function normalizeFunctionCallOutputs(outputs) {
    return (Array.isArray(outputs) ? outputs : []).flatMap((entry) => {
      const callId = stringValue(entry?.callId || entry?.call_id).trim();
      if (!callId) {
        return [];
      }
      return [{
        type: "function_call_output",
        call_id: callId,
        output: typeof entry?.output === "string"
          ? entry.output
          : JSON.stringify(entry?.output ?? null)
      }];
    });
  }

  function compactConversationItems(items, maxChars, options = {}) {
    const normalized = (Array.isArray(items) ? items : [])
      .filter((item) => !isRuntimeSummaryItem(item));
    if (JSON.stringify(normalized).length <= maxChars) {
      return normalized.map(cloneJson);
    }
    const summaryItem = buildRuntimeSummaryItem(options.profile, options.summary, maxChars);
    const summarySize = summaryItem ? JSON.stringify(summaryItem).length + 1 : 0;
    const selected = [];
    let used = 2 + summarySize;
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const item = normalized[index];
      const size = JSON.stringify(item).length + 1;
      if (selected.length && used + size > maxChars) {
        break;
      }
      if (!selected.length && size > maxChars) {
        selected.unshift(compactOversizedItem(
          item,
          Math.max(512, maxChars - summarySize)
        ));
        break;
      }
      selected.unshift(item);
      used += size;
    }
    const coherentSelection = removeOrphanedFunctionItems(selected, normalized);
    return summaryItem ? [summaryItem, ...coherentSelection] : coherentSelection;
  }

  function removeOrphanedFunctionItems(selected, original) {
    const originalOutputIds = new Set(
      original
        .filter((item) => item?.type === "function_call_output")
        .map((item) => stringValue(item.call_id).trim())
        .filter(Boolean)
    );
    const selectedCallIds = new Set(
      selected
        .filter((item) => item?.type === "function_call")
        .map((item) => stringValue(item.call_id).trim())
        .filter(Boolean)
    );
    const selectedOutputIds = new Set(
      selected
        .filter((item) => item?.type === "function_call_output")
        .map((item) => stringValue(item.call_id).trim())
        .filter(Boolean)
    );
    return selected.filter((item) => {
      const callId = stringValue(item?.call_id).trim();
      if (!callId) {
        return true;
      }
      if (item.type === "function_call_output") {
        return selectedCallIds.has(callId);
      }
      if (item.type === "function_call" && originalOutputIds.has(callId)) {
        return selectedOutputIds.has(callId);
      }
      return true;
    });
  }

  function buildRuntimeSummaryItem(profile, summary, maxChars) {
    const source = stringValue(summary).trim();
    const text = source.slice(
      0,
      Math.max(512, Math.min(source.length, Math.floor(maxChars * 0.3)))
    );
    if (!text) {
      return null;
    }
    const content = `[runtime-state-summary]\n${text}`;
    if (profile === "openai-responses") {
      return {
        role: "user",
        content: [{ type: "input_text", text: content }]
      };
    }
    return { role: "user", content };
  }

  function isRuntimeSummaryItem(item) {
    if (typeof item?.content === "string") {
      return item.content.startsWith("[runtime-state-summary]");
    }
    return Array.isArray(item?.content)
      && item.content.some((entry) => (
        typeof entry?.text === "string"
        && entry.text.startsWith("[runtime-state-summary]")
      ));
  }

  function compactOversizedItem(item, maxChars) {
    if (item?.role && item?.content) {
      const text = extractTextContent(item.content);
      return {
        role: item.role,
        content: text.slice(-Math.max(512, maxChars - 256))
      };
    }
    return {
      type: stringValue(item?.type || "compacted_item"),
      compacted: true
    };
  }

  function extractTextContent(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content.map((entry) => (
      typeof entry === "string"
        ? entry
        : stringValue(entry?.text || entry?.input_text || entry?.output_text)
    )).filter(Boolean).join("\n");
  }

  function parseDataUrl(dataUrl) {
    const match = stringValue(dataUrl).match(/^data:([^;,]+);base64,(.+)$/);
    return match ? { mimeType: match[1], base64: match[2] } : null;
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function cloneJson(value) {
    if (value === undefined) {
      return undefined;
    }
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch {
        // Fall back to JSON cloning.
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  const api = Object.freeze({
    VERSION,
    buildOpenAiResponsesInput,
    buildOpenAiMessages,
    buildAnthropicMessages,
    buildContinuation,
    buildIncompleteRecoveryBody,
    getProviderTerminalState,
    normalizeFunctionCallOutputs,
    compactConversationItems
  });

  globalScope.WebAgentProviderDriverV2 = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
