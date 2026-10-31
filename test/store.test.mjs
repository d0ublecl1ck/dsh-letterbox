import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkedInTurn,
  countUnread,
  emptyBucket,
  emptyState,
  listItems,
  markChecked,
  markRead,
  noteMiss,
  normalizeState,
  trimSession,
  validateAdd,
  addItem,
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

test('trimSession drops read items first, then the oldest', () => {
  const state = seed('s1', ['a', 'b', 'c', 'd']);
  markRead(state, { sessionId: 's1', id: 'lb_0', now: 3000 });
  assert.equal(trimSession(state, 's1', 3), 1);
  assert.deepEqual(listItems(state, 's1').map((item) => item.text), ['d', 'c', 'b']);
  assert.equal(trimSession(state, 's1', 1), 2);
  assert.deepEqual(listItems(state, 's1').map((item) => item.text), ['d']);
});
