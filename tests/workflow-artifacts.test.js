const test = require("node:test");
const assert = require("node:assert/strict");
const Artifacts = require("../workflow-artifacts.js");

function zipEntries(bytes) {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, decoder.decode(bytes.slice(dataStart, dataStart + compressedSize)));
    offset = dataStart + compressedSize;
  }
  return entries;
}

test("collection ledger deduplicates globally and truncates exactly at targetCount", () => {
  let result = Artifacts.mergeCollectionBatch(null, {
    version: "1.0",
    collectionId: "board-titles",
    collectionName: "Board titles",
    targetCount: 3,
    pageIdentity: "https://example.test/board?page=1#top",
    records: [
      { key: "1", title: "One", url: "/post/1" },
      { key: "2", title: "Two", url: "/post/2" },
      { key: "2", title: "Duplicate key", url: "/post/duplicate" }
    ]
  });
  assert.equal(result.addedCount, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.dataset.status, "collecting");

  result = Artifacts.mergeCollectionBatch(result.dataset, {
    collectionId: "board-titles",
    targetCount: 3,
    pageIdentity: "https://example.test/board?page=2",
    records: [
      { key: "2", title: "Two again", url: "/post/2" },
      { key: "3", title: "Three", url: "/post/3" },
      { key: "4", title: "Must be truncated", url: "/post/4" }
    ]
  });
  assert.equal(result.addedCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.truncatedCount, 1);
  assert.deepEqual(result.dataset.rows.map((record) => record.title), ["One", "Two", "Three"]);
  assert.equal(result.dataset.status, "reached");
  assert.equal(result.dataset.stallReason, null);
  assert.equal(result.dataset.id, "board-titles");
  assert.equal(result.dataset.visitedPageIdentities.length, 2);
  assert.equal(result.dataset.pages.length, 2);
  assert.equal(result.dataset.lastAddedCount, 1);
  assert.deepEqual(result.dataset.columns.map((column) => column.key), ["title", "url"]);
});

test("collection ledger uses canonical URLs and stable object hashes when no explicit key exists", () => {
  let result = Artifacts.mergeCollectionBatch(null, {
    collectionId: "generic",
    pageIdentity: "/list?page=1",
    records: [
      { title: "URL item", url: "https://example.test/item?b=2&a=1#comments" },
      { title: "Hash item", context: { z: 2, a: 1 } }
    ]
  });
  result = Artifacts.mergeCollectionBatch(result.dataset, {
    collectionId: "generic",
    pageIdentity: "/list?page=2",
    records: [
      { title: "URL item changed title", url: "https://example.test/item?a=1&b=2" },
      { context: { a: 1, z: 2 }, title: "Hash item" }
    ]
  });
  assert.equal(result.addedCount, 0);
  assert.equal(result.duplicateCount, 2);
  assert.equal(result.dataset.status, "stalled");
  assert.equal(result.dataset.stallReason, Artifacts.STALL_REASONS.ZERO_NEW_RECORDS);
});

test("collection ledger identifies a repeated page independently of record identity", () => {
  const first = Artifacts.mergeCollectionBatch(null, {
    collectionId: "loop",
    targetCount: 10,
    pageIdentity: {
      url: "https://example.test/page/1",
      documentId: "document-a",
      domRevision: 4,
      sourceSliceDigest: "same-slice"
    },
    records: [{ title: "First" }]
  });
  const repeated = Artifacts.mergeCollectionBatch(first.dataset, {
    collectionId: "loop",
    targetCount: 10,
    pageIdentity: {
      url: "https://example.test/page/1",
      documentId: "document-b",
      domRevision: 900,
      sourceSliceDigest: "same-slice"
    },
    records: [{ title: "A dynamically changed row" }]
  });
  assert.equal(repeated.addedCount, 1);
  assert.equal(repeated.dataset.status, "stalled");
  assert.equal(repeated.dataset.stallReason, Artifacts.STALL_REASONS.REPEATED_PAGE);
  assert.equal(repeated.dataset.pages.at(-1).repeated, true);
  assert.equal(repeated.dataset.pages.at(-1).identity, "https://example.test/page/1|slice:same-slice");
});

