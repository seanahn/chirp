'use strict';
// Conversation tabs: each open chat or channel as a webview panel, polled while open, mirrored to ~/.chirp, and (chats
// only) marked read in Teams only while Sean can see it (design 101, "A chat tab", "A channel tab" and "Read state").
const vscode = require('vscode');
const crypto = require('crypto');
const { textToHtml } = require('./html');
const model = require('./model');
const { createSender } = require('./sender');

const OPEN_TAB_MS = 5000;
const CHAT_PAGE = 50, CHANNEL_PAGE = 20;
const VIEW_TYPE = 'chirp.conversation';
const REACTIONS = { like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😡' };
const keyOf = (ref) => (ref.kind === 'channel' ? `channel:${ref.teamId}/${ref.id}` : `chat:${ref.id}`);
const real = (m) => m && (m.messageType || 'message') === 'message';
const shown = (m) => real(m) && !m.deletedDateTime;
const byTime = (a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime);
const fromMe = (m, meId) => !!(m.from && m.from.user && m.from.user.id === meId);

/** A Graph message as the page draws it; a channel post carries its replies, oldest first. */
function viewMessage(m, meId) {
  const u = m.from && m.from.user;
  const counts = new Map();
  for (const r of m.reactions || []) { const e = REACTIONS[r.reactionType] || r.reactionType; counts.set(e, (counts.get(e) || 0) + 1); }
  const v = {
    id: m.id,
    from: (u && u.displayName) || (m.from && m.from.application && m.from.application.displayName) || '',
    mine: !!(u && u.id === meId),
    time: m.createdDateTime,
    html: m.body && m.body.contentType === 'text' ? textToHtml(m.body.content || '') : (m.body && m.body.content) || '',
    edited: !!m.lastEditedDateTime,
    subject: m.subject || null,
    reactions: [...counts].map(([emoji, count]) => ({ emoji, count })),
    attachments: (m.attachments || []).filter((a) => a.contentType === 'reference' && /^https:\/\//.test(a.contentUrl || '')).map((a) => ({ name: a.name, url: a.contentUrl })),
  };
  if (m.replies) v.replies = m.replies.map((r) => viewMessage(r, meId));
  return v;
}

/** A channel post with only its real replies, oldest first. */
const tidyPost = (p) => Object.assign({}, p, { replies: (p.replies || []).filter(shown).sort(byTime) });
/** What changes when a message is edited, deleted, or (for a post) gets a reply. */
const signature = (m) => [m.lastModifiedDateTime || m.lastEditedDateTime || '', m.deletedDateTime || '', ...(m.replies || []).map((r) => r.id + '@' + (r.lastModifiedDateTime || ''))].join('|');

class Conversations {
  /**
   * @param o.api, o.g          Graph endpoints and transport
   * @param o.me()              Sean's { id, displayName } (a promise: fetched once)
   * @param o.meId()            his id if known yet, else null
   * @param o.tenantId()        for markChatRead
   * @param o.getChat(id)       the chat as the last chat-list poll saw it, or undefined
   * @param o.getChannel(teamId, id)  { team, name } from the teams list, or undefined
   * @param o.onRead(chatId)    a chat was marked read (the sidebar un-bolds it)
   * @param o.onOpened(key)     a conversation was opened (its mention clears)
   * @param o.addPoller(run, everyMs)
   */
  constructor(o) {
    Object.assign(this, o);
    this.tabs = new Map();
    this.front = null;   // the tab most recently in front
  }

  open(ref) {
    const key = keyOf(ref);
    const tab = this.tabs.get(key);
    if (tab) { tab.panel.reveal(); if (tab.loaded) this.onOpened(key); return tab; }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, this.titleFor(ref), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] });
    return this.attach(panel, ref);
  }

  restore(panel, state) {
    if (!state || !state.ref) { panel.dispose(); return; }
    this.attach(panel, state.ref);
  }

  /** The ref with the names it needs, so a tab restored after a reload has a title before the lists load. */
  named(ref) {
    if (ref.kind === 'channel') {
      const c = this.getChannel && this.getChannel(ref.teamId, ref.id);
      return c ? Object.assign({}, ref, { team: c.team, name: c.name }) : ref;
    }
    const chat = this.getChat(ref.id);
    return chat ? Object.assign({}, ref, { name: model.chatName(chat, this.meId()) }) : ref;
  }
  titleFor(ref) {
    const r = this.named(ref);
    if (r.kind === 'channel') return r.team && r.name ? `${r.team} › ${r.name}` : 'Teams channel';
    return r.name || 'Teams chat';
  }

  attach(panel, ref) {
    const key = keyOf(ref);
    const tab = { key, ref: this.named(ref), panel, messages: [], next: null, pendingRead: false, loaded: false, poller: null };
    this.tabs.set(key, tab);
    panel.title = this.titleFor(tab.ref);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'teams-tab.svg');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m) => this.receive(tab, m).catch((e) => this.log(e)));
    panel.onDidChangeViewState(() => {
      if (panel.active) this.toFront(tab);
      if (panel.visible) this.maybeMarkRead(tab).catch((e) => this.log(e));
    });
    panel.onDidDispose(() => {
      if (tab.poller) (tab.poller.remove || tab.poller.stop)();
      this.tabs.delete(key);
      if (this.front === tab) this.front = null;
      if (this.mirror.pathFor(tab.ref.id)) this.mirror.closed(tab.ref.id);
    });
    this.front = tab;
    return tab;
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'conversation.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'conversation.js'));
    const csp = webview.cspSource;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; img-src ${csp} https: data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  async receive(tab, m) {
    if (!m) return;
    if (m.type === 'ready') return this.firstLoad(tab);
    if (m.type === 'older') return this.older(tab);
    if (m.type === 'link') { if (/^https:\/\//i.test(String(m.url || ''))) await vscode.env.openExternal(vscode.Uri.parse(m.url)); return; }
    if (m.type === 'send') return this.send(tab, m);
  }

  conv(tab) {
    const r = tab.ref = this.named(tab.ref);
    if (r.kind === 'channel') return { kind: 'channel', id: r.id, teamId: r.teamId, team: r.team || '', name: r.name || '' };
    const chat = this.getChat(r.id);
    return { kind: 'chat', id: r.id, name: r.name || tab.panel.title, members: chat ? (chat.members || []).map((x) => x.displayName).filter(Boolean) : [] };
  }

  /** A page of the newest messages (or channel posts), oldest first, and the link to older ones. Deleted ones are kept,
   * marked, so a poll can see a message go; load and older drop them. */
  async fetchPage(tab, next) {
    if (tab.ref.kind === 'channel') {
      const { posts, next: n } = await this.api.channelMessages(this.g, tab.ref.teamId, tab.ref.id, next ? { next } : { top: CHANNEL_PAGE });
      return { items: posts.filter(real).map(tidyPost).reverse(), next: n };
    }
    const { messages, next: n } = await this.api.chatMessages(this.g, tab.ref.id, next ? { next } : { top: CHAT_PAGE });
    return { items: messages.filter(real).reverse(), next: n };
  }

  /** The first load; if it fails, the tab says so and its poller keeps trying. */
  async firstLoad(tab) {
    try { await this.load(tab); }
    catch (e) {
      this.log(e);
      tab.panel.webview.postMessage({ type: 'error', text: "Couldn't load this conversation. Retrying." });
      if (!tab.poller && this.tabs.has(tab.key)) { tab.poller = this.addPoller(() => this.poll(tab.key), OPEN_TAB_MS); tab.poller.start(); }
    }
  }

  async load(tab) {
    const me = await this.me();
    const { items, next } = await this.fetchPage(tab);
    tab.messages = items.filter(shown);
    tab.next = next;
    const conv = this.conv(tab);
    tab.panel.title = this.titleFor(tab.ref);
    tab.header = this.headerOf(tab, conv, me.id);
    tab.panel.webview.postMessage({ type: 'init', ref: tab.ref, title: tab.panel.title, members: conv.members || [], kind: conv.kind, me: { id: me.id }, canSend: this.canSend(tab), people: this.people(tab, me.id) });
    tab.panel.webview.postMessage({ type: 'messages', reset: true, more: !!next, messages: tab.messages.map((x) => viewMessage(x, me.id)) });
    const file = this.mirror.write(conv, tab.messages);
    if (this.front === tab || tab.panel.active) { this.front = tab; this.mirror.setCurrent(file); }
    this.onOpened(tab.key);
    if (tab.ref.kind === 'chat') { const chat = this.getChat(tab.ref.id); tab.pendingRead = !chat || model.isUnread(chat, me.id); }
    tab.loaded = true;
    await this.maybeMarkRead(tab);
    if (!tab.poller) { tab.poller = this.addPoller(() => this.poll(tab.key), OPEN_TAB_MS); tab.poller.start(); }
  }

  /** A channel tab turns read-only for good once Teams refuses a post there (403). */
  canSend(tab) { return !tab.readOnly; }

  /** The people a chat's message box offers after @: its members other than Sean, by name. Channels: none yet. */
  people(tab, meId) {
    if (tab.ref.kind !== 'chat') return [];
    const chat = this.getChat(tab.ref.id);
    return ((chat && chat.members) || []).filter((m) => m.userId && m.userId !== meId && m.displayName)
      .map((m) => ({ id: m.userId, name: m.displayName })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What the tab's header shows; compared on each poll, so someone added to the chat or a renamed chat shows up. */
  headerOf(tab, conv, meId) {
    return JSON.stringify({ title: this.titleFor(tab.ref), members: conv.members || [], people: this.people(tab, meId) });
  }
  refreshHeader(tab, meId) {
    const conv = this.conv(tab);
    const h = this.headerOf(tab, conv, meId);
    if (h === tab.header) return;
    tab.header = h;
    const v = JSON.parse(h);
    tab.panel.title = v.title;
    tab.panel.webview.postMessage(Object.assign({ type: 'header' }, v));
  }

  /** New, edited and (for posts) newly replied-to messages since the last poll. */
  async poll(key) {
    const tab = this.tabs.get(key);
    if (!tab) return;
    if (!tab.loaded) return this.load(tab);
    const me = await this.me();
    this.refreshHeader(tab, me.id);
    const { items } = await this.fetchPage(tab);
    const known = new Map(tab.messages.map((x, i) => [x.id, i]));
    const changed = [], fresh = [], removed = [];
    for (const m of items) {
      if (!known.has(m.id)) { if (shown(m)) fresh.push(m); continue; }
      if (m.deletedDateTime) { removed.push(m.id); continue; }
      const i = known.get(m.id);
      if (signature(m) !== signature(tab.messages[i])) { tab.messages[i] = m; changed.push(m); }
    }
    if (!fresh.length && !changed.length && !removed.length) return;
    if (removed.length) {
      tab.messages = tab.messages.filter((x) => !removed.includes(x.id));
      tab.panel.webview.postMessage({ type: 'removed', ids: removed });
    }
    tab.messages = tab.messages.concat(fresh);
    if (changed.length || fresh.length) tab.panel.webview.postMessage({ type: 'messages', messages: changed.concat(fresh).map((x) => viewMessage(x, me.id)) });
    this.mirror.write(this.conv(tab), tab.messages);
    if (tab.ref.kind === 'chat' && fresh.some((m) => !fromMe(m, me.id))) { tab.pendingRead = true; await this.maybeMarkRead(tab); }
  }

  async older(tab) {
    if (!tab.next) { tab.panel.webview.postMessage({ type: 'older', more: false, messages: [] }); return; }
    const me = await this.me();
    const { items, next } = await this.fetchPage(tab, tab.next);
    const have = new Set(tab.messages.map((x) => x.id));
    const add = items.filter((x) => shown(x) && !have.has(x.id));
    tab.messages = add.concat(tab.messages);
    tab.next = next;
    tab.panel.webview.postMessage({ type: 'older', more: !!next, messages: add.map((x) => viewMessage(x, me.id)) });
    this.mirror.write(this.conv(tab), tab.messages);
  }

  /** Sends what Sean typed; the page shows it pending until this answers. */
  async send(tab, m) {
    if (!this.canSend(tab)) return;
    const me = await this.me();
    const text = String(m.text || '');
    if (!text.trim()) return;
    const sender = createSender({ api: this.api, g: this.g, meId: me.id });
    const postId = tab.ref.kind === 'channel' && m.target && m.target.postId;
    const target = tab.ref.kind === 'chat' ? { kind: 'chat', chatId: tab.ref.id }
      : postId ? { kind: 'reply', teamId: tab.ref.teamId, channelId: tab.ref.id, postId: String(postId) }
        : { kind: 'post', teamId: tab.ref.teamId, channelId: tab.ref.id };
    // a Retry carries the first attempt's time, so the sender looks for that attempt before posting again
    tab.attempts = tab.attempts || new Map();
    const since = tab.attempts.get(m.pendingId);
    if (since == null) tab.attempts.set(m.pendingId, Date.now());
    const picks = Array.isArray(m.mentions) ? m.mentions.filter((x) => x && typeof x.name === 'string' && typeof x.userId === 'string') : [];
    const r = await sender.send(target, text, Object.assign(since == null ? {} : { since }, picks.length ? { mentions: picks } : {}));
    if (r.ok) tab.attempts.delete(m.pendingId);
    if (!r.ok) {
      if (r.forbidden && tab.ref.kind === 'channel') tab.readOnly = true;
      tab.panel.webview.postMessage({ type: 'failed', pendingId: m.pendingId, error: r.forbidden && tab.ref.kind === 'channel' ? 'Teams refused posting here (403).' : r.error, retryable: !(r.forbidden && tab.ref.kind === 'channel') && r.retryable, forbidden: r.forbidden });
      return;
    }
    const msg = r.message || {};
    if (target.kind === 'reply') {
      const i = tab.messages.findIndex((x) => x.id === target.postId);
      if (i >= 0 && !tab.messages[i].replies.some((x) => x.id === msg.id)) tab.messages[i] = Object.assign({}, tab.messages[i], { replies: tab.messages[i].replies.concat([msg]) });
    } else if (msg.id && !tab.messages.some((x) => x.id === msg.id)) tab.messages.push(tab.ref.kind === 'channel' ? tidyPost(msg) : msg);
    tab.panel.webview.postMessage({ type: 'sent', pendingId: m.pendingId, message: viewMessage(msg, me.id) });
    this.mirror.write(this.conv(tab), tab.messages);
  }

  /** Marks the chat read in Teams, only while its tab is on screen and the window has focus. */
  async maybeMarkRead(tab) {
    if (tab.ref.kind !== 'chat' || !tab.pendingRead || !tab.loaded) return;
    if (!tab.panel.visible || !this.isFocused()) return;
    tab.pendingRead = false;
    try { await this.api.markChatRead(this.g, tab.ref.id, (await this.me()).id, this.tenantId()); this.onRead(tab.ref.id); }
    catch (e) { tab.pendingRead = true; throw e; }
  }

  onFocus() { for (const tab of this.tabs.values()) this.maybeMarkRead(tab).catch((e) => this.log(e)); }

  toFront(tab) {
    this.front = tab;
    const file = this.mirror.pathFor(tab.ref.id);
    if (file) this.mirror.setCurrent(file);
  }

  /** Closes every conversation tab (signing out). */
  closeAll() { for (const tab of [...this.tabs.values()]) tab.panel.dispose(); }

  /** The file of the chirp tab most recently in front, while it is open and on screen. */
  activeConversationFile() {
    const t = this.front;
    if (!t || !this.tabs.has(t.key) || !t.panel.visible) return null;
    return this.mirror.pathFor(t.ref.id);
  }
}

module.exports = { Conversations, viewMessage, keyOf, OPEN_TAB_MS, VIEW_TYPE };
