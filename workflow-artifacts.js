(function initializeWorkflowArtifacts(globalScope, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (globalScope && typeof globalScope === "object") {
    globalScope.WebWorkflowArtifacts = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createWorkflowArtifactsApi() {
  "use strict";

  const DATASET_VERSION = "1.0";
  const WORKFLOW_SET_VERSION = "1.0";
  const MAX_DATASET_RECORDS = 100000;
  const MAX_PAGE_HISTORY = 10000;
  const MAX_WORKFLOW_STEPS = 20;
  const MAX_WORKFLOW_BYTES = 512 * 1024;
  const STALL_REASONS = Object.freeze({
    REPEATED_PAGE: "repeated-page",
    ZERO_NEW_RECORDS: "zero-new-records"
  });
  const DATASET_STATUSES = new Set(["collecting", "reached", "stalled"]);
  const INTERNAL_DATASET_COLUMNS = new Set(["key", "provenance"]);
  const FORBIDDEN_WORKFLOW_KEYS = new Set([
    "action",
    "actions",
    "actiontrace",
    "binding",
    "bindings",
    "coordinates",
    "cookie",
    "cookies",
    "cssselector",
    "elementref",
    "elementrefs",
    "evidence",
    "executiontrace",
    "history",
    "headers",
    "nodeid",
    "ref",
    "refs",
    "selector",
    "selectors",
    "password",
    "secret",
    "secrets",
    "settings",
    "statebinding",
    "targetref",
    "token",
    "trace",
    "xpath"
  ]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function assertPlainObject(value, label) {
    if (!isPlainObject(value)) {
      throw new TypeError(`${label} must be a plain object.`);
    }
  }

  function cloneJsonValue(value, path, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must contain only finite numbers.`);
      }
      return value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        throw new TypeError(`${path} must not contain circular references.`);
      }
      seen.add(value);
      const result = value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`, seen));
      seen.delete(value);
      return result;
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`${path} must contain only JSON-compatible values.`);
    }
    if (seen.has(value)) {
      throw new TypeError(`${path} must not contain circular references.`);
    }
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new TypeError(`${path} contains an unsafe property name.`);
      }
      const item = value[key];
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`${path}.${key} must be JSON-compatible.`);
      }
      Object.defineProperty(result, key, {
        value: cloneJsonValue(item, `${path}.${key}`, seen),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    seen.delete(value);
    return result;
  }

  function cloneJson(value, path = "value") {
    return cloneJsonValue(value, path, new Set());
  }

  function stableSerialize(value) {
    if (value === null) {
      return "null";
    }
    if (typeof value === "string") {
      return JSON.stringify(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(stableSerialize).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }

  function stableHash(value) {
    const text = stableSerialize(value);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 0x01000193) >>> 0;
      second ^= code + index;
      second = Math.imul(second, 0x85ebca6b) >>> 0;
      second ^= second >>> 13;
    }
    return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
  }

  function canonicalizeUrl(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) {
      return "";
    }
    try {
      const isRelative = !/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.startsWith("//");
      const url = new URL(raw, "https://workflow-artifacts.invalid/");
      url.hash = "";
      const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      ));
      url.search = "";
      for (const [key, item] of sorted) {
        url.searchParams.append(key, item);
      }
      if (isRelative) {
        return `${url.pathname}${url.search}`;
      }
      return url.href;
    } catch {
      return raw.replace(/#.*$/, "");
    }
  }

  function normalizeTargetCount(value, label = "targetCount") {
    if (value === null || typeof value === "undefined" || value === "") {
      return null;
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_DATASET_RECORDS) {
      throw new RangeError(`${label} must be an integer between 0 and ${MAX_DATASET_RECORDS}.`);
    }
    return count;
  }

  function normalizeRequiredString(value, label, maxLength = 1000) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`${label} must be a non-empty string.`);
    }
    if (value.length > maxLength) {
      throw new RangeError(`${label} must be at most ${maxLength} characters.`);
    }
    return value.trim();
  }

  function normalizeOptionalString(value, label, maxLength = 1000) {
    if (value === null || typeof value === "undefined") {
      return "";
    }
    if (typeof value !== "string") {
      throw new TypeError(`${label} must be a string.`);
    }
    if (value.length > maxLength) {
      throw new RangeError(`${label} must be at most ${maxLength} characters.`);
    }
    return value.trim();
  }

  function normalizeRecord(record, index) {
    assertPlainObject(record, `records[${index}]`);
    return cloneJson(record, `records[${index}]`);
  }

  function findRecordUrl(record) {
    for (const field of ["url", "href", "link", "sourceUrl"]) {
      if (typeof record[field] === "string" && record[field].trim()) {
        return record[field];
      }
    }
    return "";
  }

  function recordIdentity(record, keyField) {
    let explicitKey;
    if (keyField && Object.prototype.hasOwnProperty.call(record, keyField)) {
      explicitKey = record[keyField];
    } else if (Object.prototype.hasOwnProperty.call(record, "key")) {
      explicitKey = record.key;
    }
    if (explicitKey !== null && typeof explicitKey !== "undefined" && String(explicitKey).trim()) {
      return `key:${stableSerialize(explicitKey)}`;
    }
    const canonicalUrl = canonicalizeUrl(findRecordUrl(record));
    if (canonicalUrl) {
      return `url:${canonicalUrl}`;
    }
    return `hash:${stableHash(record)}`;
  }

  function normalizePageDescriptor(value, provenance) {
    if (typeof value === "string") {
      const identity = normalizeRequiredString(value, "pageIdentity", 8000);
      const url = canonicalizeUrl(identity);
      return {
        identity: url || identity,
        url: url || "",
        documentId: "",
        sourceSliceDigest: ""
      };
    }
    const source = isPlainObject(value) ? value : {};
    const provenanceSource = isPlainObject(provenance) ? provenance : {};
    const rawUrl = normalizeOptionalString(
      source.url ?? provenanceSource.url,
      "pageIdentity.url",
      8000
    );
    const url = canonicalizeUrl(rawUrl);
    const sourceSliceDigest = normalizeOptionalString(
      source.sourceSliceDigest,
      "pageIdentity.sourceSliceDigest",
      1000
    );
    const documentId = normalizeOptionalString(source.documentId, "pageIdentity.documentId", 1000);
    const suppliedIdentity = normalizeOptionalString(source.identity, "pageIdentity.identity", 8000);
    const identity = url
      ? `${url}${sourceSliceDigest ? `|slice:${sourceSliceDigest}` : ""}`
      : suppliedIdentity || (sourceSliceDigest ? `slice:${sourceSliceDigest}` : "");
    if (!identity) {
      throw new TypeError("pageIdentity requires a URL, sourceSliceDigest, or identity.");
    }
    return { identity, url, documentId, sourceSliceDigest };
  }

  function normalizeColumns(columns) {
    if (columns === null || typeof columns === "undefined") {
      return [];
    }
    if (!Array.isArray(columns) || columns.length > 512) {
      throw new TypeError("columns must be an array with at most 512 entries.");
    }
    const seen = new Set();
    return columns.map((column, index) => {
      const normalized = typeof column === "string"
        ? { key: normalizeRequiredString(column, `columns[${index}]`, 200), label: column.trim() }
        : (() => {
            assertPlainObject(column, `columns[${index}]`);
            return {
              key: normalizeRequiredString(column.key, `columns[${index}].key`, 200),
              label: normalizeOptionalString(column.label ?? column.key, `columns[${index}].label`, 500)
            };
          })();
      if (seen.has(normalized.key)) {
        throw new TypeError(`columns contains the duplicate key "${normalized.key}".`);
      }
      seen.add(normalized.key);
      return normalized;
    });
  }

  function isDefaultDatasetColumn(key) {
    const value = String(key || "");
    return Boolean(value)
      && !value.startsWith("_")
      && !INTERNAL_DATASET_COLUMNS.has(value);
  }

  function normalizeDataset(input) {
    assertPlainObject(input, "dataset");
    if (input.version && input.version !== DATASET_VERSION) {
      throw new TypeError(`Unsupported dataset version "${input.version}".`);
    }
    const rowsInput = Array.isArray(input.rows)
      ? input.rows
      : (Array.isArray(input.records) ? input.records : []);
    if (rowsInput.length > MAX_DATASET_RECORDS) {
      throw new RangeError(`dataset cannot contain more than ${MAX_DATASET_RECORDS} records.`);
    }
    const keyField = normalizeOptionalString(input.keyField, "keyField", 200);
    const rows = [];
    const recordKeys = [];
    const seenKeys = new Set();
    for (let index = 0; index < rowsInput.length; index += 1) {
      const record = normalizeRecord(rowsInput[index], index);
      const identity = recordIdentity(record, keyField);
      if (!seenKeys.has(identity)) {
        seenKeys.add(identity);
        rows.push(record);
        recordKeys.push(identity);
      }
    }
    const targetCount = normalizeTargetCount(input.targetCount);
    if (targetCount !== null && rows.length > targetCount) {
      rows.length = targetCount;
      recordKeys.length = targetCount;
    }
    const visitedInput = Array.isArray(input.visitedPageIdentities) ? input.visitedPageIdentities : [];
    if (visitedInput.length > MAX_PAGE_HISTORY) {
      throw new RangeError(`visitedPageIdentities cannot contain more than ${MAX_PAGE_HISTORY} entries.`);
    }
    const visitedPageIdentities = [...new Set(visitedInput.map((identity, index) => (
      normalizeRequiredString(identity, `visitedPageIdentities[${index}]`, 8000)
    )))];
    const pagesInput = Array.isArray(input.pages)
      ? input.pages
      : (Array.isArray(input.pageHistory) ? input.pageHistory : []);
    if (pagesInput.length > MAX_PAGE_HISTORY) {
      throw new RangeError(`pages cannot contain more than ${MAX_PAGE_HISTORY} entries.`);
    }
    const pages = pagesInput.map((entry, index) => {
      assertPlainObject(entry, `pages[${index}]`);
      const descriptor = normalizePageDescriptor(entry, null);
      const identity = descriptor.identity;
      if (!visitedPageIdentities.includes(identity)) {
        visitedPageIdentities.push(identity);
      }
      return {
        ...descriptor,
        recordCount: normalizeTargetCount(entry.recordCount ?? 0, `pages[${index}].recordCount`) ?? 0,
        addedCount: normalizeTargetCount(entry.addedCount ?? 0, `pages[${index}].addedCount`) ?? 0,
        duplicateCount: normalizeTargetCount(entry.duplicateCount ?? 0, `pages[${index}].duplicateCount`) ?? 0,
        repeated: Boolean(entry.repeated)
      };
    });
    let status = DATASET_STATUSES.has(input.status) ? input.status : "collecting";
    let stallReason = input.stallReason === STALL_REASONS.REPEATED_PAGE
      || input.stallReason === STALL_REASONS.ZERO_NEW_RECORDS
      ? input.stallReason
      : null;
    if (targetCount !== null && rows.length >= targetCount) {
      status = "reached";
      stallReason = null;
    } else if (status !== "stalled") {
      status = "collecting";
      stallReason = null;
    } else if (!stallReason) {
      throw new TypeError("A stalled dataset must include a supported stallReason.");
    }
    const columns = normalizeColumns(input.columns);
    const columnsExplicit = Object.hasOwn(input, "columnsExplicit")
      ? Boolean(input.columnsExplicit)
      : columns.length > 0;
    if (!columns.length) {
      const inferredKeys = [];
      const inferredKeySet = new Set();
      for (const row of rows) {
        for (const key of Object.keys(row).filter(isDefaultDatasetColumn)) {
          if (!inferredKeySet.has(key)) {
            inferredKeySet.add(key);
            inferredKeys.push(key);
          }
        }
      }
      columns.push(...inferredKeys.map((key) => ({ key, label: key })));
    }
    return {
      version: DATASET_VERSION,
      kind: "structured-dataset",
      id: normalizeOptionalString(input.id ?? input.collectionId, "id", 500)
        || `dataset-${stableHash({
          name: input.name ?? input.collectionName ?? "",
          scope: input.scope ?? null
        })}`,
      name: normalizeOptionalString(input.name ?? input.collectionName, "name", 500),
      targetCount,
      keyField,
      scope: typeof input.scope === "undefined" ? null : cloneJson(input.scope, "scope"),
      columns,
      columnsExplicit,
      rows,
      recordKeys,
      visitedPageIdentities,
      pages,
      lastAddedCount: normalizeTargetCount(input.lastAddedCount ?? 0, "lastAddedCount") ?? 0,
      status,
      stallReason,
      provenance: typeof input.provenance === "undefined" ? null : cloneJson(input.provenance, "provenance")
    };
  }

  function mergeCollectionBatch(existing, batch) {
    assertPlainObject(batch, "batch");
    if (batch.version && batch.version !== DATASET_VERSION) {
      throw new TypeError(`Unsupported collection batch version "${batch.version}".`);
    }
    if (!Array.isArray(batch.records)) {
      throw new TypeError("batch.records must be an array.");
    }
    if (batch.records.length > MAX_DATASET_RECORDS) {
      throw new RangeError(`batch.records cannot contain more than ${MAX_DATASET_RECORDS} records.`);
    }
    const batchCollectionId = normalizeOptionalString(batch.id ?? batch.collectionId, "batch.collectionId", 500);
    const batchTargetCount = normalizeTargetCount(batch.targetCount, "batch.targetCount");
    const batchKeyField = normalizeOptionalString(batch.keyField, "batch.keyField", 200);
    const dataset = existing
      ? normalizeDataset(existing)
      : normalizeDataset({
          version: DATASET_VERSION,
          id: batchCollectionId,
          name: batch.collectionName,
          targetCount: batchTargetCount,
          keyField: batchKeyField,
          scope: batch.scope,
          columns: batch.columns,
          provenance: batch.provenance,
          rows: []
        });
    if (dataset.id && batchCollectionId && dataset.id !== batchCollectionId) {
      throw new TypeError("batch.collectionId does not match the existing dataset.");
    }
    if (dataset.targetCount !== null && batchTargetCount !== null && dataset.targetCount !== batchTargetCount) {
      throw new TypeError("batch.targetCount cannot change an existing dataset target.");
    }
    if (dataset.targetCount === null && batchTargetCount !== null) {
      dataset.targetCount = batchTargetCount;
    }
    if (!dataset.name && batch.collectionName) {
      dataset.name = normalizeOptionalString(batch.collectionName, "batch.collectionName", 500);
    }
    if (!dataset.keyField && batchKeyField) {
      dataset.keyField = batchKeyField;
    }
    if (!dataset.scope && typeof batch.scope !== "undefined") {
      dataset.scope = cloneJson(batch.scope, "batch.scope");
    }
    if (!dataset.provenance && typeof batch.provenance !== "undefined") {
      dataset.provenance = cloneJson(batch.provenance, "batch.provenance");
    }
    if (!dataset.columnsExplicit && Array.isArray(batch.columns) && batch.columns.length) {
      dataset.columns = normalizeColumns(batch.columns);
      dataset.columnsExplicit = true;
    }

    const page = normalizePageDescriptor(batch.pageIdentity, batch.provenance);
    const repeatedPage = dataset.visitedPageIdentities.includes(page.identity);
    const seenKeys = new Set(dataset.recordKeys);
    let addedCount = 0;
    let duplicateCount = 0;
    let truncatedCount = 0;
    for (let index = 0; index < batch.records.length; index += 1) {
      const record = normalizeRecord(batch.records[index], index);
      const identity = recordIdentity(record, dataset.keyField || batchKeyField);
      if (seenKeys.has(identity)) {
        duplicateCount += 1;
        continue;
      }
      seenKeys.add(identity);
      if (dataset.targetCount !== null && dataset.rows.length >= dataset.targetCount) {
        truncatedCount += 1;
        continue;
      }
      if (dataset.rows.length >= MAX_DATASET_RECORDS) {
        throw new RangeError(`dataset cannot contain more than ${MAX_DATASET_RECORDS} records.`);
      }
      dataset.rows.push(record);
      dataset.recordKeys.push(identity);
      addedCount += 1;
    }
    if (!dataset.columnsExplicit) {
      const columnKeys = new Set(dataset.columns.map((column) => column.key));
      for (const row of dataset.rows) {
        for (const key of Object.keys(row).filter(isDefaultDatasetColumn)) {
          if (!columnKeys.has(key)) {
            columnKeys.add(key);
            dataset.columns.push({ key, label: key });
          }
        }
      }
    }
    if (!repeatedPage) {
      dataset.visitedPageIdentities.push(page.identity);
    }
    dataset.pages.push({
      ...page,
      recordCount: batch.records.length,
      addedCount,
      duplicateCount,
      repeated: repeatedPage
    });
    if (dataset.pages.length > MAX_PAGE_HISTORY) {
      dataset.pages.splice(0, dataset.pages.length - MAX_PAGE_HISTORY);
    }
    dataset.lastAddedCount = addedCount;

    if (dataset.targetCount !== null && dataset.rows.length >= dataset.targetCount) {
      dataset.status = "reached";
      dataset.stallReason = null;
    } else if (repeatedPage) {
      dataset.status = "stalled";
      dataset.stallReason = STALL_REASONS.REPEATED_PAGE;
    } else if (addedCount === 0) {
      dataset.status = "stalled";
      dataset.stallReason = STALL_REASONS.ZERO_NEW_RECORDS;
    } else {
      dataset.status = "collecting";
      dataset.stallReason = null;
    }
    return { dataset, addedCount, duplicateCount, truncatedCount };
  }

  function deriveColumns(dataset, requestedColumns) {
    const explicit = normalizeColumns(requestedColumns ?? dataset.columns);
    if (explicit.length) {
      return explicit;
    }
    const keys = [];
    const seen = new Set();
    for (const record of dataset.rows) {
      for (const key of Object.keys(record)) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    return keys.map((key) => ({ key, label: key }));
  }

  function tabularValue(value) {
    if (value === null || typeof value === "undefined") {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return stableSerialize(value);
  }

  function neutralizeSpreadsheetFormula(value) {
    if (typeof value !== "string") {
      return value;
    }
    if (/^[\t\r]/.test(value) || /^\s*[=+\-@]/.test(value)) {
      return `'${value}`;
    }
    return value;
  }

  function quoteCsv(value) {
    const safeValue = neutralizeSpreadsheetFormula(tabularValue(value));
    return `"${safeValue.replace(/"/g, "\"\"")}"`;
  }

  function datasetToCsv(input, options = {}) {
    const dataset = normalizeDataset(input);
    const columns = deriveColumns(dataset, options.columns);
    const rows = [
      columns.map((column) => quoteCsv(column.label)).join(","),
      ...dataset.rows.map((record) => (
        columns.map((column) => quoteCsv(record[column.key])).join(",")
      ))
    ];
    const bom = options.bom === false ? "" : "\uFEFF";
    return `${bom}${rows.join("\r\n")}\r\n`;
  }

  function sanitizeXmlText(value) {
    return String(value).replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g,
      ""
    );
  }

  function escapeXml(value) {
    return sanitizeXmlText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function sanitizeSheetName(value) {
    let name = typeof value === "string" ? value.trim() : "";
    name = name
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/[\\/?*:[\]]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^'+|'+$/g, "")
      .trim();
    if (!name) {
      name = "Data";
    }
    return [...name].slice(0, 31).join("").trim();
  }

  function columnName(index) {
    let value = index + 1;
    let result = "";
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  function inlineStringCell(reference, value) {
    const text = escapeXml(tabularValue(value));
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
  }

  function valueCell(reference, value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return `<c r="${reference}" t="n"><v>${value}</v></c>`;
    }
    if (typeof value === "boolean") {
      return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
    }
    return inlineStringCell(reference, value);
  }

  function textEncoder() {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder();
    }
    return {
      encode(value) {
        return Uint8Array.from(Buffer.from(value, "utf8"));
      }
    };
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint16(buffer, offset, value) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeUint32(buffer, offset, value) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >>> 8) & 0xff;
    buffer[offset + 2] = (value >>> 16) & 0xff;
    buffer[offset + 3] = (value >>> 24) & 0xff;
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    if (total > 0xffffffff) {
      throw new RangeError("XLSX output exceeds the ZIP32 size limit.");
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  function createStoredZip(files) {
    const encoder = textEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
      const checksum = crc32(dataBytes);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      writeUint32(localHeader, 0, 0x04034b50);
      writeUint16(localHeader, 4, 20);
      writeUint16(localHeader, 6, 0x0800);
      writeUint16(localHeader, 8, 0);
      writeUint16(localHeader, 10, 0);
      writeUint16(localHeader, 12, 0x0021);
      writeUint32(localHeader, 14, checksum);
      writeUint32(localHeader, 18, dataBytes.length);
      writeUint32(localHeader, 22, dataBytes.length);
      writeUint16(localHeader, 26, nameBytes.length);
      writeUint16(localHeader, 28, 0);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      writeUint32(centralHeader, 0, 0x02014b50);
      writeUint16(centralHeader, 4, 20);
      writeUint16(centralHeader, 6, 20);
      writeUint16(centralHeader, 8, 0x0800);
      writeUint16(centralHeader, 10, 0);
      writeUint16(centralHeader, 12, 0);
      writeUint16(centralHeader, 14, 0x0021);
      writeUint32(centralHeader, 16, checksum);
      writeUint32(centralHeader, 20, dataBytes.length);
      writeUint32(centralHeader, 24, dataBytes.length);
      writeUint16(centralHeader, 28, nameBytes.length);
      writeUint16(centralHeader, 30, 0);
      writeUint16(centralHeader, 32, 0);
      writeUint16(centralHeader, 34, 0);
      writeUint16(centralHeader, 36, 0);
      writeUint32(centralHeader, 38, 0);
      writeUint32(centralHeader, 42, localOffset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);
      localOffset += localHeader.length + dataBytes.length;
    }
    const centralDirectory = concatBytes(centralParts);
    const end = new Uint8Array(22);
    writeUint32(end, 0, 0x06054b50);
    writeUint16(end, 4, 0);
    writeUint16(end, 6, 0);
    writeUint16(end, 8, files.length);
    writeUint16(end, 10, files.length);
    writeUint32(end, 12, centralDirectory.length);
    writeUint32(end, 16, localOffset);
    writeUint16(end, 20, 0);
    return concatBytes([...localParts, centralDirectory, end]);
  }

  function datasetToXlsx(input, options = {}) {
    const dataset = normalizeDataset(input);
    const columns = deriveColumns(dataset, options.columns);
    if (columns.length > 16384) {
      throw new RangeError("XLSX cannot contain more than 16,384 columns.");
    }
    if (dataset.rows.length + 1 > 1048576) {
      throw new RangeError("XLSX cannot contain more than 1,048,576 rows.");
    }
    const sheetName = sanitizeSheetName(options.sheetName || dataset.name);
    const rowXml = [];
    const headerCells = columns.map((column, columnIndex) => (
      inlineStringCell(`${columnName(columnIndex)}1`, column.label)
    )).join("");
    rowXml.push(`<row r="1">${headerCells}</row>`);
    dataset.rows.forEach((record, rowIndex) => {
      const excelRow = rowIndex + 2;
      const cells = columns.map((column, columnIndex) => (
        valueCell(`${columnName(columnIndex)}${excelRow}`, record[column.key])
      )).join("");
      rowXml.push(`<row r="${excelRow}">${cells}</row>`);
    });
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + `<sheetData>${rowXml.join("")}</sheetData></worksheet>`;
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
      + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    return createStoredZip([
      {
        name: "[Content_Types].xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
          + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
          + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
          + `<Default Extension="xml" ContentType="application/xml"/>`
          + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
          + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          + `</Types>`
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
          + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
          + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
          + `</Relationships>`
      },
      { name: "xl/workbook.xml", data: workbookXml },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
          + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
          + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
          + `</Relationships>`
      },
      { name: "xl/worksheets/sheet1.xml", data: sheetXml }
    ]);
  }

  function normalizedKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isForbiddenWorkflowKey(key) {
    const normalized = normalizedKey(key);
    return FORBIDDEN_WORKFLOW_KEYS.has(normalized)
      || /(?:actiontrace|executiontrace|statebinding|elementrefs?|selectors?|xpath)$/.test(normalized);
  }

  function assertNoUnsafeWorkflowFields(value, path = "workflowSet", seen = new Set()) {
    if (!value || typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      throw new TypeError(`${path} must not contain circular references.`);
    }
    seen.add(value);
    if (!Array.isArray(value) && !isPlainObject(value)) {
      throw new TypeError(`${path} must contain only plain JSON values.`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertNoUnsafeWorkflowFields(item, `${path}[${index}]`, seen));
    } else {
      for (const key of Object.keys(value)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor"
          || isForbiddenWorkflowKey(key)) {
          throw new TypeError(`${path}.${key} is not allowed in a portable workflow set.`);
        }
        assertNoUnsafeWorkflowFields(value[key], `${path}.${key}`, seen);
      }
    }
    seen.delete(value);
  }

  function assertAllowedKeys(value, allowed, path) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new TypeError(`${path}.${key} is not a supported portable workflow field.`);
      }
    }
  }

  function normalizeStringList(value, label, maxItems, itemMaxLength) {
    if (value === null || typeof value === "undefined") {
      return [];
    }
    if (!Array.isArray(value) || value.length > maxItems) {
      throw new TypeError(`${label} must be an array with at most ${maxItems} entries.`);
    }
    return value.map((item, index) => normalizeRequiredString(item, `${label}[${index}]`, itemMaxLength));
  }

  function normalizeParameter(parameter, index) {
    assertPlainObject(parameter, `parameters[${index}]`);
    assertAllowedKeys(parameter, new Set(["name", "description", "required", "defaultValue"]), `parameters[${index}]`);
    const normalized = {
      name: normalizeRequiredString(parameter.name, `parameters[${index}].name`, 200),
      description: normalizeOptionalString(parameter.description, `parameters[${index}].description`, 1000),
      required: Boolean(parameter.required)
    };
    if (Object.prototype.hasOwnProperty.call(parameter, "defaultValue")) {
      normalized.defaultValue = cloneJson(parameter.defaultValue, `parameters[${index}].defaultValue`);
    }
    return normalized;
  }

  function normalizeOutputContract(value, path) {
    if (value === null || typeof value === "undefined") {
      return null;
    }
    assertPlainObject(value, path);
    assertAllowedKeys(
      value,
      new Set([
        "kind",
        "itemDescription",
        "targetCount",
        "fields",
        "includeCriteria",
        "description",
        "type",
        "formats"
      ]),
      path
    );
    const fieldsInput = value.fields ?? [];
    if (!Array.isArray(fieldsInput) || fieldsInput.length > 512) {
      throw new TypeError(`${path}.fields must be an array with at most 512 entries.`);
    }
    const fields = fieldsInput.map((field, index) => {
      if (typeof field === "string") {
        return normalizeRequiredString(field, `${path}.fields[${index}]`, 200);
      }
      assertPlainObject(field, `${path}.fields[${index}]`);
      assertAllowedKeys(field, new Set(["name", "label", "type", "required"]), `${path}.fields[${index}]`);
      return {
        name: normalizeRequiredString(field.name, `${path}.fields[${index}].name`, 200),
        label: normalizeOptionalString(field.label ?? field.name, `${path}.fields[${index}].label`, 500),
        type: normalizeOptionalString(field.type || "string", `${path}.fields[${index}].type`, 100),
        required: Boolean(field.required)
      };
    });
    return {
      kind: normalizeOptionalString(value.kind, `${path}.kind`, 100),
      itemDescription: normalizeOptionalString(value.itemDescription, `${path}.itemDescription`, 1000),
      targetCount: normalizeTargetCount(value.targetCount, `${path}.targetCount`),
      fields,
      includeCriteria: normalizeStringList(value.includeCriteria, `${path}.includeCriteria`, 50, 1000),
      description: normalizeOptionalString(value.description, `${path}.description`, 2000),
      type: normalizeOptionalString(value.type, `${path}.type`, 100),
      formats: normalizeStringList(value.formats, `${path}.formats`, 12, 50),
    };
  }

  function normalizeWorkflowAssertion(assertion, stepIndex, assertionIndex) {
    const path = `steps[${stepIndex}].assertions[${assertionIndex}]`;
    assertPlainObject(assertion, path);
    assertAllowedKeys(assertion, new Set(["type", "operator", "expected"]), path);
    if (!Object.prototype.hasOwnProperty.call(assertion, "expected")) {
      throw new TypeError(`${path}.expected is required.`);
    }
    return {
      type: normalizeRequiredString(assertion.type, `${path}.type`, 200),
      operator: normalizeRequiredString(assertion.operator, `${path}.operator`, 200),
      expected: cloneJson(assertion.expected, `${path}.expected`)
    };
  }

  function normalizeWorkflowStep(step, index) {
    assertPlainObject(step, `steps[${index}]`);
    assertAllowedKeys(
      step,
      new Set([
        "id",
        "goalTemplate",
        "completionCriteria",
        "outputContract",
        "assertions",
        "failurePolicy"
      ]),
      `steps[${index}]`
    );
    const assertions = step.assertions ?? [];
    if (!Array.isArray(assertions) || assertions.length > 100) {
      throw new TypeError(`steps[${index}].assertions must be an array with at most 100 entries.`);
    }
    const failurePolicy = step.failurePolicy ?? "stop";
    if (failurePolicy !== "stop" && failurePolicy !== "continue") {
      throw new TypeError(`steps[${index}].failurePolicy must be "stop" or "continue".`);
    }
    return {
      id: normalizeOptionalString(step.id, `steps[${index}].id`, 500) || `step-${index + 1}`,
      goalTemplate: normalizeRequiredString(step.goalTemplate, `steps[${index}].goalTemplate`, 8000),
      completionCriteria: normalizeStringList(
        step.completionCriteria,
        `steps[${index}].completionCriteria`,
        20,
        2000
      ),
      outputContract: normalizeOutputContract(step.outputContract, `steps[${index}].outputContract`),
      assertions: assertions.map((assertion, assertionIndex) => (
        normalizeWorkflowAssertion(assertion, index, assertionIndex)
      )),
      failurePolicy
    };
  }

  function createLocalId(prefix) {
    const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return `${prefix}-${cryptoApi.randomUUID()}`;
    }
    const entropy = `${Date.now()}:${Math.random()}:${Math.random()}`;
    return `${prefix}-${stableHash(entropy)}-${Date.now().toString(36)}`;
  }

  function normalizeSiteScope(value) {
    if (value === null || typeof value === "undefined") {
      return { origin: "", enforcement: "same-origin" };
    }
    assertPlainObject(value, "workflowSet.siteScope");
    assertAllowedKeys(value, new Set(["origin", "enforcement"]), "workflowSet.siteScope");
    if ((value.enforcement ?? "same-origin") !== "same-origin") {
      throw new TypeError('workflowSet.siteScope.enforcement must be "same-origin".');
    }
    const origin = normalizeOptionalString(value.origin, "workflowSet.siteScope.origin", 2000);
    if (!origin) {
      return { origin: "", enforcement: "same-origin" };
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError("workflowSet.siteScope.origin must be a valid HTTP(S) origin.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new TypeError("workflowSet.siteScope.origin must contain only an HTTP(S) origin without a path.");
    }
    return { origin: parsed.origin, enforcement: "same-origin" };
  }

  function parseWorkflowInput(input) {
    if (typeof input === "string") {
      if (textEncoder().encode(input).length > MAX_WORKFLOW_BYTES) {
        throw new RangeError(`workflow set JSON cannot exceed ${MAX_WORKFLOW_BYTES} bytes.`);
      }
      try {
        return JSON.parse(input);
      } catch (error) {
        throw new TypeError(`workflow set JSON is invalid: ${error.message}`);
      }
    }
    return input;
  }

  function normalizeWorkflowSet(input, options = {}) {
    const parsed = parseWorkflowInput(input);
    assertPlainObject(parsed, "workflowSet");
    assertNoUnsafeWorkflowFields(parsed);
    assertAllowedKeys(
      parsed,
      new Set([
        "schemaVersion",
        "kind",
        "id",
        "setType",
        "name",
        "description",
        "siteScope",
        "parameters",
        "steps"
      ]),
      "workflowSet"
    );
    if (parsed.schemaVersion !== WORKFLOW_SET_VERSION) {
      throw new TypeError(`Unsupported workflow set schemaVersion "${parsed.schemaVersion}".`);
    }
    if (parsed.kind !== "workflow-set") {
      throw new TypeError('workflowSet.kind must be "workflow-set".');
    }
    if (parsed.setType !== "automation" && parsed.setType !== "test") {
      throw new TypeError('workflowSet.setType must be "automation" or "test".');
    }
    if (!Array.isArray(parsed.steps) || parsed.steps.length < 1 || parsed.steps.length > MAX_WORKFLOW_STEPS) {
      throw new RangeError(`workflowSet.steps must contain between 1 and ${MAX_WORKFLOW_STEPS} steps.`);
    }
    const parametersInput = parsed.parameters ?? [];
    if (!Array.isArray(parametersInput) || parametersInput.length > 100) {
      throw new TypeError("workflowSet.parameters must be an array with at most 100 entries.");
    }
    const parameters = parametersInput.map(normalizeParameter);
    const parameterNames = new Set();
    for (const parameter of parameters) {
      if (parameterNames.has(parameter.name)) {
        throw new TypeError(`workflowSet.parameters contains the duplicate name "${parameter.name}".`);
      }
      parameterNames.add(parameter.name);
    }
    const steps = parsed.steps.map(normalizeWorkflowStep);
    const stepIds = new Set();
    for (const step of steps) {
      if (stepIds.has(step.id)) {
        throw new TypeError(`workflowSet.steps contains the duplicate id "${step.id}".`);
      }
      stepIds.add(step.id);
    }
    const semantic = {
      schemaVersion: WORKFLOW_SET_VERSION,
      kind: "workflow-set",
      setType: parsed.setType,
      name: normalizeRequiredString(parsed.name, "workflowSet.name", 500),
      description: normalizeOptionalString(parsed.description, "workflowSet.description", 2000),
      siteScope: normalizeSiteScope(parsed.siteScope),
      parameters,
      steps
    };
    const preservedId = normalizeOptionalString(parsed.id, "workflowSet.id", 500);
    const normalized = {
      schemaVersion: semantic.schemaVersion,
      kind: semantic.kind,
      id: options.regenerateId
        ? createLocalId("workflow")
        : preservedId || `workflow-${stableHash(semantic)}`,
      setType: semantic.setType,
      name: semantic.name,
      description: semantic.description,
      siteScope: semantic.siteScope,
      parameters: semantic.parameters,
      steps: semantic.steps
    };
    const byteLength = textEncoder().encode(JSON.stringify(normalized)).length;
    if (byteLength > MAX_WORKFLOW_BYTES) {
      throw new RangeError(`workflow set cannot exceed ${MAX_WORKFLOW_BYTES} bytes.`);
    }
    return normalized;
  }

  function createWorkflowSet(input) {
    assertPlainObject(input, "workflowSet");
    return normalizeWorkflowSet({
      schemaVersion: WORKFLOW_SET_VERSION,
      kind: "workflow-set",
      id: input.id || createLocalId("workflow"),
      setType: input.setType || (
        input.kind === "automation" || input.kind === "test" ? input.kind : "automation"
      ),
      name: input.name,
      description: input.description,
      siteScope: input.siteScope,
      parameters: input.parameters,
      steps: input.steps
    });
  }

  function workflowSetToJson(input, options = {}) {
    const normalized = normalizeWorkflowSet(input);
    const spacing = options.pretty === false ? 0 : 2;
    const json = JSON.stringify(normalized, null, spacing);
    if (textEncoder().encode(json).length > MAX_WORKFLOW_BYTES) {
      throw new RangeError(`workflow set JSON cannot exceed ${MAX_WORKFLOW_BYTES} bytes.`);
    }
    return json;
  }

  return Object.freeze({
    DATASET_VERSION,
    WORKFLOW_SET_VERSION,
    MAX_WORKFLOW_STEPS,
    STALL_REASONS,
    normalizeDataset,
    mergeCollectionBatch,
    datasetToCsv,
    datasetToXlsx,
    createWorkflowSet,
    normalizeWorkflowSet,
    workflowSetToJson
  });
});
