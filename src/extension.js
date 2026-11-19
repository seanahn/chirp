'use strict';
// chirp: Microsoft Teams in VS Code. Wires sign-in (design 201), Graph, the pollers, the sidebar and the conversation tabs.
const vscode = require('vscode');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createAuth, createTokenFileAuth, CHIRP_CLIENT_ID, SignInNeeded, Offline, SignInCancelled, SignInFailed } = require('./auth');
const { createEditorAuth } = require('./editorAuth');
const { createDeviceCodeAuth } = require('./deviceCode');
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
const CHANNELS_WANTED = 'chirp.channelsWanted';
const USER_SIGNED_OUT = 'chirp.userSignedOut';   // shared by windows, kept across reloads: only Sign In clears it
const NO_TOKEN_FILE = 'Set chirp.signIn.tokenFile to the token file to use.';
const LOST = 'Signed out: sign in again';
const UNREACHABLE = "Couldn't reach Microsoft. Check the connection and sign in again.";
const TEAMS_MS = 1800000;
const MENTIONS_MS = 60000;
const OFFLINE = 'Offline, retrying';
const chatKey = (id) => 'chat:' + id;
const adminLink = (clientId) => `https://login.microsoftonline.com/organizations/adminconsent?client_id=${clientId}`;
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

let current = null;

/**
 * @param deps for tests: fetch, chirpDir, watchFile, unwatchFile, setInterval, clearInterval, secrets, sleep, clientId
 * @returns the running extension: refresh(), dispose(), and its parts for the later wiring
 */
