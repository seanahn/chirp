'use strict';
// Each open conversation as a plain-text file under ~/.chirp, so the agent beside chirp can read it, and current.teams as
// a copy of the one most recently in front (design 101, "How the agent knows the open conversation").
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { htmlToText } = require('./html');

const HISTORY_CAP = 300;
const SHORT_ID_LEN = 6;
const NAME_MAX = 80;

/** A few hex characters of a hash of the whole id: meeting ids all start 'meeting_', and 1:1 ids often start with Sean's own id. */
function shortId(id) {
  return crypto.createHash('sha1').update(String(id || '')).digest('hex').slice(0, SHORT_ID_LEN);
}
function safe(name) {
  return String(name || '').replace(/\p{Cf}/gu, '').replace(/[/\\\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').slice(0, NAME_MAX);
}
function fileName(conv) {
  return conv.kind === 'channel'
    ? path.join('channels', `${safe(`${conv.team} › ${conv.name}`)} ${shortId(conv.id)}.teams`)
    : path.join('chats', `${safe(conv.name)} ${shortId(conv.id)}.teams`);
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(iso) { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
const oneLine = (x) => String(x == null ? '' : x).replace(/[\r\n\u2028\u2029]+/g, ' ');
const sender = (m) => (m.from && m.from.user && m.from.user.displayName) || (m.from && m.from.application && m.from.application.displayName) || 'Unknown';
/** Real messages only: no system events, nothing deleted. */
const shown = (m) => m && (m.messageType || 'message') === 'message' && !m.deletedDateTime;

function block(m, indent) {
  // the text is indented under its header line, so a message can't pass for a header or for another sender's message
  const lines = [`[${stamp(m.createdDateTime)}] ${oneLine(sender(m))} (id ${m.id}):`];
  if (m.subject) lines.push(`  Subject: ${oneLine(m.subject)}`);
  const text = htmlToText(m.body && m.body.content);
  if (text) lines.push(...text.split('\n').map((l) => '  ' + l));
  return lines.map((l) => indent + l).join('\n');
}

function formatChat(conv, messages) {
  const head = [`# Teams chat: ${oneLine(conv.name)}`, `# chat id: ${conv.id}`, `# members: ${(conv.members || []).map(oneLine).join(', ')}`,
    '# Written by chirp; mirrors the latest messages. Older messages, and replies:',
    '# use the ms365 MCP server with the chat id above (list-chat-messages, send-chat-message).'];
  const body = messages.filter(shown).slice(-HISTORY_CAP).map((m) => block(m, ''));
  return head.join('\n') + '\n' + (body.length ? '\n' + body.join('\n\n') + '\n' : '');
}
function formatChannel(conv, posts) {
  const head = [`# Teams channel: ${oneLine(conv.team)} › ${oneLine(conv.name)}`, `# team id: ${conv.teamId}`, `# channel id: ${conv.id}`,
    '# Written by chirp; mirrors the latest posts, each with its id and its replies indented beneath it.',
    '# Older posts, and replies: use the ms365 MCP server with the ids above (list-channel-messages; post-channel-message with a post id to reply).'];
  const body = posts.filter(shown).slice(-HISTORY_CAP).map((p) => [block(p, ''), ...(p.replies || []).filter(shown).map((r) => block(r, '    '))].join('\n'));
  return head.join('\n') + '\n' + (body.length ? '\n' + body.join('\n\n') + '\n' : '');
}

function createMirror({ dir }) {
  const entries = new Map();   // conversation id -> { path, open }
  let current = null;

  function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); }
  function atomic(file, text) {
    ensureDir(dir); ensureDir(path.dirname(file));
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  /** Writes the conversation's file and returns its path. A renamed conversation keeps its file until closed(). */
  function write(conv, items) {
    const desired = path.join(dir, fileName(conv));
    let e = entries.get(conv.id);
    if (e && !e.open && e.path !== desired) {
      if (fs.existsSync(e.path)) fs.renameSync(e.path, desired);
      if (current === e.path) current = desired;
      e = null;
    }
    if (!e) { e = { path: desired, open: true }; entries.set(conv.id, e); }
    e.open = true;
    atomic(e.path, conv.kind === 'channel' ? formatChannel(conv, items) : formatChat(conv, items));
    if (current === e.path && stillOurs(conv)) setCurrent(e.path);
    return e.path;
  }

  /** Whether current.teams still shows this conversation: another window may have taken it since. */
  function stillOurs(conv) {
    let head = '';
    try { head = fs.readFileSync(path.join(dir, 'current.teams'), 'utf8').split('\n', 4).join('\n'); } catch (_) { return true; }
    return head.includes(`# ${conv.kind === 'channel' ? 'channel' : 'chat'} id: ${conv.id}\n`);
  }

  function setCurrent(file) {
    current = file;
    atomic(path.join(dir, 'current.teams'), fs.readFileSync(file, 'utf8'));
  }

  return {
    write, setCurrent,
    closed(convId) { const e = entries.get(convId); if (e) e.open = false; },
    pathFor(convId) { const e = entries.get(convId); return e ? e.path : null; },
  };
}

module.exports = { createMirror, shortId, fileName, formatChat, formatChannel, HISTORY_CAP, SHORT_ID_LEN };
