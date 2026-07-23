const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../agent-core.js");
const Contract = require("../execution-contract.js");
const Protocol = require("../bridge-protocol.js");

function getTools() {
  const tools = Protocol.getToolDefinitions();
  assert.ok(Array.isArray(tools));
  return tools;
}

function getAdvancedTools() {
  const tools = Protocol.getToolDefinitions({ advanced: true });
  assert.ok(Array.isArray(tools));
  return tools;
}

test("bridge publishes the guided browser MCP tool surface by default", () => {
  assert.equal(Protocol.protocolVersion, "2.3");
  const names = getTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "browser_act",
    "browser_begin",
    "browser_continue",
    "browser_elements",
    "browser_end",
    "browser_screenshot",
    "browser_visual_act"
  ]);
});

test("bridge retains the identifier-based tool surface as an advanced option", () => {
  const names = getAdvancedTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "browser_elements",
    "browser_execute",
    "browser_observe",
    "browser_operation_get",
    "browser_screenshot",
    "browser_session_close",
    "browser_session_start",
    "browser_status",
    "browser_visual_act"
  ]);
  assert.equal(
    Protocol.validateToolArguments("browser_screenshot", { session_id: "session-1" }, { advanced: false }).valid,
    false
  );
  assert.equal(
    Protocol.validateToolArguments("browser_screenshot", { session_id: "session-1" }, { advanced: true }).valid,
    true
  );
});

test("bridge instructions keep multi-step clients working until the session is closed", () => {
  assert.match(Protocol.instructions, /browser_begin once/i);
  assert.match(Protocol.instructions, /immutable repetition boundary/i);
  assert.match(Protocol.instructions, /terminal for that browser task/i);
  assert.match(Protocol.instructions, /identifiers are managed internally/i);
  assert.match(Protocol.instructions, /browser_end before the final answer/i);
  assert.match(Protocol.instructions, /never submit a duplicate proposal/i);
  assert.match(Protocol.instructions, /element-count limit is never by itself a blocker/i);
  assert.match(Protocol.instructions, /semantic roles, and nearby visible text/i);
  assert.match(Protocol.instructions, /browser_visual_act/i);
  const advancedInstructions = Protocol.getInstructions({ advanced: true });
  assert.match(advancedInstructions, /browser_session_start/i);
  assert.match(advancedInstructions, /immutable intent/i);
  assert.match(advancedInstructions, /repetition boundary/i);
  assert.match(advancedInstructions, /failed, blocked, rejected/i);
});

test("bridge exposes observation paging and refresh without accepting visual coordinates", () => {
  const guidedElements = getTools().find((tool) => tool.name === "browser_elements");
  const advancedElements = getAdvancedTools().find((tool) => tool.name === "browser_elements");
  const continueTool = getTools().find((tool) => tool.name === "browser_continue");
  const visualTool = getTools().find((tool) => tool.name === "browser_visual_act");

  assert.ok(guidedElements.inputSchema.properties.cursor);
  assert.ok(guidedElements.inputSchema.properties.query);
  assert.equal(guidedElements.inputSchema.properties.roles.items.type, "string");
  assert.equal(guidedElements.inputSchema.properties.near_text.type, "string");
  assert.ok(advancedElements.inputSchema.required.includes("session_id"));
  assert.equal(continueTool.inputSchema.properties.refresh.type, "boolean");
  assert.deepEqual(visualTool.inputSchema.required, ["surface_ref", "target_description"]);
  assert.equal(Object.hasOwn(visualTool.inputSchema.properties, "xNormalized"), false);
  assert.equal(Object.hasOwn(visualTool.inputSchema.properties, "yNormalized"), false);
  assert.equal(
    Protocol.validateToolArguments("browser_continue", { refresh: true }, { advanced: false }).valid,
    true
  );
  assert.equal(
    Protocol.validateToolArguments("browser_elements", { cursor: "cursor-1" }, { advanced: false }).valid,
    true
  );
  assert.equal(
    Protocol.validateToolArguments("browser_elements", {
      query: "next page",
      roles: ["button"],
      near_text: "issue grid"
    }, { advanced: false }).valid,
    true
  );
  assert.equal(
    Protocol.validateToolArguments("browser_elements", {
      roles: ["button or link"]
    }, { advanced: false }).valid,
    false
  );
});

test("browser_act derives its action fields from the canonical decision schema", () => {
  const execute = getTools().find((tool) => tool.name === "browser_act");
  assert.ok(execute);
  assert.equal(Object.hasOwn(execute.inputSchema.properties, "goal"), false);
  const externalAction = execute.inputSchema.properties.actions.items;
  const canonicalAction = Core.DECISION_SCHEMA.properties.actions.items;

  assert.equal(externalAction.additionalProperties, false);
  assert.deepEqual(externalAction.required, ["type"]);
  assert.deepEqual(
    Object.keys(externalAction.properties).sort(),
    [...Contract.EXTERNAL_ACTION_FIELDS].sort()
  );
  for (const property of Contract.EXTERNAL_ACTION_FIELDS) {
    if (property === "type") continue;
    assert.deepEqual(externalAction.properties[property], canonicalAction.properties[property]);
  }
  for (const privilegedField of ["tabId", "downloadId", "filename", "accept", "multiple", "adopt"]) {
    assert.equal(Object.hasOwn(externalAction.properties, privilegedField), false);
  }
});

test("browser_execute excludes privileged action types from raw MCP input", () => {
  const execute = getTools().find((tool) => tool.name === "browser_act");
  const actionTypes = execute.inputSchema.properties.actions.items.properties.type.enum;

  for (const unsafe of [
    "upload",
    "visual_click",
    "download",
    "download_wait",
    "tab_focus",
    "tab_adopt",
    "tab_close"
  ]) {
    assert.equal(actionTypes.includes(unsafe), false, `${unsafe} must stay extension-owned`);
  }
  for (const safe of ["click", "fill", "select", "press", "navigate", "wait_for", "extract"] ) {
    assert.equal(actionTypes.includes(safe), true, `${safe} should remain available`);
  }
});

test("MCP callers cannot provide policy, approval, preconditions, settings, or secrets", () => {
  const forbidden = [
    "approval",
    "approved",
    "needsUserApproval",
    "policy",
    "policyVerdict",
    "preconditions",
    "safety",
    "settings",
    "secret",
    "token",
    "apiKey",
    "tabId"
  ];

  for (const tool of [...getTools(), ...getAdvancedTools()]) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    const properties = tool.inputSchema.properties || {};
    for (const field of forbidden) {
      assert.equal(
        Object.hasOwn(properties, field),
        false,
        `${tool.name} must not accept trusted field ${field}`
      );
    }
  }
});

test("exported MCP tool constants cannot mutate future generated schemas", () => {
  const first = getTools();
  const execute = first.find((tool) => tool.name === "browser_act");
  execute.inputSchema.properties.actions.items.properties.type.enum.push("upload");

  const regenerated = Protocol.getToolDefinitions();
  const regeneratedTypes = regenerated
    .find((tool) => tool.name === "browser_act")
    .inputSchema.properties.actions.items.properties.type.enum;
  assert.equal(regeneratedTypes.includes("upload"), false);
  assert.ok(Array.isArray(Protocol.MCP_TOOLS));
  assert.ok(Array.isArray(Protocol.ADVANCED_MCP_TOOLS));
});
