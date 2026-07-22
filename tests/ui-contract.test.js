const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function hasElementId(source, id) {
  return new RegExp(`\\bid=["']${id}["']`).test(source);
}

function readOpeningTag(source, tagName, id) {
  return source.match(new RegExp(`<${tagName}\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"))?.[0] || "";
}

test("every panel DOM binding exists in the HTML", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  const ids = Array.from(script.matchAll(/getElementById\("([^"]+)"\)/g), (match) => match[1]);
  const missing = ids.filter((id) => !new RegExp(`id=["']${id}["']`).test(html));
  assert.deepEqual(missing, []);
});

test("agent core loads before the panel controller", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  assert.ok(html.indexOf('src="agent-core.js"') < html.indexOf('src="panel.js"'));
});

test("the design does not use a left accent bar", () => {
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.doesNotMatch(css, /border-left\s*:/i);
});

test("secondary toolbar actions live in the utility menu without redundant save or refresh controls", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  const utilityStart = html.search(/<details\b[^>]*\bid=["']utilityMenu["']/i);
  const utilityEnd = html.indexOf("</details>", utilityStart);
  const utilityMarkup = utilityStart >= 0 && utilityEnd > utilityStart
    ? html.slice(utilityStart, utilityEnd)
    : "";

  assert.ok(utilityMarkup, "the compact toolbar needs a utility menu");
  for (const id of ["openContextButton", "undoActionButton", "openExportButton", "clearChatButton"]) {
    assert.equal(hasElementId(utilityMarkup, id), true, `${id} should remain available inside the utility menu`);
  }
  for (const removedId of ["refreshContextButton", "saveSettingsButton"]) {
    assert.equal(hasElementId(html, removedId), false, `${removedId} should not occupy the compact UI`);
    assert.doesNotMatch(script, new RegExp(`\\b${removedId}\\b`));
  }
});

test("the panel can shrink below legacy desktop widths without losing its three primary actions", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const topbarStart = html.search(/<header\b[^>]*\bclass=["'][^"']*\btopbar\b[^"']*["']/i);
  const topbarEnd = html.indexOf("</header>", topbarStart);
  const topbarMarkup = topbarStart >= 0 && topbarEnd > topbarStart
    ? html.slice(topbarStart, topbarEnd)
    : "";
  const rootRule = css.match(/html\s*,\s*body\s*\{([^}]*)\}/i)?.[1] || "";
  const rootMinWidth = rootRule.match(/\bmin-width\s*:\s*([^;]+)/i)?.[1].trim() || "";

  assert.ok(topbarMarkup, "the compact topbar should exist");
  for (const id of ["pickElementButton", "openSettingsButton", "utilityMenuButton"]) {
    assert.equal(hasElementId(topbarMarkup, id), true, `${id} should remain a primary topbar action`);
  }
  assert.ok(
    !rootMinWidth || /^0(?:px|em|rem|%)?$/i.test(rootMinWidth),
    `the panel root must remain shrinkable; found min-width: ${rootMinWidth}`
  );
});

test("approval UI shares a bounded workspace with the conversation", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const workspaceStart = html.search(/<section\b[^>]*\bid=["']conversationWorkspace["']/i);
  const composerStart = html.search(/<section\b[^>]*\bid=["']composer["']/i);
  const workspace = workspaceStart >= 0 && composerStart > workspaceStart
    ? html.slice(workspaceStart, composerStart)
    : "";
  assert.match(workspace, /id="messageList"/);
  assert.match(workspace, /id="approvalStack"/);
  assert.match(workspace, /id="approvalPanel"/);
  assert.match(workspace, /id="externalApprovalPanel"/);
  assert.match(css, /\.conversation-workspace:has\(> \.approval-stack:not\(\[hidden\]\)\)[^{]*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
});

test("local approval reserves the composer while external-only approval keeps input available", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  const syncStart = script.indexOf("function syncApprovalWorkspace()");
  const syncEnd = script.indexOf("function clearPendingPlan", syncStart);
  const syncFunction = script.slice(syncStart, syncEnd);
  const approvalTag = readOpeningTag(html, "section", "approvalPanel");

  assert.match(approvalTag, /\btabindex=["']-1["']/i);
  assert.match(syncFunction, /hasLocalApproval\s*=\s*!elements\.approvalPanel\.hidden/);
  assert.match(syncFunction, /hasApproval\s*=\s*hasLocalApproval\s*\|\|\s*!elements\.externalApprovalPanel\.hidden/);
  assert.match(syncFunction, /elements\.composer\.hidden\s*=\s*hasLocalApproval/);
});

test("screenshot-disabled mode gates both AI input and approval previews", () => {
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  const annotationStart = script.indexOf("async function renderActionAnnotation(decision)");
  const annotationEnd = script.indexOf("function buildAnnotatedScreenshot", annotationStart);
  const annotationFunction = script.slice(annotationStart, annotationEnd);
  assert.match(annotationFunction, /if \(!getRuntimeSettings\(\)\.includeScreenshot\) \{\s*return;/);
  assert.ok(
    annotationFunction.indexOf("includeScreenshot") < annotationFunction.indexOf('type: "CAPTURE_VISIBLE_TAB"'),
    "the effective setting must be checked before requesting a screenshot"
  );
  assert.match(script, /previewToken !== state\.approvalPreviewToken/);
  assert.match(annotationFunction, /collectContextWithRetry\(\)/);
  assert.match(annotationFunction, /isSameVisualObservation\(annotationContext, confirmedContext\)/);
  assert.match(annotationFunction, /areAnnotationTargetsStable\(decision, annotationContext, confirmedContext\)/);
});

test("goal and template tools are closed popovers above a single-row composer", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  const goalTag = readOpeningTag(html, "details", "goalPopover");
  const templateTag = readOpeningTag(html, "details", "templatePopover");
  const composerStart = html.search(/<section\b[^>]*\bid=["']composer["']/i);
  const settingsStart = html.search(/<[^>]+\bid=["']settingsModal["']/i);
  const composerMarkup = composerStart >= 0 && settingsStart > composerStart
    ? html.slice(composerStart, settingsStart)
    : "";

  assert.ok(goalTag);
  assert.ok(templateTag);
  assert.doesNotMatch(goalTag, /\sopen(?:\s|=|>)/i);
  assert.doesNotMatch(templateTag, /\sopen(?:\s|=|>)/i);
  assert.equal(hasElementId(composerMarkup, "goalPopover"), true);
  assert.equal(hasElementId(composerMarkup, "templatePopover"), true);
  assert.match(composerMarkup, /class=["'][^"']*\bcomposer-input-row\b[^"']*["']/);
  assert.equal(hasElementId(composerMarkup, "chatInput"), true);
  assert.equal(hasElementId(composerMarkup, "sendButton"), true);
  assert.match(html, /id="goalHelp"/);
  assert.match(html, /id="templateHelp"/);
  for (const id of [
    "templateTitleInput",
    "templatePromptInput",
    "templateStatus",
    "newTemplateButton",
    "importCurrentInputButton",
    "insertTemplateButton",
    "saveTemplateButton",
    "deleteTemplateButton"
  ]) {
    assert.equal(hasElementId(composerMarkup, id), true, `${id} should be available in the template editor`);
  }
  assert.doesNotMatch(composerMarkup, /현재 문구 저장/);
  assert.match(script, /selectedTemplate\?\.id\s*\|\|\s*createTaskTemplateId\(\)/);
  assert.match(script, /state\.templateDeleteConfirmationId/);
  assert.match(script, /MAX_TASK_TEMPLATES/);
  assert.match(script, /resizeComposerInput/);
});

test("site-specific settings explain their scope", () => {
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  assert.match(html, /id="siteProfileTarget"/);
  assert.match(html, /기본 설정 따르기/);
  assert.match(script, /buildSessionKey\(tabId, url\)/);
  assert.match(script, /state\.goalEditing/);
  assert.match(script, /requestAnswerGroundingVerification/);
});

test("compact settings tabs stay on one horizontally scrollable row", () => {
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(
    css,
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.settings-tabs\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.settings-tab\s*\{[^}]*flex:\s*0\s+0\s+auto;/
  );
});

test("tab changes are deferred without losing or clearing a running session", () => {
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  assert.match(script, /activeTabTransitionPending/);
  assert.match(script, /activeTabTransitionRevision/);
  assert.match(script, /await settleActiveTabTransitions\(\)/);
  assert.match(script, /state\.busy\s*\|\|\s*hasBoundAgentSession\(\)/);
  assert.match(script, /queueMicrotask\(resumeActiveTabTransition\)/);
});

test("answer grounding accepts only the current visual observation and preserves coherent screenshots", () => {
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  const groundingStart = script.indexOf("async function requestAnswerGroundingVerification");
  const groundingEnd = script.indexOf("async function requestExecutionPolicy", groundingStart);
  const groundingFunction = script.slice(groundingStart, groundingEnd);
  assert.match(groundingFunction, /session\.currentPageEvidenceId/);
  assert.match(groundingFunction, /entry\.id === currentPageEvidenceId/);
  assert.doesNotMatch(groundingFunction, /slice\(-2\)/);
  assert.match(groundingFunction, /screenshotDataUrl,/);
  assert.match(script, /decision\.status === "completed"[\s\S]*decision\.verifier\?\.status !== "verified"/);
});

test("legacy sessions are consumed once and resetting settings refreshes the site profile form", () => {
  const script = fs.readFileSync(path.join(root, "panel.js"), "utf8");
  assert.match(script, /delete sessions\[legacyKey\]/);
  const resetStart = script.indexOf("async function resetSettings()");
  const resetEnd = script.indexOf("function updateCustomVisibility", resetStart);
  const resetFunction = script.slice(resetStart, resetEnd);
  assert.match(resetFunction, /applySiteProfileForActiveTab\(\)/);
  assert.match(resetFunction, /renderTemplateSelect\(""\)/);
});

test("manifest and package versions stay aligned", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.manifest_version, 3);
  for (const file of [manifest.background.service_worker, manifest.side_panel.default_path]) {
    assert.equal(fs.existsSync(path.join(root, file)), true);
  }
});

test("host access is optional and extension storage is restricted to trusted contexts", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.match(background, /TRUSTED_CONTEXTS/);
});
