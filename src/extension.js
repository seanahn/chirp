'use strict';
// chirp: Microsoft Teams in VS Code. Wires the shared login, Graph, the pollers, the sidebar and the conversation tabs.
const vscode = require('vscode');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createTokenStore, SignInNeeded, Offline } = require('./tokenStore');
const { createGraph } = require('./graph');
const api = require('./api');
const { createPoller } = require('./poller');
const model = require('./model');
const { createMentionState, scanChannelMentions } = require('./mentions');
const { Sidebar } = require('./sidebar');
const { createMirror } = require('./mirror');
const { Conversations, VIEW_TYPE } = require('./conversation');

const CHAT_LIST_MS = 30000;
const CHECK_PARALLEL = 4;
const LISTS_KEY = 'chirp.lists';
const TEAMS_MS = 1800000;
const MENTIONS_MS = 60000;
const SIGN_IN = "Sign in with the ms365 MCP server's login tool";
const OFFLINE = 'Offline, retrying';
const chatKey = (id) => 'chat:' + id;

let current = null;

/**
 * @param deps for tests: fetch, tokenFile, chirpDir, watchFile, unwatchFile
 * @returns the running extension: refresh(), dispose(), and its parts for the later wiring
 */
function activate(context, deps = {}) {
  const out = vscode.window.createOutputChannel('chirp');
  const log = (e) => out.appendLine(`[${new Date().toISOString()}] ${e && e.stack ? e.stack : e}`);
  const tokenFile = deps.tokenFile || path.join(os.homedir(), '.ms365-zig-mcp-token.json');
  const watchFile = deps.watchFile || fs.watchFile, unwatchFile = deps.unwatchFile || fs.unwatchFile;
  const setIntervalFn = deps.setInterval || setInterval, clearIntervalFn = deps.clearInterval || clearInterval;
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a));
  const tokens = createTokenStore({ file: tokenFile, fetch: fetchFn });
  const g = createGraph({ tokens, fetch: fetchFn });
  const mentions = createMentionState(context.globalState);
  const isFocused = () => vscode.window.state.focused;

  const s = { me: null, teams: [], chats: [], lastPreview: new Map(), counts: new Map(), status: null, throttle: null, signedOut: false };
  const sidebar = new Sidebar(context.extensionUri, { meName: () => (s.me && s.me.displayName) || '' });
  const pollers = [];

  function showStatus() { sidebar.update({ status: s.status || s.throttle }); }
  function setStatus(st) { s.status = st; showStatus(); }

  // fetched once per run: a profile from the cache only draws the rows until then, in case the login changed
  let meFetched = false;
  async function ensureMe() { if (!meFetched) { s.me = await api.me(g); meFetched = true; } return s.me; }

  function chatRows() {
    const meId = s.me ? s.me.id : null;
    return s.chats.map((c) => model.chatRow(c, meId, { mention: mentions.isFlagged(chatKey(c.id)), unreadCount: s.counts.get(c.id) ?? null }));
  }

  /** The chat as the cache keeps it: what the rows, names and read state need, nothing more. */
  const slim = (c) => ({ id: c.id, topic: c.topic, chatType: c.chatType, viewpoint: c.viewpoint,
    members: (c.members || []).map((m) => ({ userId: m.userId, displayName: m.displayName })),
    lastMessagePreview: c.lastMessagePreview && { id: c.lastMessagePreview.id, createdDateTime: c.lastMessagePreview.createdDateTime, from: c.lastMessagePreview.from, body: c.lastMessagePreview.body } });
  function saveLists() { context.globalState.update(LISTS_KEY, { me: s.me, chats: s.chats.map(slim), teams: s.teams }); }

  /** An unread chat whose last message changed: does it mention Sean, and how many are unread? */
  async function checkChat(c, me) {
    const last = c.lastMessagePreview;
    const read = c.viewpoint && c.viewpoint.lastMessageReadDateTime;
    const { messages } = await api.chatMessages(g, c.id, { top: 20 });
    const fresh = messages.filter((m) => !read || Date.parse(m.createdDateTime) > Date.parse(read));
    const hit = fresh.find((m) => model.mentionsUser(m, me.id));
    if (hit) mentions.flag(chatKey(c.id), hit.id);
    s.counts.set(c.id, model.unreadCount(messages, read, me.id));
    s.lastPreview.set(c.id, last && last.id);
  }

  async function pollChats() {
    const me = await ensureMe();
    const chats = await api.listChats(g);
    const todo = [];
    for (const c of chats) {
      const last = c.lastMessagePreview;
      if (!model.isUnread(c, me.id)) { mentions.clear(chatKey(c.id)); s.counts.delete(c.id); s.lastPreview.set(c.id, last && last.id); continue; }
      if (s.lastPreview.get(c.id) !== (last && last.id)) todo.push(c);
    }
    // the list shows at once; the mention checks follow, a few at a time, and update the rows when done
    s.chats = chats;
    if (s.status) s.status = null;
    sidebar.update({ chats: chatRows(), status: s.throttle });
    saveLists();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, todo.length) }, async () => { while (next < todo.length) await checkChat(todo[next++], me); }));
    if (todo.length) sidebar.update({ chats: chatRows() });
  }

  /** What a failed poll means for the sidebar. */
  function onPollError(e) {
    if (e instanceof SignInNeeded) return signedOut();
    if (e instanceof Offline) return setStatus({ kind: 'offline', text: OFFLINE });
    log(e);
  }
  function guarded(run) {
    // throttling and being offline go back to the poller, which backs off; the rest is shown or logged here
    return async () => { try { await run(); } catch (e) { if (e && (e.status === 429 || e.status === 503)) throw e; onPollError(e); if (e instanceof Offline) throw e; } };
  }

  function addPoller(run, everyMs) {
    const p = createPoller({ run: guarded(run), everyMs, isFocused, onThrottle: (note) => { s.throttle = note ? { kind: 'throttle', text: note } : null; showStatus(); }, onError: log });
    pollers.push(p);
    p.remove = () => { p.stop(); const i = pollers.indexOf(p); if (i >= 0) pollers.splice(i, 1); };
    return p;
  }

  // While signed out: watch the token file, and also try it every 5 s, since a bad read may have been passing and the file
  // may never change again. Any good read (or a successful Refresh) signs chirp back in.
  let recheck = null, onChange = null;
  function signedOut() {
    if (s.signedOut) return;
    s.signedOut = true;
    for (const p of pollers) p.stop();
    setStatus({ kind: 'signin', text: SIGN_IN });
    onChange = () => { signedIn(); };
    watchFile(tokenFile, { interval: 5000 }, onChange);
    recheck = setIntervalFn(async () => { try { await tokens.accessToken(); signedIn(); } catch (_) { /* still signed out */ } }, 5000);
  }
  function signedIn() {
    if (!s.signedOut) return;
    s.signedOut = false;
    if (onChange) { unwatchFile(tokenFile, onChange); onChange = null; }
    if (recheck !== null) { clearIntervalFn(recheck); recheck = null; }
    setStatus(null);
    for (const p of pollers) p.start();
  }

  const chatPoller = addPoller(pollChats, CHAT_LIST_MS);

  function teamRows() {
    return s.teams.map((t) => ({ id: t.id, name: t.name, channels: t.channels.map((c) => ({ id: c.id, name: c.name, mention: mentions.isFlagged(`channel:${t.id}/${c.id}`) })) }));
  }
  async function pollTeams() {
    const teams = await api.joinedTeams(g);
    const out = [];
    for (const t of teams) {
      const chans = await api.channels(g, t.id);
      out.push({ id: t.id, name: t.displayName, channels: chans.map((c) => ({ id: c.id, name: c.displayName })) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    s.teams = out;
    sidebar.update({ teams: teamRows() });
    saveLists();
  }
  const teamsPoller = addPoller(pollTeams, TEAMS_MS);
  async function pollMentions() {
    const before = mentions.flagged().join();
    await scanChannelMentions({ api, g, me: await ensureMe(), state: mentions });
    if (mentions.flagged().join() !== before) sidebar.update({ teams: teamRows() });
  }
  const mentionPoller = addPoller(pollMentions, MENTIONS_MS);
  const getChannel = (teamId, id) => {
    const t = s.teams.find((x) => x.id === teamId); const c = t && t.channels.find((x) => x.id === id);
    return c ? { team: t.name, name: c.name } : undefined;
  };

  const mirror = createMirror({ dir: deps.chirpDir || path.join(os.homedir(), '.chirp') });
  const conversations = new Conversations({
    api, g, mirror, log, isFocused, extensionUri: context.extensionUri,
    me: ensureMe, meId: () => (s.me ? s.me.id : null), tenantId: () => tokens.tenantId(),
    getChat: (id) => s.chats.find((c) => c.id === id), getChannel,
    addPoller: (run, everyMs) => addPoller(run, everyMs),
    onOpened: (key) => { mentions.clear(key); sidebar.update({ chats: chatRows(), teams: teamRows() }); },
    onRead: (chatId) => {
      const c = s.chats.find((x) => x.id === chatId);
      if (c) c.viewpoint = Object.assign({}, c.viewpoint, { lastMessageReadDateTime: new Date().toISOString() });
      s.counts.delete(chatId); mentions.clear(chatKey(chatId));
      sidebar.update({ chats: chatRows() });
    },
  });
  sidebar.onOpen((ref) => { try { conversations.open(ref); } catch (e) { log(e); } });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('chirp.sidebar', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeWindowState((w) => { if (w.focused) { for (const p of pollers) p.kick(); conversations.onFocus(); } }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { deserializeWebviewPanel: async (panel, state) => conversations.restore(panel, state) }),
    vscode.commands.registerCommand('chirp.activeConversationFile', () => conversations.activeConversationFile()),
    vscode.commands.registerCommand('chirp.refresh', () => refresh()),
    vscode.commands.registerCommand('chirp.focusFilter', () => sidebar.focusFilter()),
    out,
  );

  async function refresh() {
    if (s.signedOut) { try { await tokens.accessToken(); signedIn(); } catch (_) { return; } }
    try { await guarded(pollChats)(); } catch (_) { /* shown as a status; the poller backs off */ }
  }
  function dispose() { for (const p of pollers) p.stop(); unwatchFile(tokenFile); if (recheck !== null) clearIntervalFn(recheck); }

  // the lists from the last run show at once; the first polls replace them
  const cached = context.globalState.get(LISTS_KEY);
  if (cached) {
    s.me = s.me || cached.me || null; s.chats = cached.chats || []; s.teams = cached.teams || [];
    sidebar.update({ chats: chatRows(), teams: teamRows() });
  }
  for (const p of pollers) p.start();
  current = { mentionPoller, teamsPoller, teamRows, pollers, refresh, dispose, g, api, tokens, mentions, sidebar, mirror, conversations, log, state: s, addPoller, chatPoller, isFocused, onPollError, chatRows };
  return current;
}

function deactivate() { if (current) current.dispose(); current = null; }

module.exports = { activate, deactivate, CHAT_LIST_MS };
