/**
 * dsh-letterbox — pure state logic.
 *
 * No I/O and no host imports, so the host half and the tests share exactly one
 * implementation. Everything here is total: given junk input it returns an
 * empty or filtered state instead of throwing, except for `validateAdd`, which
 * is the one place a model-supplied payload must be rejected loudly.
 *
 * @module dsh-letterbox/store
 */

/** Item kinds the model may attach. */
export const KINDS = ['risk', 'note', 'decision', 'handoff'];
/** Priorities the model may attach. */
export const PRIORITIES = ['high', 'normal'];
/** Hard ceiling on one item's text, so a tool call cannot bloat the ledger. */
export const MAX_TEXT = 4000;
/** Hard ceiling on one item's source label. */
export const MAX_SOURCE = 200;
/** Item kinds rendered with a warning tone in the panel. */
export const HIGH_SIGNAL_KINDS = new Set(['risk', 'decision']);

/**
 * An empty ledger.
 * @returns {{`version`: number, sessions: Record<string, { items: object[] }>}}
 */
export function emptyState() {
  return { version: 1, sessions: {} };
}

/**
 * An empty per-session bucket.
 * `checkedAt` / `checkedTurn` record the last time the agent actually consulted
 * the box; `misses` counts turns that ended without doing so while unread
 * items existed.
 * @returns a fresh bucket.
 */
export function emptyBucket() {
  return { items: [], checkedAt: null, checkedTurn: null, misses: 0, lastMissAt: null };
}

/**
 * Normalize one stored item, dropping anything unreadable.
 * @param item - whatever the file held.
 * @returns a list with zero or one item.
 */
function normalizeItem(item) {
  if (item === null || typeof item !== 'object') return [];
  if (typeof item.id !== 'string' || item.id === '') return [];
  if (typeof item.text !== 'string' || item.text === '') return [];
  const text = item.text.slice(0, MAX_TEXT);
  const kind = KINDS.includes(item.kind) ? item.kind : 'note';
  const priority = PRIORITIES.includes(item.priority) ? item.priority : 'normal';
  const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : 0;
  const readAt = Number.isFinite(item.readAt) ? item.readAt : null;
  const source = typeof item.source === 'string' && item.source !== '' ? item.source.slice(0, MAX_SOURCE) : null;
  return [{ id: item.id, text, kind, priority, source, createdAt, readAt }];
}

/**
 * Normalize a ledger read from disk.
 * @param raw - parsed JSON, or anything else.
 * @returns a ledger safe to mutate.
 */
export function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object') return emptyState();
  const sessions = raw.sessions;
  if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) return emptyState();
  const next = emptyState();
  for (const [sessionId, bucket] of Object.entries(sessions)) {
    if (typeof sessionId !== 'string' || sessionId === '') continue;
    const items = bucket !== null && typeof bucket === 'object' && Array.isArray(bucket.items) ? bucket.items : [];
    const normalized = [];
    for (const item of items) normalized.push(...normalizeItem(item));
    next.sessions[sessionId] = {
      items: normalized,
      checkedAt: Number.isFinite(bucket?.checkedAt) ? bucket.checkedAt : null,
      checkedTurn: typeof bucket?.checkedTurn === 'string' ? bucket.checkedTurn : null,
      misses: Number.isInteger(bucket?.misses) && bucket.misses > 0 ? bucket.misses : 0,
      lastMissAt: Number.isFinite(bucket?.lastMissAt) ? bucket.lastMissAt : null,
    };
  }
  return next;
}

/**
 * Validate a model-supplied `letterbox_add` payload.
 * @param input - tool arguments.
 * @returns a clean payload.
 * @throws when the payload cannot be stored as written.
 */
export function validateAdd(input) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text === '') throw new Error('letterbox_add: text must be a non-empty string');
  if (text.length > MAX_TEXT) throw new Error('letterbox_add: text must be at most ' + MAX_TEXT + ' characters');
  const kind = raw.kind === undefined ? 'note' : raw.kind;
  if (!KINDS.includes(kind)) throw new Error('letterbox_add: kind must be one of ' + KINDS.join(', '));
  const priority = raw.priority === undefined ? 'normal' : raw.priority;
  if (!PRIORITIES.includes(priority)) throw new Error('letterbox_add: priority must be one of ' + PRIORITIES.join(', '));
  let source = null;
  if (raw.source !== undefined && raw.source !== null) {
    if (typeof raw.source !== 'string') throw new Error('letterbox_add: source must be a string');
    const trimmed = raw.source.trim();
    if (trimmed.length > MAX_SOURCE) throw new Error('letterbox_add: source must be at most ' + MAX_SOURCE + ' characters');
    source = trimmed === '' ? null : trimmed;
  }
  return { text, kind, priority, source };
}

