const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

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
