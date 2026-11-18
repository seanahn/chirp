'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createMentionState, channelHits, SEEN_CAP } = require('../src/mentions');

function memento() { const m = new Map(); return { get: (k) => m.get(k), update: (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); }, _m: m }; }

test('flag and clear persist', () => {
  const mm = memento();
  const s = createMentionState(mm, () => 1000);
  s.flag('chat:1', 'm1');
  assert.strictEqual(createMentionState(mm, () => 2000).isFlagged('chat:1'), true, 'survives a restart');
  s.clear('chat:1');
  assert.strictEqual(createMentionState(mm, () => 2000).isFlagged('chat:1'), false);
  assert.deepStrictEqual(s.flagged(), []);
});

test('seen keeps the last 500', () => {
  const s = createMentionState(memento(), () => 1);
  for (let i = 0; i < SEEN_CAP + 10; i++) s.markSeen('m' + i);
  assert.strictEqual(SEEN_CAP, 500);
  assert.strictEqual(s.seen('m0'), false);
  assert.strictEqual(s.seen('m10'), true);
  assert.strictEqual(s.seen('m509'), true);
});

test('baseline is set once', () => {
  const mm = memento();
  assert.strictEqual(createMentionState(mm, () => 1000).baseline(), 1000);
  assert.strictEqual(createMentionState(mm, () => 5000).baseline(), 1000);
});

test('channelHits keeps channel messages only', () => {
  const hits = [
    { resource: { id: 'a', chatId: '19:x@thread.v2', createdDateTime: 't1' } },
    { resource: { id: 'b', channelIdentity: { teamId: 'T', channelId: 'C' }, createdDateTime: 't2' } },
    { resource: { id: 'c', replyToId: 'b', channelIdentity: { teamId: 'T', channelId: 'C' }, createdDateTime: 't3' } },
    { resource: { id: 'd', channelIdentity: { teamId: 'T' } } },
    {},
  ];
  assert.deepStrictEqual(channelHits(hits), [
    { teamId: 'T', channelId: 'C', messageId: 'b', replyToId: null, created: 't2' },
    { teamId: 'T', channelId: 'C', messageId: 'c', replyToId: 'b', created: 't3' },
  ]);
});

// ---- the channel mention scan (Task 13)
const { scanChannelMentions } = require('../src/mentions');
const ME = { id: 'me', displayName: 'Sean Ahn' };
const hit = (id, created, o) => ({ resource: Object.assign({ id, createdDateTime: created, channelIdentity: { teamId: 'T', channelId: 'C' } }, o) });
function scanApi(hits, messages) {
  const calls = [];
  return { calls, searchMessages: async (g, q, size) => { calls.push(['search', q, size]); return hits; }, channelMessage: async (g, t, c, id, replyTo) => { calls.push(['get', t, c, id, replyTo]); const m = messages[id]; if (m instanceof Error) throw m; return m; } };
}
const said = (mentioned) => ({ mentions: mentioned ? [{ mentioned: { user: { id: 'me' } } }] : [] });

test('only real mentions flag', async () => {
  const st = createMentionState(memento(), () => Date.parse('2026-11-18T00:00:00Z'));
  const api = scanApi([hit('a', '2026-11-18T10:00:00Z'), hit('b', '2026-11-18T10:01:00Z', { replyToId: 'a' })], { a: said(false), b: said(true) });
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  assert.deepStrictEqual(api.calls[0], ['search', '"Sean Ahn"', 25]);
  assert.deepStrictEqual(api.calls.slice(1), [['get', 'T', 'C', 'a', null], ['get', 'T', 'C', 'b', 'a']]);
  assert.deepStrictEqual(st.flagged(), ['channel:T/C']);
});

test('seen hits are not refetched', async () => {
  const st = createMentionState(memento(), () => Date.parse('2026-11-18T00:00:00Z'));
  const api = scanApi([hit('a', '2026-11-18T10:00:00Z')], { a: said(false) });
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  assert.strictEqual(api.calls.filter((c) => c[0] === 'get').length, 1);
});

test('hits before baseline ignored', async () => {
  const st = createMentionState(memento(), () => Date.parse('2026-11-18T12:00:00Z'));
  const api = scanApi([hit('a', '2026-11-18T10:00:00Z')], { a: said(true) });
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  assert.deepStrictEqual(api.calls.filter((c) => c[0] === 'get'), []);
  assert.deepStrictEqual(st.flagged(), []);
});

test('a hit that fails to fetch is tried again next time', async () => {
  const st = createMentionState(memento(), () => Date.parse('2026-11-18T00:00:00Z'));
  const messages = { a: new Error('503') };
  const api = scanApi([hit('a', '2026-11-18T10:00:00Z')], messages);
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  assert.deepStrictEqual(st.flagged(), []);
  messages.a = said(true);
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  assert.deepStrictEqual(st.flagged(), ['channel:T/C']);
});

test('a hit that is not found is not tried again', async () => {
  const st = createMentionState(memento(), () => Date.parse('2026-11-18T00:00:00Z'));
  const api = scanApi([hit('a', '2026-11-18T10:00:00Z')], { a: Object.assign(new Error('nf'), { status: 404 }) });
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  await scanChannelMentions({ api, g: {}, me: ME, state: st });
  assert.strictEqual(api.calls.filter((c) => c[0] === 'get').length, 1);
});