/**
 * Append one item to a session's bucket.
 * @param state - ledger, mutated in place.
 * @param options - sessionId, validated payload, clock, id.
 * @returns the stored item.
 */
export function addItem(state, options) {
  const { sessionId, payload, now, id } = options;
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('letterbox: sessionId must be a non-empty string');
  if (!state.sessions[sessionId]) state.sessions[sessionId] = emptyBucket();
  const item = {
    id,
    text: payload.text,
    kind: payload.kind,
    priority: payload.priority,
    source: payload.source ?? null,
    createdAt: now,
    readAt: null,
  };
  state.sessions[sessionId].items.push(item);
  return item;
}

/**
 * List one session's items, newest first.
 * @param state - ledger.
 * @param sessionId - owning session.
 * @param options - `{ unreadOnly }`.
 * @returns the public item shape.
 */
export function listItems(state, sessionId, options = {}) {
  const bucket = state.sessions[sessionId];
  if (!bucket) return [];
  const unreadOnly = options.unreadOnly === true;
  const items = unreadOnly ? bucket.items.filter((item) => item.readAt === null) : bucket.items;
  return items.slice().reverse().map(toPublicItem);
}

/** Number of items the human has not acknowledged yet. */
export function countUnread(state, sessionId) {
  const bucket = state.sessions[sessionId];
  if (!bucket) return 0;
  return bucket.items.reduce((total, item) => (item.readAt === null ? total + 1 : total), 0);
}

/**
 * Mark one item read.
 * @param state - ledger, mutated in place.
 * @param options - sessionId, id, now.
 * @returns true when an unread item was acknowledged.
 */
export function markRead(state, options) {
  const { sessionId, id, now } = options;
  const bucket = state.sessions[sessionId];
  if (!bucket) return false;
  const item = bucket.items.find((candidate) => candidate.id === id);
  if (!item || item.readAt !== null) return false;
  item.readAt = now;
  return true;
}

/**
 * Trim a session's bucket to `limit` items, dropping the oldest read items first.
 * @param state - ledger, mutated in place.
 * @param sessionId - owning session.
 * @param limit - maximum items to keep.
 * @returns how many items were dropped.
 */
export function trimSession(state, sessionId, limit) {
  const bucket = state.sessions[sessionId];
  if (!bucket || bucket.items.length <= limit) return 0;
  const excess = bucket.items.length - limit;
  const keep = [];
  let dropped = 0;
  for (const item of bucket.items) {
    if (dropped < excess && item.readAt !== null) {
      dropped += 1;
      continue;
    }
    keep.push(item);
  }
  // Still over the limit: fall back to dropping the oldest, whatever their state.
  while (keep.length > limit) {
    keep.shift();
    dropped += 1;
  }
  bucket.items = keep;
  return dropped;
}

/**
 * Record that the agent consulted the box during `turn`.
 * @param state - ledger, mutated in place.
 * @param options - sessionId, now, turn id.
 * @returns the updated checkpoint.
 */
export function markChecked(state, options) {
  const { sessionId, now, turn } = options;
  if (!state.sessions[sessionId]) state.sessions[sessionId] = emptyBucket();
  const bucket = state.sessions[sessionId];
  bucket.checkedAt = now;
  bucket.checkedTurn = turn;
  return { checkedAt: bucket.checkedAt, checkedTurn: bucket.checkedTurn };
}

/**
 * Record a turn that ended without consulting the box while unread items
 * existed.
 * @param state - ledger, mutated in place.
 * @param options - sessionId, now.
 * @returns how many misses this session has accumulated.
 */
export function noteMiss(state, options) {
  const { sessionId, now } = options;
  if (!state.sessions[sessionId]) state.sessions[sessionId] = emptyBucket();
  const bucket = state.sessions[sessionId];
  bucket.misses += 1;
  bucket.lastMissAt = now;
  return bucket.misses;
}

/**
 * Whether the agent already checked the box during one turn.
 * @param state - ledger.
 * @param sessionId - owning session.
 * @param turn - the turn id being asked about.
 * @returns true only when the recorded checkpoint belongs to that turn.
 */
export function checkedInTurn(state, sessionId, turn) {
  const bucket = state.sessions[sessionId];
  if (!bucket || turn === null || turn === undefined) return false;
  return bucket.checkedTurn === turn;
}

/** Public shape handed to tools and the panel. */
export function toPublicItem(item) {
  return {
    id: item.id,
    text: item.text,
    kind: item.kind,
    priority: item.priority,
    source: item.source,
    createdAt: item.createdAt,
    read: item.readAt !== null,
    readAt: item.readAt,
  };
}
