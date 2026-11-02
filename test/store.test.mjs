import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  badgeText,
  checkedInTurn,
  countUnread,
  emptyBucket,
  emptyState,
  listItems,
  markChecked,
  markRead,
  noteMiss,
  normalizeState,
  pageItems,
  trimSession,
  validateAdd,
  addItem,
  GLOBAL_SCOPE,
  MAX_TEXT,
} from '../store.js';

function seed(sessionId, texts) {
  const state = emptyState();
  texts.forEach((text, index) => {
    addItem(state, {
      sessionId,
      payload: { text, kind: 'note', priority: 'normal', source: null },
      now: 1000 + index,
      id: 'lb_' + index,
    });
  });
  return state;
}

test('validateAdd rejects a blank text', () => {
  assert.throws(() => validateAdd({ text: '   ' }), /non-empty string/);
  assert.throws(() => validateAdd({}), /non-empty string/);
  assert.throws(() => validateAdd(null), /non-empty string/);
});

test('validateAdd rejects an over-long text and keeps the limit explicit', () => {
  assert.throws(() => validateAdd({ text: 'x'.repeat(MAX_TEXT + 1) }), /at most 4000 characters/);
  assert.equal(validateAdd({ text: 'x'.repeat(MAX_TEXT) }).text.length, MAX_TEXT);
});

test('validateAdd rejects unknown kind and priority', () => {
  assert.throws(() => validateAdd({ text: 'ok', kind: 'surprise' }), /kind must be one of/);
  assert.throws(() => validateAdd({ text: 'ok', priority: 'urgent' }), /priority must be one of/);
});

test('validateAdd trims text and source, and defaults kind/priority', () => {
  const payload = validateAdd({ text: '  hello  ', source: '  subagent-a  ' });
  assert.deepEqual(payload, { text: 'hello', kind: 'note', priority: 'normal', source: 'subagent-a' });
  assert.equal(validateAdd({ text: 'x' }).source, null);
});

test('addItem stores an unread item under one session', () => {
  const state = emptyState();
  const item = addItem(state, {
    sessionId: 's1',
    payload: { text: 'risk found', kind: 'risk', priority: 'high', source: null },
    now: 42,
    id: 'lb_1',
  });
  assert.equal(item.readAt, null);
  assert.equal(countUnread(state, 's1'), 1);
  assert.equal(countUnread(state, 's2'), 0);
  assert.deepEqual(listItems(state, 's1')[0].text, 'risk found');
});

test('listItems is newest first and can hide read items', () => {
  const state = seed('s1', ['first', 'second', 'third']);
  assert.deepEqual(listItems(state, 's1').map((item) => item.text), ['third', 'second', 'first']);
  markRead(state, { sessionId: 's1', id: 'lb_1', now: 2000 });
  assert.deepEqual(listItems(state, 's1', { unreadOnly: true }).map((item) => item.text), ['third', 'first']);
});

test('markRead acknowledges once and only for an existing unread item', () => {
  const state = seed('s1', ['a']);
  assert.equal(markRead(state, { sessionId: 's1', id: 'lb_0', now: 5000 }), true);
  assert.equal(markRead(state, { sessionId: 's1', id: 'lb_0', now: 6000 }), false);
  assert.equal(markRead(state, { sessionId: 's1', id: 'missing', now: 6000 }), false);
  assert.equal(markRead(state, { sessionId: 'other', id: 'lb_0', now: 6000 }), false);
  assert.equal(listItems(state, 's1')[0].read, true);
  assert.equal(listItems(state, 's1')[0].readAt, 5000);
});

test('sessions do not leak into each other', () => {
  const state = seed('s1', ['one']);
  addItem(state, { sessionId: 's2', payload: { text: 'two', kind: 'note', priority: 'normal', source: null }, now: 1, id: 'lb_b' });
  assert.deepEqual(listItems(state, 's1').map((item) => item.text), ['one']);
  assert.deepEqual(listItems(state, 's2').map((item) => item.text), ['two']);
});

