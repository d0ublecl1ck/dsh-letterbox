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
 * Pseudo session id owning the cross-session bucket. Global notes live in
 * `state.sessions[GLOBAL_SCOPE]`, so every existing per-session function works
 * on them unchanged: pass this constant where a sessionId is expected.
 */
export const GLOBAL_SCOPE = '__global__';
/** Scopes an item may carry. */
export const SCOPES = ['session', 'global'];

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
  // Older ledgers have no scope at all; anything unreadable falls back to the
  // narrowest meaning rather than promoting a private note to global.
  const scope = SCOPES.includes(item.scope) ? item.scope : 'session';
  return [{ id: item.id, text, kind, priority, scope, source, createdAt, readAt }];
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
  if (raw.scope !== undefined && !SCOPES.includes(raw.scope)) {
    throw new Error('letterbox_add: scope must be one of ' + SCOPES.join(', '));
  }
  // `scope` is only echoed when the caller named one: the default lives in
  // `addItem`, and an absent field keeps older callers' payload shape intact.
  return raw.scope === undefined
    ? { text, kind, priority, source }
    : { text, kind, priority, source, scope: raw.scope };
}

/**
 * Append one item to a bucket: the session's own, or the shared global one.
 *
 * `scope` may arrive on the options or on the validated payload; anything that
 * is not `'global'` is stored as a session note, so the default never depends on
 * the caller remembering to pass it.
 *
 * @param state - ledger, mutated in place.
 * @param options - sessionId, validated payload, clock, id, scope.
 * @returns the stored item.
 */
export function addItem(state, options) {
  const { sessionId, payload, now, id } = options;
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('letterbox: sessionId must be a non-empty string');
  const scope = options.scope === 'global' || payload.scope === 'global' ? 'global' : 'session';
  const bucketId = scope === 'global' ? GLOBAL_SCOPE : sessionId;
  if (!state.sessions[bucketId]) state.sessions[bucketId] = emptyBucket();
  const item = {
    id,
    text: payload.text,
    kind: payload.kind,
    priority: payload.priority,
    scope,
    source: payload.source ?? null,
    createdAt: now,
    readAt: null,
  };
  state.sessions[bucketId].items.push(item);
  return item;
}

/**
 * List one session's items, newest first.
 *
 * Filtering is a `scope` plus an optional `query`:
 * - `all` returns everything (the default, and what the panel's badge reads);
 * - `unread` returns only items the human has not acknowledged yet;
 * - `history` returns only acknowledged items - the ones that left the main
 *   list when they were read.
 * The legacy `{ unreadOnly: true }` stays equivalent to `scope: 'unread'`, so
 * existing callers and tests keep their meaning.
 * `query` is matched case-insensitively as a substring of text, source, or kind.
 *
 * @param state - ledger.
 * @param sessionId - owning session.
 * @param options - `{ scope, query }` (or legacy `{ unreadOnly }`).
 * @returns the public item shape, newest first.
 */
export function listItems(state, sessionId, options = {}) {
  const bucket = state.sessions[sessionId];
  if (!bucket) return [];
  return filterBucket(bucket, options).map(toPublicItem);
}

/**
 * The scope + query filter, shared by the full list and the paged list so the
 * two can never drift apart. Returns stored items, newest first.
 * @param bucket - one session's bucket.
 * @param options - `{ scope, query, unreadOnly }`.
 * @returns matching stored items, newest first.
 */
function filterBucket(bucket, options) {
  const requested = options.scope;
  const scope = requested === 'unread' || requested === 'history'
    ? requested
    : options.unreadOnly === true ? 'unread' : 'all';
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  let items = bucket.items;
  if (scope === 'unread') items = items.filter((item) => item.readAt === null);
  else if (scope === 'history') items = items.filter((item) => item.readAt !== null);
  if (query !== '') items = items.filter((item) => matchesQuery(item, query));
  return items.slice().reverse();
}

/** Page size used when a caller does not name one. */
const DEFAULT_PAGE_LIMIT = 20;
/** Hard page size ceiling, so one request cannot ask for the whole ledger. */
const MAX_PAGE_LIMIT = 100;

/**
 * One page of a filtered list, newest first.
 *
 * `total` counts the whole filtered set (not the page), which is what lets the
 * panel say how much is left. `limit` is clamped to 1..100 and a missing or
 * unusable `limit` falls back to {@link DEFAULT_PAGE_LIMIT}; an offset that is
 * negative, fractional, or not a number collapses to 0. An offset past the end
 * returns an empty page with `hasMore: false` rather than an error.
 *
 * @param state - ledger.
 * @param sessionId - owning session.
 * @param options - `{ scope, query, limit, offset }`.
 * @returns `{ items, total, offset, limit, hasMore }`.
 */
export function pageItems(state, sessionId, options = {}) {
  const bucket = state.sessions[sessionId];
  const filtered = bucket === undefined ? [] : filterBucket(bucket, options);
  const total = filtered.length;
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit) : DEFAULT_PAGE_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_PAGE_LIMIT);
  const requestedOffset = Number.isFinite(options.offset) ? Math.floor(options.offset) : 0;
  const offset = Math.max(requestedOffset, 0);
  const items = filtered.slice(offset, offset + limit).map(toPublicItem);
  return { items, total, offset, limit, hasMore: offset + items.length < total };
}

/**
 * Whether one item matches a lowercased search string.
 * @param item - stored item.
 * @param query - already trimmed and lowercased.
 * @returns true when text, source, or kind contains it.
 */
function matchesQuery(item, query) {
  if (item.text.toLowerCase().includes(query)) return true;
  if (item.source !== null && item.source.toLowerCase().includes(query)) return true;
  return item.kind.toLowerCase().includes(query);
}

/** Number of items the human has not acknowledged yet. */
export function countUnread(state, sessionId) {
  const bucket = state.sessions[sessionId];
  if (!bucket) return 0;
  return bucket.items.reduce((total, item) => (item.readAt === null ? total + 1 : total), 0);
}

/**
 * What an unread bubble should say, given a raw count.
 *
 * The bubbles are 12px tall, so a wide number would either wrap or spill out of
 * the icon; anything past two digits is therefore reported as a capped "99+"
 * rather than the exact total. An empty string means "draw no bubble at all",
 * which also covers junk input: a server that answers null, a string, or NaN
 * must leave the sidebar clean instead of painting "NaN".
 *
 * @param count - the raw unread count from the host.
 * @returns '' to hide the bubble, else '1'…'99' or '99+'.
 */
export function badgeText(count) {
  if (typeof count !== 'number' || !Number.isFinite(count)) return '';
  if (!Number.isInteger(count)) return '';
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
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
    scope: item.scope,
    source: item.source,
    createdAt: item.createdAt,
    read: item.readAt !== null,
    readAt: item.readAt,
  };
}
