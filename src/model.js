'use strict';
// What a chat row shows: its name, preview, unread state and count, and whether it mentions Sean (design 101, "Row states";
// the rules are in "Builder's decisions from the plan").
const { htmlToText } = require('./html');

const PREVIEW_CHARS = 80;
const TOOLTIP_CHARS = 1000;
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// sorted by name: Teams lists a chat's members in no fixed order, and a chat's name (and file) must not change with it
const others = (chat, meId) => (chat.members || []).filter((m) => m.userId !== meId && m.displayName).sort((x, y) => x.displayName.localeCompare(y.displayName));
const fromId = (m) => m && m.from && m.from.user && m.from.user.id;

/** The topic; for a 1:1, the other person; otherwise the others' first names, three then +N, as Teams shows them. */
function chatName(chat, meId) {
  if (chat.topic) return chat.topic;
  const o = others(chat, meId);
  if (!o.length) return '(you)';
  if (chat.chatType === 'oneOnOne' || o.length === 1) return o[0].displayName;
  const names = o.slice(0, 3).map((m) => first(m.displayName));
  return o.length > 3 ? `${names.join(', ')}, +${o.length - 3}` : names.join(', ');
}

/** The last message is someone else's and newer than Sean's read time. */
function isUnread(chat, meId) {
  const last = chat.lastMessagePreview;
  if (!last || !last.createdDateTime) return false;
  if (fromId(last) === meId) return false;
  const read = chat.viewpoint && chat.viewpoint.lastMessageReadDateTime;
  return !read || Date.parse(last.createdDateTime) > Date.parse(read);
}

/** Unread messages among those loaded (any order), or null when the loaded ones may not reach back to the read time. */
function unreadCount(messages, readTime, meId) {
  if (!readTime || !messages.length) return null;
  const r = Date.parse(readTime);
  const oldest = Math.min(...messages.map((m) => Date.parse(m.createdDateTime)));
  if (oldest > r) return null;
  return messages.filter((m) => Date.parse(m.createdDateTime) > r && fromId(m) !== meId).length;
}

function previewLine(chat, meId) {
  const last = chat.lastMessagePreview;
  if (!last) return '';
  const text = htmlToText(last.body && last.body.content).replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS);
  const u = last.from && last.from.user;
  if (!u) return text;
  return `${u.id === meId ? 'You' : first(u.displayName)}: ${text}`;
}

/** The whole last message, for the row's tooltip: the sender's full name, then the text with its line breaks. */
function tooltipText(chat, meId) {
  const last = chat.lastMessagePreview;
  if (!last) return '';
  const text = htmlToText(last.body && last.body.content).slice(0, TOOLTIP_CHARS);
  const u = last.from && last.from.user;
  if (!u) return text;
  return `${u.id === meId ? 'You' : u.displayName}: ${text}`;
}

function mentionsUser(message, meId) {
  return (message.mentions || []).some((m) => m && m.mentioned && m.mentioned.user && m.mentioned.user.id === meId);
}

function chatRow(chat, meId, { mention = false, unreadCount: count = null } = {}) {
  const unread = isUnread(chat, meId);
  return { kind: 'chat', id: chat.id, name: chatName(chat, meId), preview: previewLine(chat, meId), tooltip: tooltipText(chat, meId), unread, unreadCount: unread ? count : null, mention, time: (chat.lastMessagePreview && chat.lastMessagePreview.createdDateTime) || null };
}

module.exports = { chatName, isUnread, unreadCount, previewLine, mentionsUser, chatRow, PREVIEW_CHARS };
