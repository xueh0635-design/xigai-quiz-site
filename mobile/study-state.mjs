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
  delete copy._resumeSource;
  return copy;
}

export function sessionDrafts(row, records = {}) {
  if (row?.kind !== "session" || !row.payload) return [];
  const result = [];
  for (const [index, candidate] of [row.payload, row.payload.chapterStudy?.pausedPractice].entries()) {
    const draft = plainSession(candidate);
    if (!draft) continue;
    const previous = records["draft:" + draft.sid];
    const updatedAt = Number(draft.updatedAt) || 0;
    // Legacy clients advance the resume revision without updating (or adding)
    // updatedAt. A paused child is different: changes to the active resume do
    // not establish that its embedded paused copy was edited again.
    let revision = Math.max(1, index && updatedAt ? updatedAt : Number(row.revision) || 0);
    const source = { revision: Number(row.revision) || 0, change_id: String(row.change_id || "") };
    const previousSource = !index && !previous?.deleted && previous?.payload?._resumeSource;
    if (previousSource) {
      if (!isNewer(source, previousSource)) continue;
      // Two legacy devices may share a timestamp. Preserve their full source
      // ordering, while giving the independently synced child a newer revision
      // so a fresh random change ID cannot lose to its prior server version.
      revision = Math.max(revision, previous.revision + 1);
    } else if (previous && (previous.revision >= revision || (index && !updatedAt))) continue;
    const chapterReview = draft.wrongBookReview && draft.routePlan?.chapter;
    const complete = !chapterReview && (draft.testSubmitted || draft.index >= draft.ids.length);
    result.push({ kind: "draft", record_key: draft.sid,
      payload: complete ? null : { ...draft, updatedAt: revision, ...(!index ? { _resumeSource: source } : {}) }, revision });
  }
  return result;
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
  for (const row of Object.values(cache.records)) {
    if (row.deleted) continue;
    if (row.kind === "history") result.history[row.record_key] = row.payload;
    if (row.kind === "star") result.stars[row.record_key] = row.payload;
    if (row.kind === "note" && typeof row.payload === "string" && row.payload) result.notes[row.record_key] = row.payload;
    if (row.kind === "session" && row.payload && isNewer(row, latest)) latest = row;
    if (row.kind === "draft") {
      const draft = plainSession(row.payload);
      if (draft) result.drafts[row.record_key] = draft;
    }
    if (row.kind === "test" && row.payload?.chapter && row.payload?.bank) {
      const key = row.payload.bank + ":" + row.payload.chapter;
      result.chapterTests = mergeChapterTests(result.chapterTests, { [key]: row.payload });
    }
  }
  result.session = latest?.payload || null;
  result.chapterTests = mergeChapterTests(result.session?.chapterStudy?.tests, result.chapterTests);
  let currentDraft = result.session && cache.records["draft:" + result.session.sid];
  for (const draft of sessionDrafts(latest, cache.records)) {
    if (draft.payload) result.drafts[draft.record_key] = plainSession(draft.payload);
    else delete result.drafts[draft.record_key];
    if (draft.record_key === result.session?.sid) currentDraft = draft;
  }
  if (currentDraft && currentDraft.revision >= latest.revision) {
    if (!currentDraft.deleted && currentDraft.payload) {
      result.session = { ...plainSession(currentDraft.payload),
        chapterStudy: { ...result.session.chapterStudy, tests: result.chapterTests } };
    } else if (!result.session.testSubmitted && result.session.index < result.session.ids?.length) {
      // The resume pointer may arrive on a different sync page from its draft.
      // A newer completed/deleted draft must also stop the UI resuming that
      // older incomplete pointer. Submitted result snapshots can still display.
      result.session = null;
    }
  }
  return result;
}