test('normalizeState drops junk and keeps the readable subset', () => {
  const normalized = normalizeState({
    version: 1,
    sessions: {
      s1: {
        items: [
          { id: 'lb_1', text: 'ok', kind: 'risk', priority: 'high', createdAt: 10, readAt: null },
          { id: '', text: 'no id' },
          { id: 'lb_2' },
          'nonsense',
        ],
      },
      s2: { items: 'not-an-array' },
      '': { items: [{ id: 'lb_3', text: 'orphan' }] },
    },
  });
  assert.deepEqual(Object.keys(normalized.sessions), ['s1', 's2']);
  assert.equal(normalized.sessions.s1.items.length, 1);
  assert.equal(normalized.sessions.s1.items[0].kind, 'risk');
  assert.deepEqual(normalized.sessions.s2.items, []);
});

test('normalizeState survives a non-object file', () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState('x'), emptyState());
  assert.deepEqual(normalizeState({ sessions: [] }), emptyState());
});

test('emptyBucket starts with no checkpoint and no misses', () => {
  assert.deepEqual(emptyBucket(), { items: [], checkedAt: null, checkedTurn: null, misses: 0, lastMissAt: null });
});

test('markChecked records the turn and is answerable per turn', () => {
  const state = emptyState();
  markChecked(state, { sessionId: 's1', now: 9000, turn: 's1#3' });
  assert.equal(checkedInTurn(state, 's1', 's1#3'), true);
  assert.equal(checkedInTurn(state, 's1', 's1#4'), false);
  assert.equal(checkedInTurn(state, 's1', null), false);
  assert.equal(checkedInTurn(state, 'other', 's1#3'), false);
  assert.equal(state.sessions.s1.checkedAt, 9000);
});

test('noteMiss counts misses and stamps the latest one', () => {
  const state = emptyState();
  assert.equal(noteMiss(state, { sessionId: 's1', now: 100 }), 1);
  assert.equal(noteMiss(state, { sessionId: 's1', now: 200 }), 2);
  assert.equal(state.sessions.s1.lastMissAt, 200);
});

test('normalizeState preserves checkpoint fields and rejects junk ones', () => {
  const normalized = normalizeState({
    sessions: {
      s1: { items: [], checkedAt: 1234, checkedTurn: 's1#2', misses: 3, lastMissAt: 5678 },
      s2: { items: [], checkedAt: 'soon', checkedTurn: 7, misses: -2, lastMissAt: null },
    },
  });
  assert.deepEqual(normalized.sessions.s1, { items: [], checkedAt: 1234, checkedTurn: 's1#2', misses: 3, lastMissAt: 5678 });
  assert.deepEqual(normalized.sessions.s2, { items: [], checkedAt: null, checkedTurn: null, misses: 0, lastMissAt: null });
});

test('pageItems returns the first page with the default limit', () => {
  const state = seed('s1', ['a', 'b', 'c']);
  const page = pageItems(state, 's1');
  assert.deepEqual(page.items.map((item) => item.text), ['c', 'b', 'a']);
  assert.equal(page.total, 3);
  assert.equal(page.offset, 0);
  assert.equal(page.limit, 20);
  assert.equal(page.hasMore, false);
});

test('pageItems pages through the set and reports hasMore', () => {
  const state = seed('s1', ['a', 'b', 'c', 'd', 'e']);
  const first = pageItems(state, 's1', { limit: 2, offset: 0 });
  assert.deepEqual(first.items.map((item) => item.text), ['e', 'd']);
  assert.equal(first.hasMore, true);
  const second = pageItems(state, 's1', { limit: 2, offset: 2 });
  assert.deepEqual(second.items.map((item) => item.text), ['c', 'b']);
  assert.equal(second.total, 5);
  assert.equal(second.hasMore, true);
  const last = pageItems(state, 's1', { limit: 2, offset: 4 });
  assert.deepEqual(last.items.map((item) => item.text), ['a']);
  assert.equal(last.hasMore, false);
});