test("two 20-row content batches reach an exact 40-row target", () => {
  const makeRows = (start) => Array.from({ length: 20 }, (_, index) => ({
    key: String(start + index),
    title: `Title ${start + index}`,
    url: `https://example.test/post/${start + index}`
  }));
  const first = Artifacts.mergeCollectionBatch(null, {
    collectionId: "forty",
    collectionName: "Forty titles",
    targetCount: 40,
    pageIdentity: {
      url: "https://example.test/board?page=1",
      documentId: "doc-1",
      domRevision: 3,
      sourceSliceDigest: "slice-1"
    },
    records: makeRows(1)
  });
  const second = Artifacts.mergeCollectionBatch(first.dataset, {
    collectionId: "forty",
    collectionName: "Forty titles",
    targetCount: 40,
    pageIdentity: {
      url: "https://example.test/board?page=2",
      documentId: "doc-2",
      domRevision: 1,
      sourceSliceDigest: "slice-2"
    },
    records: makeRows(21)
  });
  assert.equal(second.dataset.rows.length, 40);
  assert.equal(second.dataset.pages.length, 2);
  assert.equal(second.dataset.status, "reached");
  assert.equal(second.addedCount, 20);
});

test("CSV derives dynamic columns, uses CRLF and neutralizes spreadsheet formulas", () => {
  const csv = Artifacts.datasetToCsv({
    version: "1.0",
    name: "Safe export",
    records: [
      { title: "=HYPERLINK(\"https://bad.test\")", score: -3 },
      { title: "  @SUM(A1:A2)", extra: "comma,value" },
      { title: "\tcommand", extra: "line\nbreak" }
    ]
  });
  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.match(csv, /"title","score","extra"\r\n/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.test""\)"/);
  assert.match(csv, /"'  @SUM\(A1:A2\)"/);
  assert.match(csv, /"'\tcommand"/);
  assert.match(csv, /"comma,value"/);
  assert.match(csv, /"line\nbreak"/);
  assert.equal(csv.endsWith("\r\n"), true);
});

test("default exports omit runtime identity fields while explicit requested columns stay locked", () => {
  const dataset = Artifacts.normalizeDataset({
    name: "Requested titles",
    rows: [{
      key: "internal-key",
      title: "Visible title",
      url: "https://example.test/post/1",
      provenance: { source: "runtime" }
    }]
  });
  assert.deepEqual(dataset.columns.map((column) => column.key), ["title", "url"]);
  assert.doesNotMatch(Artifacts.datasetToCsv(dataset), /internal-key|provenance|runtime/);

  const first = Artifacts.mergeCollectionBatch(null, {
    collectionId: "titles-only",
    targetCount: 2,
    columns: [{ key: "title", label: "Title" }],
    pageIdentity: { url: "https://example.test/board", sourceSliceDigest: "one" },
    records: [{ key: "1", title: "One", url: "/post/1" }]
  });
  const second = Artifacts.mergeCollectionBatch(first.dataset, {
    collectionId: "titles-only",
    targetCount: 2,
    pageIdentity: { url: "https://example.test/board", sourceSliceDigest: "two" },
    records: [{ key: "2", title: "Two", url: "/post/2", context: "extra" }]
  });
  assert.equal(second.dataset.columnsExplicit, true);
  assert.deepEqual(second.dataset.columns, [{ key: "title", label: "Title" }]);
  assert.match(Artifacts.datasetToCsv(second.dataset), /^\uFEFF"Title"\r\n"One"\r\n"Two"\r\n$/);
});

