'use strict';
const test = require('node:test'); const assert = require('node:assert');
const M = require('../src/model');

const ME = 'me';
const mem = (userId, displayName) => ({ userId, displayName });
const msg = (id, from, at, html) => ({ id, createdDateTime: at, from: from ? { user: { id: from, displayName: from === ME ? 'Sean Ahn' : 'Ben Carter' } } : null, body: { content: html || 'x' } });
const group = { chatType: 'group', topic: null, members: [mem(ME, 'Sean Ahn'), mem('a', 'Dana White'), mem('b', 'Ben Carter'), mem('c', 'Kai Mori'), mem('d', 'Yuki Sato'), mem('e', 'Ana Ruiz')] };

test('chatName', () => {
  assert.strictEqual(M.chatName({ chatType: 'group', topic: 'Design Team Chat', members: group.members }, ME), 'Design Team Chat');
  assert.strictEqual(M.chatName({ chatType: 'oneOnOne', members: [mem(ME, 'Sean Ahn'), mem('t', 'Ted Tran')] }, ME), 'Ted Tran');
  assert.strictEqual(M.chatName(group, ME), 'Ana, Ben, Dana, +2');
  assert.strictEqual(M.chatName({ chatType: 'group', members: [mem(ME, 'Sean Ahn'), mem('a', 'Ana Ruiz'), mem('t', 'Kai Mori')] }, ME), 'Ana, Kai');
  assert.strictEqual(M.chatName({ chatType: 'oneOnOne', members: [mem(ME, 'Sean Ahn')] }, ME), '(you)');
  assert.strictEqual(M.chatName({ chatType: 'group', members: [] }, ME), '(you)');
});

test('isUnread', () => {
  const read = '2026-11-17T10:00:00Z';
  assert.strictEqual(M.isUnread({ lastMessagePreview: msg('1', ME, '2026-11-17T11:00:00Z'), viewpoint: { lastMessageReadDateTime: read } }, ME), false, 'own last message');
  assert.strictEqual(M.isUnread({ lastMessagePreview: msg('1', 'b', '2026-11-17T11:00:00Z'), viewpoint: { lastMessageReadDateTime: read } }, ME), true);
  assert.strictEqual(M.isUnread({ lastMessagePreview: msg('1', 'b', '2026-11-17T09:00:00Z'), viewpoint: { lastMessageReadDateTime: read } }, ME), false);
  assert.strictEqual(M.isUnread({ lastMessagePreview: msg('1', 'b', '2026-11-17T09:00:00Z') }, ME), true, 'no viewpoint');
  assert.strictEqual(M.isUnread({}, ME), false, 'no messages');
});

test('unreadCount', () => {
  const read = '2026-11-17T10:00:00Z';
  const msgs = [msg('4', 'b', '2026-11-17T12:00:00Z'), msg('3', ME, '2026-11-17T11:30:00Z'), msg('2', 'b', '2026-11-17T11:00:00Z'), msg('1', 'b', '2026-11-17T09:00:00Z')];
  assert.strictEqual(M.unreadCount(msgs, read, ME), 2);
  assert.strictEqual(M.unreadCount(msgs.slice(0, 3), read, ME), null, 'oldest loaded is after the read time');
  assert.strictEqual(M.unreadCount(msgs, null, ME), null);
});

test('previewLine', () => {
  assert.strictEqual(M.previewLine({ lastMessagePreview: msg('1', 'b', 'x', '<p>Since <b>April</b>?</p>') }, ME), 'Ben: Since April?');
  assert.strictEqual(M.previewLine({ lastMessagePreview: msg('1', ME, 'x', 'hi') }, ME), 'You: hi');
  assert.strictEqual(M.previewLine({ lastMessagePreview: msg('1', 'b', 'x', 'a'.repeat(200)) }, ME).length, 'Ben: '.length + 80);
  assert.strictEqual(M.previewLine({}, ME), '');
  assert.strictEqual(M.previewLine({ lastMessagePreview: Object.assign(msg('1', null, 'x', 'sys'), { from: null }) }, ME), 'sys');
});

test('mentionsUser', () => {
  assert.strictEqual(M.mentionsUser({ mentions: [{ mentioned: { user: { id: ME } } }] }, ME), true);
  assert.strictEqual(M.mentionsUser({ mentions: [{ mentioned: { user: { id: 'x' } } }, { mentioned: { conversation: { id: 'c' } } }] }, ME), false);
  assert.strictEqual(M.mentionsUser({}, ME), false);
});

test('chatRow', () => {
  const chat = Object.assign({ id: 'c1', lastMessagePreview: msg('1', 'b', '2026-11-17T11:00:00Z', 'hey') }, group);
  assert.deepStrictEqual(M.chatRow(chat, ME, { mention: true, unreadCount: 3 }), { kind: 'chat', id: 'c1', name: 'Ana, Ben, Dana, +2', preview: 'Ben: hey', tooltip: 'Ben Carter: hey', unread: true, unreadCount: 3, mention: true, time: '2026-11-17T11:00:00Z' });
});

test('a chat with no topic keeps one name whatever order Teams lists its members in', () => {
  const a = { chatType: 'group', members: [mem(ME, 'Sean Ahn'), mem('t', 'Kai Mori'), mem('a', 'Ana Ruiz')] };
  const b = { chatType: 'group', members: [mem('a', 'Ana Ruiz'), mem(ME, 'Sean Ahn'), mem('t', 'Kai Mori')] };
  assert.strictEqual(M.chatName(a, ME), M.chatName(b, ME));
  assert.strictEqual(M.chatName(a, ME), 'Ana, Kai');
});

test('chatRow carries the whole last message for the tooltip', () => {
  const long = 'line one<br>' + 'x'.repeat(200);
  const r = M.chatRow(Object.assign({ id: 'c1', lastMessagePreview: msg('1', 'b', '2026-11-17T11:00:00Z', long) }, group), ME, {});
  assert.strictEqual(r.tooltip, 'Ben Carter: line one\n' + 'x'.repeat(200));
  assert.ok(r.preview.length < r.tooltip.length, 'the row itself stays short');
  assert.strictEqual(M.chatRow(Object.assign({ id: 'c2', lastMessagePreview: msg('2', ME, 'x', 'hi') }, group), ME, {}).tooltip, 'You: hi');
  assert.strictEqual(M.chatRow(Object.assign({ id: 'c5' }, group), ME, {}).tooltip, '');
  assert.strictEqual(M.chatRow(Object.assign({ id: 'c4', lastMessagePreview: msg('4', 'b', 'x', 'y'.repeat(3000)) }, group), ME, {}).tooltip.length, 'Ben Carter: '.length + 1000, 'capped at 1,000 characters');
});
