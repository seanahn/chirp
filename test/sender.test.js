'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createSender } = require('../src/sender');
const { GraphError, GraphTimeout } = require('../src/graph');
const { Offline } = require('../src/tokenStore');

const NOW = Date.parse('2026-11-18T16:00:00Z');
const own = (id, at, html) => ({ id, createdDateTime: new Date(at).toISOString(), from: { user: { id: 'me' } }, body: { content: html } });
function fakeApi(o) {
  const calls = [];
  const rec = (name, fn) => async (...a) => { calls.push([name, ...a.slice(1)]); return fn(...a); };
  return {
    calls,
    sendChatMessage: rec('sendChatMessage', o.send || (async () => ({ id: 'n' }))),
    postChannelMessage: rec('postChannelMessage', o.send || (async () => ({ id: 'n' }))),
    replyToPost: rec('replyToPost', o.send || (async () => ({ id: 'n' }))),
    chatMessages: rec('chatMessages', o.list || (async () => ({ messages: [] }))),
    channelMessages: rec('channelMessages', o.list || (async () => ({ posts: [] }))),
    postReplies: rec('postReplies', o.replies || (async () => [])),
  };
}
const sender = (api, slept) => createSender({ api, g: {}, meId: 'me', now: () => NOW, sleep: async (ms) => { if (slept) slept.push(ms); } });
const CHAT = { kind: 'chat', chatId: 'c1' };

test('sent', async () => {
  const api = fakeApi({ send: async () => ({ id: 'n1' }) });
  assert.deepStrictEqual(await sender(api).send(CHAT, 'a < b\nc'), { ok: true, message: { id: 'n1' } });
  assert.deepStrictEqual(api.calls, [['sendChatMessage', 'c1', 'a &lt; b<br>c']]);
});

test('targets', async () => {
  const api = fakeApi({});
  await sender(api).send({ kind: 'post', teamId: 'T', channelId: 'C' }, 'p');
  await sender(api).send({ kind: 'reply', teamId: 'T', channelId: 'C', postId: 'P' }, 'r');
  assert.deepStrictEqual(api.calls, [['postChannelMessage', 'T', 'C', 'p'], ['replyToPost', 'T', 'C', 'P', 'r']]);
});

test('429 resends once', async () => {
  let n = 0; const slept = [];
  const api = fakeApi({ send: async () => { if (n++ === 0) throw new GraphError(429, 'x', 'slow', 7000); return { id: 'n2' }; } });
  assert.deepStrictEqual(await sender(api, slept).send(CHAT, 'hi'), { ok: true, message: { id: 'n2' } });
  assert.deepStrictEqual(slept, [7000]);
  const twice = fakeApi({ send: async () => { throw new GraphError(429, 'x', 'slow', null); } });
  const r = await sender(twice, slept).send(CHAT, 'hi');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.retryable, true);
  assert.deepStrictEqual(slept, [7000, 5000]);
  assert.strictEqual(twice.calls.length, 2);
});

test('403 is forbidden', async () => {
  const api = fakeApi({ send: async () => { throw new GraphError(403, 'Forbidden', 'no', null); } });
  const r = await sender(api).send({ kind: 'post', teamId: 'T', channelId: 'C' }, 'x');
  assert.deepStrictEqual([r.ok, r.forbidden, r.retryable], [false, true, true]);
  assert.ok(r.error);
});

test('timeout then found: no resend', async () => {
  const api = fakeApi({ send: async () => { throw new GraphTimeout(); }, list: async () => ({ messages: [own('other', NOW + 1000, 'different'), own('found', NOW + 2000, 'hello  <b>there</b>')] }) });
  assert.deepStrictEqual(await sender(api).send(CHAT, 'hello there'), { ok: true, message: own('found', NOW + 2000, 'hello  <b>there</b>') });
  assert.deepStrictEqual(api.calls.map((c) => c[0]), ['sendChatMessage', 'chatMessages']);
  assert.deepStrictEqual(api.calls[1], ['chatMessages', 'c1', { top: 20 }]);
});

test('offline reply: checks the post replies', async () => {
  const api = fakeApi({ send: async () => { throw new Offline(); }, replies: async () => [own('r9', NOW, 'yes')] });
  const r = await sender(api).send({ kind: 'reply', teamId: 'T', channelId: 'C', postId: 'P' }, 'yes');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(api.calls[1], ['postReplies', 'T', 'C', 'P', { top: 20 }]);
});

test('timeout then not found offers retry', async () => {
  const api = fakeApi({ send: async () => { throw new GraphTimeout(); } });
  const r = await sender(api).send(CHAT, 'x');
  assert.deepStrictEqual([r.ok, r.retryable, r.forbidden], [false, true, false]);
  const broken = fakeApi({ send: async () => { throw new GraphTimeout(); }, list: async () => { throw new Offline(); } });
  assert.strictEqual((await sender(broken).send(CHAT, 'x')).ok, false);
});

test('an old identical message does not count', async () => {
  const api = fakeApi({ send: async () => { throw new GraphTimeout(); }, list: async () => ({ messages: [own('old', NOW - 600000, 'x')] }) });
  assert.strictEqual((await sender(api).send(CHAT, 'x')).ok, false);
  const someoneElse = fakeApi({ send: async () => { throw new GraphTimeout(); }, list: async () => ({ messages: [Object.assign(own('o', NOW, 'x'), { from: { user: { id: 'bob' } } })] }) });
  assert.strictEqual((await sender(someoneElse).send(CHAT, 'x')).ok, false);
});

test('a 500 is an unknown outcome: checked before Retry', async () => {
  const api = fakeApi({ send: async () => { throw new GraphError(500, 'x', 'oops', null); }, list: async () => ({ messages: [own('f', NOW, 'x')] }) });
  assert.strictEqual((await sender(api).send(CHAT, 'x')).ok, true);
  assert.strictEqual(api.calls.filter((c) => c[0] === 'sendChatMessage').length, 1);
});

// ---- a manual Retry (final review): look for the earlier attempt first
test('a retry first looks for the earlier attempt', async () => {
  const api = fakeApi({ list: async () => ({ messages: [own('earlier', NOW - 60000, 'hi')] }) });
  const r = await sender(api).send(CHAT, 'hi', { since: NOW - 61000 });
  assert.deepStrictEqual([r.ok, r.message.id], [true, 'earlier']);
  assert.deepStrictEqual(api.calls.map((c) => c[0]), ['chatMessages'], 'no second post');
});

test('a retry whose check fails does not post', async () => {
  const api = fakeApi({ list: async () => { throw new Offline(); } });
  const r = await sender(api).send(CHAT, 'hi', { since: NOW - 61000 });
  assert.deepStrictEqual([r.ok, r.retryable], [false, true]);
  assert.ok(!api.calls.some((c) => c[0] === 'sendChatMessage'));
});

test('a retry that finds nothing posts', async () => {
  const api = fakeApi({});
  const r = await sender(api).send(CHAT, 'hi', { since: NOW - 61000 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(api.calls.map((c) => c[0]), ['chatMessages', 'sendChatMessage']);
});