test('pageItems clamps limit to 1..100 and treats a bad offset as zero', () => {
  const state = seed('s1', ['a', 'b', 'c']);
  assert.equal(pageItems(state, 's1', { limit: 0 }).limit, 1);
  assert.equal(pageItems(state, 's1', { limit: 0 }).items.length, 1);
  assert.equal(pageItems(state, 's1', { limit: 500 }).limit, 100);
  assert.equal(pageItems(state, 's1', { limit: Number.NaN }).limit, 20);
  assert.equal(pageItems(state, 's1', { offset: -5 }).offset, 0);
  assert.equal(pageItems(state, 's1', { offset: Number.NaN }).offset, 0);
});

test('pageItems past the end is an empty page, not an error', () => {
  const state = seed('s1', ['a', 'b']);
  const page = pageItems(state, 's1', { limit: 5, offset: 9 });
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 2);
  assert.equal(page.offset, 9);
  assert.equal(page.hasMore, false);
});

test('pageItems filters exactly like listItems', () => {
  const state = seed('s1', ['router risk', 'pricing decision', 'handoff note']);
  markRead(state, { sessionId: 's1', id: 'lb_1', now: 4000 });
  assert.deepEqual(
    pageItems(state, 's1', { scope: 'history', limit: 10 }).items.map((item) => item.id),
    listItems(state, 's1', { scope: 'history' }).map((item) => item.id),
  );
  assert.deepEqual(
    pageItems(state, 's1', { scope: 'unread', query: 'ROUTER', limit: 10 }).items.map((item) => item.id),
    listItems(state, 's1', { scope: 'unread', query: 'router' }).map((item) => item.id),
  );
  assert.equal(pageItems(state, 's1', { scope: 'history', query: 'nothing' }).total, 0);
});

