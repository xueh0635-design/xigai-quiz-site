// The study model is shared by the page and persistence layer. It has no DOM or
// account dependencies: signing in never imports another scope's records.
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const recordKey = (row) => row.kind + ":" + row.record_key;
export const isNewer = (row, other) => !other || row.revision > other.revision ||
  (row.revision === other.revision && row.change_id > other.change_id);

export function mergeChapterTests(first, second) {
  const result = { ...object(first) };
  for (const [key, value] of Object.entries(object(second))) {
    if (!value || typeof value !== "object") continue;
    const previous = result[key];
    if (!previous || Number(value.completedAt || 0) >= Number(previous.completedAt || 0)) result[key] = value;
  }
  return result;
}

export function plainSession(session) {
  if (!session || typeof session.sid !== "string" || !Array.isArray(session.ids)) return null;
  const copy = structuredClone(session);
  delete copy.chapterStudy;
  return copy;
}

export function mergeRecord(row, previous) {
  if (!previous) return structuredClone(row);
  const [older, newer] = isNewer(row, previous) ? [previous, row] : [row, previous];
  const result = structuredClone(newer);
  if (result.kind === "session" && result.payload && older.payload) {
    const tests = mergeChapterTests(older.payload.chapterStudy?.tests, result.payload.chapterStudy?.tests);
    if (Object.keys(tests).length) result.payload.chapterStudy = { ...result.payload.chapterStudy, tests };
  }
  return result;
}

export function emptyCache() {
  return { schemaVersion: 2, records: {}, pending: {}, cursor: 0, v2RetryAt: 0 };
}

export function normalizeCache(value) {
  const result = emptyCache();
  for (const field of ["records", "pending"]) {
    for (const row of Object.values(object(value?.[field]))) {
      if (!row || typeof row.kind !== "string" || typeof row.record_key !== "string") continue;
      const normalized = { ...row, revision: Number(row.revision) || 0, change_id: String(row.change_id || "") };
      result[field][recordKey(normalized)] = normalized;
    }
  }
  result.cursor = Number.isSafeInteger(value?.cursor) && value.cursor >= 0 ? value.cursor : 0;
  result.v2RetryAt = Number(value?.v2RetryAt) || 0;
  return result;
}

export function guestCache(value) {
  const result = emptyCache();
  for (const [field, kind] of [["history", "history"], ["stars", "star"], ["notes", "note"], ["drafts", "draft"]]) {
    for (const [record_key, payload] of Object.entries(object(value?.[field]))) {
      const row = { kind, record_key, payload, revision: Number(payload?.last || payload?.updatedAt) || 0, change_id: "legacy-guest" };
      result.records[recordKey(row)] = row;
    }
  }
  if (value?.session) result.records["session:resume"] = {
    kind: "session", record_key: "resume", payload: value.session, revision: 0, change_id: "legacy-guest",
  };
  return result;
}

export function stateFromCache(cache) {
  const result = { history: {}, stars: {}, notes: {}, session: null, drafts: {}, chapterTests: {} };
  let latest;
  const removedDrafts = new Set();
  for (const row of Object.values(cache.records)) {
    if (row.deleted) {
      if (row.kind === "draft") removedDrafts.add(row.record_key);
      continue;
    }
    if (row.kind === "history") result.history[row.record_key] = row.payload;
    if (row.kind === "star") result.stars[row.record_key] = row.payload;
    if (row.kind === "note" && typeof row.payload === "string" && row.payload) result.notes[row.record_key] = row.payload;
    if (row.kind === "session" && row.payload && isNewer(row, latest)) latest = row;
    if (row.kind === "draft") {
      if (row.payload) result.drafts[row.record_key] = row.payload;
      else removedDrafts.add(row.record_key);
    }
    if (row.kind === "test" && row.payload?.chapter && row.payload?.bank) {
      const key = row.payload.bank + ":" + row.payload.chapter;
      result.chapterTests = mergeChapterTests(result.chapterTests, { [key]: row.payload });
    }
  }
  result.session = latest?.payload || null;
  result.chapterTests = mergeChapterTests(result.session?.chapterStudy?.tests, result.chapterTests);
  for (const candidate of [result.session, result.session?.chapterStudy?.pausedPractice]) {
    const draft = plainSession(candidate);
    if (!draft || removedDrafts.has(draft.sid) || draft.testSubmitted || draft.index >= draft.ids.length) continue;
    if (!result.drafts[draft.sid] || Number(draft.updatedAt || 0) > Number(result.drafts[draft.sid].updatedAt || 0)) {
      result.drafts[draft.sid] = draft;
    }
  }
  return result;
}