function activate(context, deps = {}) {
  const out = vscode.window.createOutputChannel('chirp');
  const log = (e) => out.appendLine(`[${new Date().toISOString()}] ${e && e.stack ? e.stack : e}`);
  const watchFile = deps.watchFile || fs.watchFile, unwatchFile = deps.unwatchFile || fs.unwatchFile;
  const setIntervalFn = deps.setInterval || setInterval, clearIntervalFn = deps.clearInterval || clearInterval;
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a));
  const clientId = deps.clientId || CHIRP_CLIENT_ID;
  const secrets = deps.secrets || context.secrets;
  const cfg = (k) => vscode.workspace.getConfiguration('chirp').get(k);
  const mentions = createMentionState(context.globalState);
  const isFocused = () => vscode.window.state.focused;

  // channels: 'enabled' | 'off' | 'failed' | 'forbidden'; signIn: null | { stage, userCode?, verificationUri? }
  const s = { me: null, teams: [], chats: [], lastPreview: new Map(), counts: new Map(), status: null, throttle: null,
    signedOut: false, signIn: null, channels: 'off' };
  const sidebar = new Sidebar(context.extensionUri, { meName: () => (s.me && s.me.displayName) || '' });
  const pollers = [];

  // ---- sign-in: the method from the settings, rebuilt when they change
  let tokenFile = '', auth = null, cancelSignIn = null, userCancelled = false;
  function buildAuth() {
    tokenFile = expandHome(cfg('signIn.tokenFile') || '');
    auth = createAuth({
      method: cfg('signIn.method') || 'auto', tokenFile,
      makeEditor: () => (vscode.authentication && vscode.authentication.getSession ? createEditorAuth({ authentication: vscode.authentication, clientId, state: context.globalState }) : null),
      makeDeviceCode: () => createDeviceCodeAuth(Object.assign({ secrets, fetch: fetchFn, clientId, onCode: showCode }, deps.sleep ? { sleep: deps.sleep } : {})),
      makeTokenFile: () => createTokenFileAuth({ file: tokenFile, fetch: fetchFn }),
      onNote: (text) => setStatus({ kind: 'note', text }),
    });
  }
  buildAuth();
  const g = createGraph({ tokens: { accessToken: () => auth.accessToken(), refresh: () => auth.refresh(), tenantId: () => auth.tenantId() }, fetch: fetchFn });
  const methodNow = () => (auth.current() ? auth.current().method : null);
  const channelsOn = () => s.channels === 'enabled';
  const userOut = () => !!context.globalState.get(USER_SIGNED_OUT);
  // every Sign Out, settings change or account change starts a new generation; poll results from an older one are dropped
  let gen = 0;
  function accountRow() { const a = auth.account(); return a ? { username: a.username || a.name || '', method: methodNow() } : null; }
  function showCode({ userCode, verificationUri }) {
    s.signIn = { stage: 'code', userCode, verificationUri };
    sidebar.update({ signIn: s.signIn });
    vscode.window.showInformationMessage(`chirp: enter the code ${userCode} at ${verificationUri}`);
  }

  function showStatus() { sidebar.update({ status: s.status || s.throttle }); }
  function setStatus(st) { s.status = st; showStatus(); }

  // fetched once per sign-in: a profile from the cache only draws the rows until then, in case the login changed
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
    const g0 = gen;
    const me = await ensureMe();
    const chats = await api.listChats(g);
    if (g0 !== gen) return;
    const todo = [];
    for (const c of chats) {
      const last = c.lastMessagePreview;
      if (!model.isUnread(c, me.id)) { mentions.clear(chatKey(c.id)); s.counts.delete(c.id); s.lastPreview.set(c.id, last && last.id); continue; }
      if (s.lastPreview.get(c.id) !== (last && last.id)) todo.push(c);
    }
    // the list shows at once; the mention checks follow, a few at a time, and update the rows when done
    s.chats = chats;
    if (s.status && s.status.kind !== 'note') s.status = null;
    sidebar.update({ chats: chatRows(), status: s.status || s.throttle, chatsLoaded: true });
    saveLists();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, todo.length) }, async () => { while (next < todo.length && g0 === gen) await checkChat(todo[next++], me); }));
    if (todo.length && g0 === gen) sidebar.update({ chats: chatRows() });
  }

  /** What a failed poll means for the sidebar. */
  function onPollError(e) {
    if (e instanceof SignInNeeded) return signedOut({ lost: !s.signedOut && methodNow() !== 'tokenFile' });
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

  // While signed out: watch the token file (if that's the method), and try every 5 s, since another window or tool may sign
  // in meanwhile. Any good read, or a successful Sign In or Refresh, signs chirp back in.
  let recheck = null, onChange = null, watchedFile = '';
  function stopWatching() {
    if (onChange) { unwatchFile(watchedFile, onChange); onChange = null; }
    if (recheck !== null) { clearIntervalFn(recheck); recheck = null; }
  }
  function signedOut({ lost = false } = {}) {
    if (s.signedOut) return;
    s.signedOut = true;
    for (const p of pollers) p.stop();
    s.signIn = { stage: 'signedOut' };
    const method = cfg('signIn.method') || 'auto';
    if (method === 'tokenFile' && !tokenFile) setStatus({ kind: 'signin', text: NO_TOKEN_FILE });
    else if (tokenFile && method !== 'editor' && method !== 'deviceCode') setStatus({ kind: 'signin', text: `Sign in with the tool that keeps ${tokenFile}` });
    else if (lost) setStatus({ kind: 'signin', text: LOST });
    sidebar.update({ signIn: s.signIn, account: null });
    stopWatching();
    if (userOut()) return;   // signed out by the user: only Sign In brings chirp back
    const retry = async () => { if (userOut() || !s.signedOut) return; try { await auth.accessToken(); await authenticated(); } catch (_) { /* still signed out */ } };
    if (tokenFile) { watchedFile = tokenFile; onChange = () => { retry(); }; watchFile(tokenFile, { interval: 5000 }, onChange); }
    recheck = setIntervalFn(retry, 5000);
  }
  /** A working login was found, by any path: confirm who it is, and clear the last account's data if it's someone else. */
  async function authenticated() {
    const prev = s.me && s.me.id;
    meFetched = false;
    const me = await ensureMe();
    if (prev && prev !== me.id) { clearData(); s.me = me; meFetched = true; }
    signedIn();
  }
  function signedIn() {
    s.signedOut = false;
    stopWatching();
    s.signIn = null;
    if (s.status && s.status.kind === 'signin') s.status = null;
    s.channels = methodNow() === 'tokenFile' ? (s.channels === 'forbidden' ? 'forbidden' : 'enabled') : (auth.hasChannels() ? 'enabled' : 'off');
    sidebar.update({ signIn: null, account: accountRow(), channels: s.channels, status: s.status || s.throttle });
    for (const p of pollers) p.start();
  }

  /** What chirp keeps about the account: cached lists, mention state, the files under ~/.chirp, open tabs. */
  function clearData() {
    gen++;
    context.globalState.update(LISTS_KEY, undefined);
    mentions.reset();
    s.me = null; meFetched = false; s.chats = []; s.teams = []; s.counts.clear(); s.lastPreview.clear();
    mirror.clearAll();
    conversations.closeAll();
    sidebar.update({ chats: [], teams: [], chatsLoaded: false, teamsLoaded: false });
  }

  async function signIn() {
    if (cancelSignIn) return;
    const listeners = [];
    const cancel = { isCancellationRequested: false, onCancellationRequested: (fn) => { listeners.push(fn); return { dispose() {} }; } };
    cancelSignIn = () => { userCancelled = true; cancel.isCancellationRequested = true; listeners.forEach((f) => f()); };
    userCancelled = false;
    s.signIn = { stage: 'waiting' }; sidebar.update({ signIn: s.signIn });
    try {
      await auth.signIn({ channels: false, newAccount: userOut(), cancel });
    } catch (e) {
      cancelSignIn = null;
      s.signIn = { stage: 'signedOut' }; sidebar.update({ signIn: s.signIn });
      if (e instanceof SignInCancelled) return;
      if (e instanceof SignInNeeded) { s.signedOut = false; return signedOut(); }   // says what to do: the token file, or none set
      if (e instanceof SignInFailed) { setStatus({ kind: 'error', text: e.message }); log(e); return; }
      if (e instanceof Offline) { setStatus({ kind: 'offline', text: UNREACHABLE }); return; }
      setStatus({ kind: 'error', text: `chirp couldn't sign in: ${e && e.message}` }); log(e); return;
    }
    cancelSignIn = null;
    await context.globalState.update(USER_SIGNED_OUT, undefined);
    if (s.status && (s.status.kind === 'error' || s.status.kind === 'note' || s.status.kind === 'signin')) s.status = null;
    try { await authenticated(); } catch (e) { onPollError(e); return; }
    if (methodNow() !== 'tokenFile' && context.globalState.get(CHANNELS_WANTED) && !auth.hasChannels()) await enableChannels();
  }

  async function enableChannels() {
    // not while signed out, not twice, and never as a first sign-in (chats come first)
    if (methodNow() === 'tokenFile' || cancelSignIn || s.signedOut || !auth.current()) return;
    const listeners = [];
    const cancel = { isCancellationRequested: false, onCancellationRequested: (fn) => { listeners.push(fn); return { dispose() {} }; } };
    cancelSignIn = () => { userCancelled = true; cancel.isCancellationRequested = true; listeners.forEach((f) => f()); };
    userCancelled = false;
    s.signIn = { stage: 'waiting' }; sidebar.update({ signIn: s.signIn });
    try {
      await auth.signIn({ channels: true, cancel });
      s.channels = 'enabled';
      await context.globalState.update(CHANNELS_WANTED, true);
      teamsPoller.kick(); mentionPoller.kick();
    } catch (e) {
      // chirp can't tell "an admin must approve" from cancelling: any failure but chirp's own Cancel gets the admin link
      s.channels = userCancelled ? 'off' : 'failed';
      if (e instanceof SignInFailed && e.kind === 'storage') { s.channels = 'off'; setStatus({ kind: 'error', text: e.message }); }
      if (!(e instanceof SignInCancelled) && !(e instanceof SignInFailed)) log(e);
    } finally {
      cancelSignIn = null;
      s.signIn = null;
      sidebar.update({ signIn: null, channels: s.channels });
    }
  }

  async function signOut() {
    if (cancelSignIn) cancelSignIn();
    for (const p of pollers) p.stop();
    await context.globalState.update(USER_SIGNED_OUT, true);
    try { await auth.signOut(); } catch (e) { log(e); }
    await context.globalState.update(CHANNELS_WANTED, undefined);
    clearData();
    s.channels = 'off';
    s.signedOut = false;   // so signedOut() below runs in full
    signedOut();
    sidebar.update({ channels: s.channels });
  }

  const chatPoller = addPoller(pollChats, CHAT_LIST_MS);

  function teamRows() {
    return s.teams.map((t) => ({ id: t.id, name: t.name, channels: t.channels.map((c) => ({ id: c.id, name: c.name, mention: mentions.isFlagged(`channel:${t.id}/${c.id}`) })) }));
  }
  async function pollTeams() {
    if (!channelsOn()) return;
    const g0 = gen;
    let teams;
    try { teams = await api.joinedTeams(g); }
    catch (e) {
      // a login without the channel permissions: chats still work, and the Teams section says why
      if (e && e.status === 403) { s.channels = 'forbidden'; sidebar.update({ channels: s.channels }); return; }
      throw e;
    }
    const out = [];
    for (const t of teams) {
      const chans = await api.channels(g, t.id);
      out.push({ id: t.id, name: t.displayName, channels: chans.map((c) => ({ id: c.id, name: c.displayName })) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    if (g0 !== gen) return;
    s.teams = out;
    sidebar.update({ teams: teamRows(), teamsLoaded: true });
    saveLists();
  }
  const teamsPoller = addPoller(pollTeams, TEAMS_MS);
  async function pollMentions() {
    if (!channelsOn()) return;
    const before = mentions.flagged().join();
    await scanChannelMentions({ api, g, me: await ensureMe(), state: mentions });
    if (mentions.flagged().join() !== before) sidebar.update({ teams: teamRows() });
  }
  const mentionPoller = addPoller(pollMentions, MENTIONS_MS);
  const getChannel = (teamId, id) => {
    const t = s.teams.find((x) => x.id === teamId); const c = t && t.channels.find((x) => x.id === id);
    return c ? { team: t.name, name: c.name } : undefined;
  };

  const mirror = createMirror({ dir: deps.chirpDir || path.join(os.homedir(), '.chirp'), enabled: () => cfg('agentFiles') !== false });
  const conversations = new Conversations({
    api, g, mirror, log, isFocused, extensionUri: context.extensionUri,
    me: ensureMe, meId: () => (s.me ? s.me.id : null), tenantId: () => auth.tenantId(),
    getChat: (id) => s.chats.find((c) => c.id === id), getChannel,
    addPoller: (run, everyMs) => addPoller(run, everyMs),
    onFront: (ref) => sidebar.front(ref),
    onOpened: (key) => { mentions.clear(key); sidebar.update({ chats: chatRows(), teams: teamRows() }); },
    onRead: (chatId) => {
      const c = s.chats.find((x) => x.id === chatId);
      if (c) c.viewpoint = Object.assign({}, c.viewpoint, { lastMessageReadDateTime: new Date().toISOString() });
      s.counts.delete(chatId); mentions.clear(chatKey(chatId));
      sidebar.update({ chats: chatRows() });
    },
  });
  sidebar.onOpen((ref) => { try { conversations.open(ref); } catch (e) { log(e); } });

  /** The settings changed: stop, rebuild the sign-in, and sign in again silently if the new method has a session. */
  async function onSettings() {
    if (cancelSignIn) cancelSignIn();
    gen++;
    for (const p of pollers) p.stop();
    stopWatching();
    buildAuth();
    s.signedOut = false;
    await startUp();
  }
  async function startUp() {
    if (userOut()) { s.signedOut = false; return signedOut(); }
    try { await auth.accessToken(); } catch (e) {
      if (e instanceof SignInNeeded) { s.signedOut = false; return signedOut(); }
      if (e instanceof Offline) { setStatus({ kind: 'offline', text: OFFLINE }); return signedIn(); }   // the pollers back off
      log(e); s.signedOut = false; signedOut();
      return setStatus({ kind: 'error', text: `chirp couldn't sign in: ${e && e.message}` });
    }
    try { await authenticated(); } catch (e) { onPollError(e); }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('chirp.sidebar', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeWindowState((w) => { if (w.focused) { for (const p of pollers) p.kick(); conversations.onFocus(); } }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { deserializeWebviewPanel: async (panel, state) => conversations.restore(panel, state) }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('chirp.signIn')) onSettings().catch(log);
      if (e.affectsConfiguration('chirp.agentFiles') && cfg('agentFiles') === false) mirror.clearAll();   // off means the plain-text chats go too
    }),
    vscode.commands.registerCommand('chirp.activeConversationFile', () => conversations.activeConversationFile()),
    vscode.commands.registerCommand('chirp.refresh', () => refresh()),
    vscode.commands.registerCommand('chirp.focusFilter', () => sidebar.focusFilter()),
    vscode.commands.registerCommand('chirp.signIn', () => signIn()),
    vscode.commands.registerCommand('chirp.signOut', () => signOut()),
    vscode.commands.registerCommand('chirp.enableChannels', () => enableChannels()),
    vscode.commands.registerCommand('chirp.cancelSignIn', () => { if (cancelSignIn) cancelSignIn(); }),
    vscode.commands.registerCommand('chirp.findPeople', (query) => findPeople(query)),
    vscode.commands.registerCommand('chirp.startChat', (userId, name) => startChat(userId, name)),
    vscode.commands.registerCommand('chirp.copyAdminLink', () => vscode.env.clipboard.writeText(adminLink(clientId))),
    vscode.commands.registerCommand('chirp.copyCode', async () => {
      if (!s.signIn || s.signIn.stage !== 'code') return;
      await vscode.env.clipboard.writeText(s.signIn.userCode);
      await vscode.env.openExternal(vscode.Uri.parse(s.signIn.verificationUri));
    }),
    out,
  );

  /** People whose name or mail starts with what was typed, for a chat the filter didn't find. */
  async function findPeople(query) {
    const q = String(query || '').trim();
    if (q.length < 2 || s.signedOut) return;
    try {
      const me = await ensureMe();
      const found = await api.findPeople(g, q);
      sidebar.update({ people: { query: q, results: found.filter((x) => x.id !== me.id).map((x) => ({ id: x.id, name: x.displayName || x.mail || x.id, mail: x.mail || '' })) } });
    } catch (e) {
      if (e && e.status === 403) return sidebar.update({ people: { query: q, results: [], error: "chirp can't search people with this login." } });
      onPollError(e);
    }
  }
  /** Opens a 1:1 with someone: Graph hands back the existing chat if there is one, else makes a new, empty one. */
  async function startChat(userId, name) {
    if (!userId || s.signedOut) return;
    try {
      const me = await ensureMe();
      const chat = await api.startChat(g, me.id, userId);
      sidebar.update({ people: null });
      conversations.open({ kind: 'chat', id: chat.id, name: name || undefined });
    } catch (e) {
      if (e && e.status === 403) return setStatus({ kind: 'error', text: "chirp can't start chats with this login." });
      onPollError(e);
    }
  }

  async function refresh() {
    if (s.signedOut) { if (userOut()) return; try { await auth.accessToken(); await authenticated(); } catch (_) { return; } return; }
    try { await guarded(pollChats)(); } catch (_) { /* shown as a status; the poller backs off */ }
  }
  function dispose() { for (const p of pollers) p.stop(); stopWatching(); }

  // the lists from the last run show at once; the first polls replace them
  const cached = context.globalState.get(LISTS_KEY);
  if (cached) {
    s.me = cached.me || null; s.chats = cached.chats || []; s.teams = cached.teams || [];
    sidebar.update({ chats: chatRows(), teams: teamRows() });
  }
  // a first run has nothing cached: the sidebar says it's loading until each list's first answer
  sidebar.update({ signIn: null, account: null, channels: s.channels, chatsLoaded: !!cached, teamsLoaded: !!(cached && cached.teams && cached.teams.length) });
  startUp().catch(log);
  current = { mentionPoller, teamsPoller, teamRows, pollers, refresh, dispose, g, api, get auth() { return auth; }, mentions, sidebar, mirror, conversations, log, state: s, addPoller, chatPoller, isFocused, onPollError, chatRows };
  return current;
}

function deactivate() { if (current) current.dispose(); current = null; }

module.exports = { activate, deactivate, CHAT_LIST_MS };