test('pageItems total describes the filtered set, not the page', () => {
  const state = seed('s1', ['a', 'b', 'c', 'd', 'e', 'f']);
  markRead(state, { sessionId: 's1', id: 'lb_0', now: 5000 });
  markRead(state, { sessionId: 's1', id: 'lb_1', now: 5001 });
  const page = pageItems(state, 's1', { scope: 'history', limit: 1, offset: 0 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.equal(pageItems(state, 's1', { scope: 'all', limit: 2 }).total, 6);
});

test('addItem defaults to the session bucket', () => {
  const state = emptyState();
  const item = addItem(state, {
    sessionId: 's1',
    payload: { text: 'private note', kind: 'note', priority: 'normal', source: null },
    now: 1000,
    id: 'lb_1',
  });
  assert.equal(item.scope, 'session');
  assert.equal(state.sessions.s1.items.length, 1);
  assert.equal(state.sessions[GLOBAL_SCOPE], undefined);
});

test('addItem routes a global note into the shared bucket', () => {
  const state = emptyState();
  const item = addItem(state, {
    sessionId: 's1',
    payload: { text: 'cross-session rule', kind: 'note', priority: 'normal', source: null },
    now: 1000,
    id: 'lb_g',
    scope: 'global',
  });
  assert.equal(item.scope, 'global');
  assert.equal(state.sessions.s1, undefined);
  assert.deepEqual(state.sessions[GLOBAL_SCOPE].items.map((x) => x.id), ['lb_g']);
  assert.equal(countUnread(state, GLOBAL_SCOPE), 1);
  assert.equal(countUnread(state, 's1'), 0);
});

test('global and session buckets do not leak into each other', () => {
  const state = seed('s1', ['session one']);
  addItem(state, {
    sessionId: 's1',
    payload: { text: 'global one', kind: 'note', priority: 'normal', source: null },
    now: 2000,
    id: 'lb_g1',
    scope: 'global',
  });
  assert.deepEqual(listItems(state, 's1').map((item) => item.text), ['session one']);
  assert.deepEqual(listItems(state, GLOBAL_SCOPE).map((item) => item.text), ['global one']);
  assert.equal(countUnread(state, 's1'), 1);
  assert.equal(countUnread(state, GLOBAL_SCOPE), 1);
  // a read in one bucket never touches the other
  markRead(state, { sessionId: GLOBAL_SCOPE, id: 'lb_g1', now: 3000 });
  assert.equal(countUnread(state, GLOBAL_SCOPE), 0);
  assert.equal(countUnread(state, 's1'), 1);
});

test('pageItems paginates the global bucket like any other', () => {
  const state = emptyState();
  for (let i = 0; i < 5; i += 1) {
    addItem(state, {
      sessionId: 's1',
      payload: { text: 'g' + i, kind: 'note', priority: 'normal', source: null },
      now: 1000 + i,
      id: 'lb_g' + i,
      scope: 'global',
    });
  }
  const first = pageItems(state, GLOBAL_SCOPE, { limit: 2, offset: 0 });
  assert.deepEqual(first.items.map((item) => item.text), ['g4', 'g3']);
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);
  const last = pageItems(state, GLOBAL_SCOPE, { limit: 2, offset: 4 });
  assert.deepEqual(last.items.map((item) => item.text), ['g0']);
  assert.equal(last.hasMore, false);
  assert.equal(pageItems(state, 's1').total, 0);
});

test('normalizeState keeps a valid scope and corrects a junk one', () => {
  const normalized = normalizeState({
    sessions: {
      s1: { items: [
        { id: 'lb_a', text: 'old note without scope', kind: 'note', priority: 'normal', createdAt: 1 },
        { id: 'lb_b', text: 'wrong scope', kind: 'note', priority: 'normal', createdAt: 2, scope: 'everywhere' },
        { id: 'lb_c', text: 'global note', kind: 'note', priority: 'normal', createdAt: 3, scope: 'global' },
      ] },
    },
  });
  assert.deepEqual(normalized.sessions.s1.items.map((item) => item.scope), ['session', 'session', 'global']);
});

test('validateAdd validates scope and only echoes it when given', () => {
  assert.throws(() => validateAdd({ text: 'ok', scope: 'everywhere' }), /scope must be one of session, global/);
  assert.equal(validateAdd({ text: 'ok', scope: 'global' }).scope, 'global');
  assert.equal(validateAdd({ text: 'ok', scope: 'session' }).scope, 'session');
  assert.equal(Object.hasOwn(validateAdd({ text: 'ok' }), 'scope'), false);
});

test('trimSession drops read items first, then the oldest', () => {
  const state = seed('s1', ['a', 'b', 'c', 'd']);
  markRead(state, { sessionId: 's1', id: 'lb_0', now: 3000 });
  assert.equal(trimSession(state, 's1', 3), 1);
  assert.deepEqual(listItems(state, 's1').map((item) => item.text), ['d', 'c', 'b']);
  assert.equal(trimSession(state, 's1', 1), 2);
  assert.deepEqual(listItems(state, 's1').map((item) => item.text), ['d']);
});

test('badgeText renders 1..99 as-is', () => {
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(42), '42');
  assert.equal(badgeText(99), '99');
});

test('badgeText collapses anything above 99 to 99+', () => {
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeText(999), '99+');
});

test('badgeText draws nothing for zero and other non-positive numbers', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-1), '');
  assert.equal(badgeText(-999), '');
});

test('badgeText draws nothing for values that are not a positive integer', () => {
  assert.equal(badgeText(Number.NaN), '');
  assert.equal(badgeText(Number.POSITIVE_INFINITY), '');
  assert.equal(badgeText(1.5), '');
  assert.equal(badgeText('3'), '');
  assert.equal(badgeText(''), '');
  assert.equal(badgeText(undefined), '');
  assert.equal(badgeText(null), '');
  assert.equal(badgeText(true), '');
});

// The Web bundle is materialized by the module loader, whose require() only
// resolves loader ids, so client.js keeps its own copy of the formatter. Pin the
// two bodies to one text so a change to either side fails here.
test('client.js carries the same badgeText body as store.js', () => {
  const body = (source) => {
    const open = source.indexOf('function badgeText(count) {');
    if (open < 0) return null;
    const rest = source.slice(open);
    const close = rest.search(/\n\s*\}/);
    if (close < 0) return null;
    return rest.slice(0, close).split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n');
  };
  const client = body(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const store = body(readFileSync(new URL('../store.js', import.meta.url), 'utf8'));
  assert.notEqual(client, null, 'client.js must define badgeText(count)');
  assert.equal(client, store, 'client.js badgeText drifted from store.js');
});