test("XLSX output is a genuine stored OOXML ZIP with inline strings", () => {
  const bytes = Artifacts.datasetToXlsx({
    version: "1.0",
    name: "Board",
    records: [
      { title: "=not-a-formula", count: 2, active: true },
      { title: "A & <B>", count: 3, active: false }
    ]
  }, { sheetName: "'Bad[]:*?/\\ sheet name that is much too long'" });
  assert.equal(bytes instanceof Uint8Array, true);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const entries = zipEntries(bytes);
  assert.deepEqual(
    [...entries.keys()],
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml"
    ]
  );
  const workbook = entries.get("xl/workbook.xml");
  const sheetName = workbook.match(/<sheet name="([^"]+)"/)[1];
  assert.equal([...sheetName].length <= 31, true);
  assert.doesNotMatch(sheetName, /[\\/?*:[\]]/);
  const sheet = entries.get("xl/worksheets/sheet1.xml");
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=not-a-formula<\/t>/);
  assert.doesNotMatch(sheet, /<f>/);
  assert.match(sheet, /A &amp; &lt;B&gt;/);
  assert.match(sheet, /t="n"><v>2<\/v>/);
  assert.match(sheet, /t="b"><v>1<\/v>/);
});

test("workflow sets retain only semantic portable fields and round-trip as JSON", () => {
  const created = Artifacts.createWorkflowSet({
    setType: "test",
    name: "Board collection",
    description: "Collect a bounded result and verify it.",
    parameters: [{
      name: "limit",
      description: "Requested row count",
      required: true,
      defaultValue: 40
    }],
    steps: [{
      id: "collect-board",
      goalTemplate: "Collect {{limit}} board titles.",
      completionCriteria: ["Exactly {{limit}} unique rows are collected."],
      outputContract: {
        description: "One row per board post",
        type: "table",
        fields: [{ name: "title", label: "Title", type: "string", required: true }],
        formats: ["csv", "xlsx"],
        targetCount: 40
      },
      assertions: [{
        type: "record_count",
        operator: "equals",
        expected: 40
      }],
      failurePolicy: "continue"
    }]
  });
  assert.equal(created.schemaVersion, "1.0");
  assert.equal(created.kind, "workflow-set");
  assert.equal(created.setType, "test");
  assert.match(created.id, /^workflow-/);
  assert.equal(created.steps.length, 1);
  assert.deepEqual(Artifacts.normalizeWorkflowSet(Artifacts.workflowSetToJson(created)), created);
  const imported = Artifacts.normalizeWorkflowSet(created, { regenerateId: true });
  assert.notEqual(imported.id, created.id);
});

test("workflow import rejects raw browser traces, unknown fields, future versions and oversized step lists", () => {
  const valid = {
    schemaVersion: "1.0",
    kind: "workflow-set",
    id: "workflow-portable",
    setType: "automation",
    name: "Portable",
    description: "",
    siteScope: { origin: "https://example.test", enforcement: "same-origin" },
    parameters: [],
    steps: [{
      id: "step-1",
      goalTemplate: "Read the visible title.",
      completionCriteria: ["A title is returned."],
      outputContract: null,
      assertions: [],
      failurePolicy: "stop"
    }]
  };
  assert.throws(
    () => Artifacts.normalizeWorkflowSet({
      ...valid,
      steps: [{ ...valid.steps[0], selector: "#result" }]
    }),
    /selector.*not allowed/i
  );
  assert.throws(
    () => Artifacts.normalizeWorkflowSet({ ...valid, actionTrace: [] }),
    /actionTrace.*not allowed/i
  );
  assert.throws(
    () => Artifacts.normalizeWorkflowSet({ ...valid, cookies: [] }),
    /not allowed|not a supported portable workflow field/i
  );
  assert.throws(
    () => Artifacts.normalizeWorkflowSet({ ...valid, schemaVersion: "2.0" }),
    /Unsupported workflow set schemaVersion/
  );
  assert.throws(
    () => Artifacts.normalizeWorkflowSet({ ...valid, steps: Array(21).fill(valid.steps[0]) }),
    /between 1 and 20/
  );
});
