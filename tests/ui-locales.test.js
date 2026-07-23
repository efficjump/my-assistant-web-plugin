const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function loadI18n(navigator = { languages: ["en-US"], language: "en-US" }) {
  const context = vm.createContext({ navigator });
  vm.runInContext(fs.readFileSync(path.join(root, "ui-locales.js"), "utf8"), context);
  return context.WebUiI18n;
}

function collectKoreanStaticStrings(html) {
  const values = [];
  for (const match of html.matchAll(/>([^<>]+)</gu)) {
    const value = match[1].replace(/\s+/gu, " ").trim();
    if (/[가-힣]/u.test(value)) {
      values.push(value);
    }
  }
  for (const match of html.matchAll(/\b(?:title|aria-label|placeholder|alt|label)=["']([^"']+)["']/gu)) {
    const value = match[1].trim();
    if (/[가-힣]/u.test(value)) {
      values.push(value);
    }
  }
  return Array.from(new Set(values));
}

test("UI locale preference resolves explicit values and browser language", () => {
  const i18n = loadI18n();
  assert.equal(i18n.resolveLocale("ko", ["en-US"]), "ko");
  assert.equal(i18n.resolveLocale("en", ["ko-KR"]), "en");
  assert.equal(i18n.resolveLocale("auto", ["ko-KR", "en-US"]), "ko");
  assert.equal(i18n.resolveLocale("auto", ["en-US", "ko-KR"]), "en");
  assert.equal(i18n.resolveLocale("auto", ["ja-JP", "en-US"]), "en");
  assert.equal(i18n.normalizePreference("unsupported"), "auto");
});

test("English catalog translates exact and runtime-pattern UI messages", () => {
  const i18n = loadI18n();
  assert.equal(i18n.translateKnownText("설정", "en"), "Settings");
  assert.equal(i18n.translateKnownText("현재 사이드 패널 위치: 오른쪽", "en"), "Current side panel position: Right");
  assert.equal(i18n.translateKnownText("요소 선택됨: 검색", "en"), "Element selected: 검색");
  assert.equal(i18n.translateKnownText("사용자가 작성한 한국어", "en"), "사용자가 작성한 한국어");
  assert.equal(i18n.translateKnownText("설정", "ko"), "설정");
});

test("runtime catalog covers agent, MCP, context, approval, and error states", () => {
  const i18n = loadI18n();
  const samples = new Map([
    ["현재 요청의 범위와 완료 조건을 확인 중", "Resolving the request scope and completion criteria"],
    ["3번째 턴 · 화면 관찰 중", "Turn 3 · observing page"],
    ["2개 액션 실행 중", "Running 2 actions"],
    ["MCP 도구 4개를 확인했습니다.", "Found 4 MCP tools."],
    ["리소스 2개, 프롬프트 3개를 확인했습니다.", "Found 2 resources and 3 prompts."],
    ["7개 메시지 · AI 요청 2개", "7 messages · 2 AI requests"],
    ["승인 필요: 상태 변경", "Approval required: 상태 변경"],
    ["페이지 URL이 변경되었습니다: https://before.test → https://after.test", "The page URL changed: https://before.test → https://after.test"],
    ["AI API 요청 시간이 초과되었습니다.", "The AI API request timed out."]
  ]);
  for (const [source, expected] of samples) {
    assert.equal(i18n.translateKnownText(source, "en"), expected);
  }
});

test("every Korean static panel string has an English catalog entry", () => {
  const i18n = loadI18n();
  const html = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  const missing = collectKoreanStaticStrings(html).filter((value) => !i18n.hasTranslation(value));
  assert.deepEqual(missing, []);
});

test("English catalog keys are unique", () => {
  const source = fs.readFileSync(path.join(root, "ui-locales.js"), "utf8").split("const ENGLISH_PATTERNS")[0];
  const keys = Array.from(
    source.matchAll(/^\s*"((?:[^"\\]|\\.)+)":/gmu),
    (match) => match[1]
  );
  const duplicates = Array.from(new Set(keys.filter((key, index) => keys.indexOf(key) !== index)));
  assert.deepEqual(duplicates, []);
});
