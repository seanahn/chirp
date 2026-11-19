'use strict';
const test = require('node:test'); const assert = require('node:assert');
const api = require('../src/api');

function fakeG(answer) {
  const calls = [];
  const rec = (method) => async (path, body) => { calls.push({ method, path, body }); return answer ? answer(method, path, body) : { value: [] }; };
  return { calls, get: rec('GET'), post: rec('POST'), getAll: async (path, max) => { calls.push({ method: 'GETALL', path, max }); return []; } };
}
const CHAT = '19:7e2a91f04b6d4e8fa1b5d9e0f6a2b4d8@thread.v2';
const ENC = '19%3A7e2a91f04b6d4e8fa1b5d9e0f6a2b4d8%40thread.v2';

test('chatMessages encodes the chat id and returns next', async () => {
  const g = fakeG(() => ({ value: [{ id: 'm1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/n' }));
  assert.deepStrictEqual(await api.chatMessages(g, CHAT), { messages: [{ id: 'm1' }], next: 'https://graph.microsoft.com/v1.0/n' });
  assert.strictEqual(g.calls[0].path, `/chats/${ENC}/messages?$top=50`);
  await api.chatMessages(g, CHAT, { next: 'https://graph.microsoft.com/v1.0/n' });
  assert.strictEqual(g.calls[1].path, 'https://graph.microsoft.com/v1.0/n');
});

test('listChats asks for previews and members, newest first', async () => {
  const g = fakeG(() => ({ value: [{ id: 'c' }] }));
  assert.deepStrictEqual(await api.listChats(g), [{ id: 'c' }]);
  assert.strictEqual(g.calls[0].path, '/me/chats?$expand=lastMessagePreview,members&$orderby=lastMessagePreview/createdDateTime desc&$top=50');
});

test('markChatRead body', async () => {
  const g = fakeG(() => null);
  await api.markChatRead(g, CHAT, 'me-id', 'tid');
  assert.deepStrictEqual(g.calls[0], { method: 'POST', path: `/chats/${ENC}/markChatReadForUser`, body: { user: { id: 'me-id', tenantId: 'tid' } } });
});

test('sending bodies are html', async () => {
  const g = fakeG(() => ({ id: 'n' }));
  await api.sendChatMessage(g, CHAT, 'hi<br>x');
  await api.postChannelMessage(g, 'T', '19:c@thread.tacv2', 'p');
  await api.replyToPost(g, 'T', '19:c@thread.tacv2', '171', 'r');
  assert.deepStrictEqual(g.calls.map((c) => [c.path, c.body]), [
    [`/chats/${ENC}/messages`, { body: { contentType: 'html', content: 'hi<br>x' } }],
    ['/teams/T/channels/19%3Ac%40thread.tacv2/messages', { body: { contentType: 'html', content: 'p' } }],
    ['/teams/T/channels/19%3Ac%40thread.tacv2/messages/171/replies', { body: { contentType: 'html', content: 'r' } }],
  ]);
});

test('channel reads', async () => {
  const g = fakeG((m, p) => (p.includes('/messages?') ? { value: [{ id: 'p' }] } : { id: 'x' }));
  assert.deepStrictEqual(await api.channelMessages(g, 'T', '19:c@thread.tacv2'), { posts: [{ id: 'p' }], next: null });
  await api.channelMessage(g, 'T', '19:c@thread.tacv2', '5');
  await api.channelMessage(g, 'T', '19:c@thread.tacv2', '6', '5');
  await api.postReplies(g, 'T', '19:c@thread.tacv2', '5', { top: 20 });
  assert.deepStrictEqual(g.calls.map((c) => c.path), [
    '/teams/T/channels/19%3Ac%40thread.tacv2/messages?$top=20&$expand=replies',
    '/teams/T/channels/19%3Ac%40thread.tacv2/messages/5',
    '/teams/T/channels/19%3Ac%40thread.tacv2/messages/5/replies/6',
    '/teams/T/channels/19%3Ac%40thread.tacv2/messages/5/replies?$top=20',
  ], 'Graph refuses $expand=replies on a single message: replies come from /replies');
});

test('teams and channels', async () => {
  const g = fakeG(() => ({ value: [{ id: 'a' }] }));
  assert.deepStrictEqual(await api.joinedTeams(g), [{ id: 'a' }]);
  assert.deepStrictEqual(await api.channels(g, 'T'), [{ id: 'a' }]);
  assert.deepStrictEqual(g.calls.map((c) => c.path), ['/me/joinedTeams', '/teams/T/channels']);
});

test('searchMessages request and hits', async () => {
  const g = fakeG(() => ({ value: [{ hitsContainers: [{ hits: [{ resource: { id: 'h' } }] }] }] }));
  assert.deepStrictEqual(await api.searchMessages(g, '"Sean Ahn"'), [{ resource: { id: 'h' } }]);
  assert.deepStrictEqual(g.calls[0], { method: 'POST', path: '/search/query', body: { requests: [{ entityTypes: ['chatMessage'], query: { queryString: '"Sean Ahn"' }, from: 0, size: 25 }] } });
  const empty = fakeG(() => ({ value: [{ hitsContainers: [{}] }] }));
  assert.deepStrictEqual(await api.searchMessages(empty, 'x'), []);
});

test('me', async () => {
  const g = fakeG(() => ({ id: 'u', displayName: 'Sean Ahn', mail: 'x' }));
  assert.deepStrictEqual(await api.me(g), { id: 'u', displayName: 'Sean Ahn' });
});

test('sendChatMessage carries mentions when given', async () => {
  const g = fakeG(() => ({ id: 'n' }));
  const m = [{ id: 0, mentionText: 'A', mentioned: { user: { id: 'a', displayName: 'A', userIdentityType: 'aadUser' } } }];
  await api.sendChatMessage(g, CHAT, '<at id="0">A</at>', m);
  assert.deepStrictEqual(g.calls[0].body, { body: { contentType: 'html', content: '<at id="0">A</at>' }, mentions: m });
  await api.sendChatMessage(g, CHAT, 'x');
  assert.deepStrictEqual(g.calls[1].body, { body: { contentType: 'html', content: 'x' } }, 'no mentions key without mentions');
});

// ---- starting a 1:1
test('findPeople searches the directory by name or mail, quotes escaped', async () => {
  const g = fakeG(() => ({ value: [{ id: 'u1', displayName: 'Nora Lane', mail: 'nora@x.com' }] }));
  assert.deepStrictEqual(await api.findPeople(g, "O'Na"), [{ id: 'u1', displayName: 'Nora Lane', mail: 'nora@x.com' }]);
  const q = "O''Na";
  assert.strictEqual(g.calls[0].path, `/users?$filter=${encodeURIComponent(`startswith(displayName,'${q}') or startswith(givenName,'${q}') or startswith(surname,'${q}') or startswith(mail,'${q}')`)}&$select=id,displayName,mail&$top=8`);
});

test('startChat asks for a 1:1 with both people (Graph reuses an existing one)', async () => {
  const g = fakeG(() => ({ id: '19:a_b@unq.gbl.spaces' }));
  assert.deepStrictEqual(await api.startChat(g, 'me', 'u1'), { id: '19:a_b@unq.gbl.spaces' });
  const m = (id) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${id}')` });
  assert.deepStrictEqual(g.calls[0], { method: 'POST', path: '/chats', body: { chatType: 'oneOnOne', members: [m('me'), m('u1')] } });
});
