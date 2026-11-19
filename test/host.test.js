'use strict';
// The extension host against a fake vscode, a fake Graph and a throwaway token file and ~/.chirp. No network.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { install, memento, secrets } = require('./vscodeStub');
const { shortId } = require('../src/mirror');
const { ui } = install();
const ext = require('../src/extension');

const ME = { id: 'me', displayName: 'Sean Ahn' };
const READ = '2026-11-17T10:00:00Z';
const mem = (userId, displayName) => ({ userId, displayName });
const msg = (id, from, at, html, extra) => Object.assign({ id, messageType: 'message', createdDateTime: at, from: { user: { id: from, displayName: from === 'me' ? 'Sean Ahn' : 'Ben Carter' } }, body: { content: html || 'x' } }, extra);
function chat(id, o) { return Object.assign({ id, chatType: 'group', topic: 'Chat ' + id, members: [mem('me', 'Sean Ahn'), mem('b', 'Ben Carter')], viewpoint: { lastMessageReadDateTime: READ }, lastMessagePreview: msg('p-' + id, 'b', '2026-11-17T09:00:00Z') }, o); }

const JWT = (payload) => ['{"alg":"none"}', JSON.stringify(payload), 's'].map((x, i) => (i < 2 ? Buffer.from(x).toString('base64url') : x)).join('.');
const MY_TOKEN = JWT({ appid: 'cid', oid: 'me', tid: 'tid', upn: 'sean@example.com', name: 'Sean Ahn' });
/** Microsoft's sign-in endpoints: a device code, then tokens (or what world.loginAnswers says, in order). */
function login(world, url, init, calls) {
  const body = new URLSearchParams(String(init.body));
  calls.push({ method: 'POST', path: 'login:' + url.split('/').pop(), body: init.body, scope: body.get('scope') });
  const ok = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/devicecode')) return ok({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
  const a = (world.loginAnswers || []).shift();
  if (a) return ok(a.body, a.status || 400);
  return ok({ access_token: MY_TOKEN, refresh_token: 'r', expires_in: 3600, scope: body.get('scope') || '' });
}

/** A fake Graph: routes by path; `world` is changed by the tests. Records every request. */
function graph(world) {
  const calls = [];
  const fetch = async (url, init) => {
    if (String(url).startsWith('https://login.microsoftonline.com/')) return login(world, url, init, calls);
    const u = new URL(url); const p = decodeURIComponent(u.pathname.replace('/v1.0', '')) + u.search;
    calls.push({ method: init.method, path: p, body: init.body });
    const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (world.fail) { const r = await world.fail(p, init); if (r) return r; }
    if (p === '/me') return ok(ME);
    if (p.startsWith('/me/chats')) return ok({ value: world.chats });
    let m = /^\/chats\/([^/]+)\/messages\?\$top=(\d+)/.exec(p);
    if (m) return ok({ value: (world.messages[m[1]] || []).slice(0, Number(m[2])) });
    if (/markChatReadForUser$/.test(p)) { world.marked.push(p.split('/')[2]); return new Response(null, { status: 204 }); }
    m = /^\/chats\/([^/]+)\/messages$/.exec(p);
    if (m && init.method === 'POST') { const body = JSON.parse(init.body).body.content; const sent = msg('s' + calls.length, 'me', new Date().toISOString(), body); (world.messages[m[1]] = world.messages[m[1]] || []).unshift(sent); return ok(sent); }
    if (p === '/me/joinedTeams') return ok({ value: world.teams || [] });
    if (p === '/search/query') return ok({ value: [{ hitsContainers: [{ hits: world.search || [] }] }] });
    m = /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/?]+)$/.exec(p);
    if (m) return ok(((world.posts || {})[m[2]] || []).find((x) => x.id === m[3]) || {});
    m = /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages(?:\/([^/]+)\/replies)?$/.exec(p);
    if (m && init.method === 'POST') {
      const sent = msg('s' + calls.length, 'me', new Date().toISOString(), JSON.parse(init.body).body.content, m[3] ? { replyToId: m[3] } : { replies: [] });
      const posts = world.posts[m[2]];
      if (m[3]) posts.find((x) => x.id === m[3]).replies.unshift(sent); else posts.unshift(sent);
      return ok(sent);
    }
    m = /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages\?\$top=(\d+)&\$expand=replies$/.exec(p);
    if (m) return ok({ value: ((world.posts || {})[m[2]] || []).slice(0, Number(m[3])) });
    m = /^\/teams\/([^/]+)\/channels$/.exec(p);
    if (m) return ok({ value: (world.channels || {})[m[1]] || [] });
    return new Response('{}', { status: 404 });
  };
  fetch.calls = calls;
  return fetch;
}

function start(world, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-host-'));
  const tokenFile = path.join(dir, 'token.json');
  if (!o.noToken) fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a', refresh_token: 'r', client_id: 'c', tenant_id: 'tid', expires_at: Date.now() / 1000 + 3600 }));
  world.marked = world.marked || []; world.messages = world.messages || {};
  const fetch = graph(world);
  const watched = [];
  const context = { extensionUri: { fsPath: path.join(__dirname, '..') }, globalState: o.memento || memento(), subscriptions: [] };
  // the 0.1.x tests run under the token-file method; o.method picks another, with no token file configured
  ui.config['chirp.signIn.method'] = o.method || 'auto';
  ui.config['chirp.signIn.tokenFile'] = o.method && o.method !== 'tokenFile' ? '' : tokenFile;
  ui.config['chirp.agentFiles'] = true;
  const sec = o.secrets || secrets();
  const api = ext.activate(context, { fetch, chirpDir: path.join(dir, '.chirp'), watchFile: (f, opts, fn) => watched.push(fn), unwatchFile: () => {}, secrets: sec, sleep: async () => {}, clientId: 'cid' });
  const h = { api, fetch, dir, context, watched, world, secrets: sec };
  running.push(h);
  return h;
}
const running = [];
// a failed assertion must not leave pollers or tabs behind
test.afterEach(() => { for (const p of ui.panels) p.dispose(); for (const h of running.splice(0)) h.api.dispose(); });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const lastState = (view) => view.webview.posted.filter((m) => m.type === 'state').at(-1);

test('badge counts unread chats plus flagged', async () => {
  ui.focused = true;
  const world = { chats: [
    chat('a', { lastMessagePreview: msg('pa', 'b', '2026-11-17T11:00:00Z') }),
    chat('b', { lastMessagePreview: msg('pb', 'b', '2026-11-17T12:00:00Z') }),
    chat('c'),
  ], messages: {
    a: [msg('pa', 'b', '2026-11-17T11:00:00Z', 'hi Sean', { mentions: [{ mentioned: { user: { id: 'me' } } }] }), msg('a0', 'b', '2026-11-17T09:00:00Z')],
    b: [msg('pb', 'b', '2026-11-17T12:00:00Z'), msg('b1', 'b', '2026-11-17T11:30:00Z')],
  } };
  const h = start(world);
  const view = ui.resolveSidebar();
  await settle();
  const s = lastState(view);
  assert.deepStrictEqual(s.chats.map((r) => [r.id, r.unread, r.unreadCount, r.mention]), [['a', true, 1, true], ['b', true, null, false], ['c', false, null, false]]);
  assert.deepStrictEqual(view.badge, { value: 1, tooltip: 'Mentions you: Chat a' }, 'only the unread chat that mentions Sean counts; plain unread chats do not');
  assert.strictEqual(h.fetch.calls.filter((c) => c.path.startsWith('/chats/c/')).length, 0, 'read chats are not fetched');
  await h.api.refresh();
  assert.strictEqual(h.fetch.calls.filter((c) => c.path.startsWith('/chats/a/messages')).length, 1, 'unchanged chats are not fetched again');
  h.api.dispose();
});

test('a mention flag clears when the chat is read elsewhere', async () => {
  const world = { chats: [chat('a', { lastMessagePreview: msg('pa', 'b', '2026-11-17T11:00:00Z') })], messages: { a: [msg('pa', 'b', '2026-11-17T11:00:00Z', 'x', { mentions: [{ mentioned: { user: { id: 'me' } } }] })] } };
  const h = start(world);
  const view = ui.resolveSidebar();
  await settle();
  assert.strictEqual(lastState(view).chats[0].mention, true);
  world.chats = [chat('a', { lastMessagePreview: msg('pa', 'b', '2026-11-17T11:00:00Z'), viewpoint: { lastMessageReadDateTime: '2026-11-17T11:05:00Z' } })];
  await h.api.refresh();
  assert.strictEqual(lastState(view).chats[0].mention, false);
  assert.deepStrictEqual(view.badge, { value: 0, tooltip: '' }, 'cleared with a 0, which VS Code hides; undefined may leave the old badge up');
  h.api.dispose();
});

test('sign-in needed stops polling and shows the message', async () => {
  const world = { chats: [] };
  const h = start(world, { noToken: true });
  const view = ui.resolveSidebar();
  await settle();
  assert.deepStrictEqual(lastState(view).status, { kind: 'signin', text: `Sign in with the tool that keeps ${path.join(h.dir, 'token.json')}` });
  assert.strictEqual(h.fetch.calls.length, 0);
  assert.strictEqual(h.watched.length, 1, 'watches the token file');
  fs.writeFileSync(path.join(h.dir, 'token.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', client_id: 'c', tenant_id: 'tid', expires_at: Date.now() / 1000 + 3600 }));
  h.watched[0]();
  await settle();
  assert.strictEqual(lastState(view).status, null);
  assert.ok(h.fetch.calls.some((c) => c.path.startsWith('/me/chats')), 'polling resumed');
  h.api.dispose();
});

test('offline shows a note and keeps going', async () => {
  const world = { chats: [], fail: () => { throw new TypeError('fetch failed'); } };
  const h = start(world);
  const view = ui.resolveSidebar();
  await settle();
  assert.deepStrictEqual(lastState(view).status, { kind: 'offline', text: 'Offline, retrying' });
  delete world.fail;
  await h.api.refresh();
  assert.strictEqual(lastState(view).status, null);
  h.api.dispose();
});

// ---- chat tabs (Task 9)
const PLAT = '19:7e2a91f04b6d4e8fa1b5d9e0f6a2b4d8@thread.v2';
function chatWorld() {
  return { chats: [chat(PLAT, { topic: 'Design Team Chat', lastMessagePreview: msg('m2', 'b', '2026-11-17T11:00:00Z') })], messages: { [PLAT]: [msg('m2', 'b', '2026-11-17T11:00:00Z', 'newer'), msg('m1', 'me', '2026-11-17T09:00:00Z', 'older')] } };
}
async function openTab(h, id) {
  ui.view.webview._receive({ type: 'open', ref: { kind: 'chat', id } });
  const panel = ui.panels.at(-1);
  panel.webview._receive({ type: 'ready' });
  await settle();
  return panel;
}

test('open twice focuses one tab', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  ui.view.webview._receive({ type: 'open', ref: { kind: 'chat', id: PLAT } });
  assert.strictEqual(ui.panels.length, 1);
  assert.strictEqual(panel.revealed, 1);
  assert.strictEqual(panel.viewType, 'chirp.conversation');
  assert.strictEqual(panel.title, 'Design Team Chat');
  const init = panel.webview.posted.find((x) => x.type === 'init');
  assert.deepStrictEqual(init.ref, { kind: 'chat', id: PLAT, name: 'Design Team Chat' }, 'the name rides along, for a title after reload');
  const msgs = panel.webview.posted.find((x) => x.type === 'messages');
  assert.deepStrictEqual(msgs.messages.map((x) => [x.id, x.mine, x.from]), [['m1', true, 'Sean Ahn'], ['m2', false, 'Ben Carter']]);
  panel.dispose(); h.api.dispose();
});

test('opening writes the mirror and current.teams', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  await openTab(h, PLAT);
  const file = path.join(h.dir, '.chirp', 'chats', `Design Team Chat ${shortId(PLAT)}.teams`);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('# Teams chat: Design Team Chat\n# chat id: ' + PLAT));
  assert.ok(text.indexOf('older') < text.indexOf('newer'));
  assert.strictEqual(fs.readFileSync(path.join(h.dir, '.chirp', 'current.teams'), 'utf8'), text);
  assert.strictEqual(await ui.commands['chirp.activeConversationFile'](), file);
  ui.panels.at(-1).dispose(); h.api.dispose();
});

test('opening clears the chat mention', async () => {
  ui.focused = true; ui.panels.length = 0;
  const world = chatWorld(); world.messages[PLAT][0].mentions = [{ mentioned: { user: { id: 'me' } } }];
  const h = start(world); ui.resolveSidebar(); await settle();
  assert.strictEqual(lastState(ui.view).chats[0].mention, true);
  await openTab(h, PLAT);
  assert.strictEqual(lastState(ui.view).chats[0].mention, false);
  ui.panels.at(-1).dispose(); h.api.dispose();
});

test('no read mark when unfocused or hidden', async () => {
  ui.focused = false; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  assert.deepStrictEqual(h.world.marked, [], 'window not focused');
  panel._setView(false, false);
  ui.setFocus(true); await settle();
  assert.deepStrictEqual(h.world.marked, [], 'focused, but the tab is hidden');
  panel._setView(true, true); await settle();
  assert.deepStrictEqual(h.world.marked, [PLAT], 'visible and focused');
  assert.strictEqual(lastState(ui.view).chats[0].unread, false, 'the sidebar un-bolds at once');
  panel.dispose(); h.api.dispose();
});

test('read mark when visible and focused, once per new message batch', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  assert.deepStrictEqual(h.world.marked, [PLAT]);
  const conv = h.api.conversations;
  await conv.poll('chat:' + PLAT);
  assert.deepStrictEqual(h.world.marked, [PLAT], 'nothing new, no second mark');
  h.world.messages[PLAT].unshift(msg('m3', 'b', '2026-11-17T12:00:00Z', 'newest'));
  await conv.poll('chat:' + PLAT);
  assert.deepStrictEqual(h.world.marked, [PLAT, PLAT]);
  const appended = panel.webview.posted.filter((x) => x.type === 'messages').at(-1);
  assert.deepStrictEqual(appended.messages.map((x) => x.id), ['m3']);
  assert.ok(fs.readFileSync(path.join(h.dir, '.chirp', 'current.teams'), 'utf8').includes('newest'), 'the files follow');
  h.world.messages[PLAT].unshift(msg('m4', 'me', '2026-11-17T12:05:00Z', 'mine'));
  await conv.poll('chat:' + PLAT);
  assert.deepStrictEqual(h.world.marked, [PLAT, PLAT], 'own message: nothing to mark');
  panel.dispose(); h.api.dispose();
});

test('activeConversationFile is null after the tab closes and while hidden', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  assert.ok(await ui.commands['chirp.activeConversationFile']());
  panel._setView(false, false);
  assert.strictEqual(await ui.commands['chirp.activeConversationFile'](), null);
  panel._setView(true, false);
  assert.ok(await ui.commands['chirp.activeConversationFile'](), 'visible beside a perch tab still counts');
  panel.dispose();
  assert.strictEqual(await ui.commands['chirp.activeConversationFile'](), null);
  h.api.dispose();
});

test('a link opens only if https', async () => {
  ui.focused = true; ui.panels.length = 0; ui.opened.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  panel.webview._receive({ type: 'link', url: 'https://example.com/a' });
  panel.webview._receive({ type: 'link', url: 'file:///etc/passwd' });
  panel.webview._receive({ type: 'link', url: 'command:workbench.action.quit' });
  assert.deepStrictEqual(ui.opened, ['https://example.com/a']);
  panel.dispose(); h.api.dispose();
});

test('a tab restored after reload loads its chat', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = ui.window ? null : require('vscode').window.createWebviewPanel('chirp.conversation', 'old', 1, {});
  await ui.serializer.deserializeWebviewPanel(panel, { ref: { kind: 'chat', id: PLAT } });
  panel.webview._receive({ type: 'ready' }); await settle();
  assert.ok(panel.webview.posted.some((x) => x.type === 'messages'));
  panel.dispose(); h.api.dispose();
});

test('a closed tab does not poll again after sign-in comes back', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const base = h.api.pollers.length;
  const panel = await openTab(h, PLAT);
  assert.strictEqual(h.api.pollers.length, base + 1, 'the tab has a poller');
  panel.dispose();
  assert.strictEqual(h.api.pollers.length, base, 'the tab\'s poller is gone with it');
  fs.unlinkSync(path.join(h.dir, 'token.json'));
  await h.api.refresh();
  fs.writeFileSync(path.join(h.dir, 'token.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', client_id: 'c', tenant_id: 'tid', expires_at: Date.now() / 1000 + 3600 }));
  const before = h.fetch.calls.length;
  h.watched.at(-1)(); await settle();
  const after = h.fetch.calls.slice(before).map((c) => c.path);
  assert.ok(after.some((p) => p.startsWith('/me/chats')));
  assert.ok(!after.some((p) => p.startsWith('/chats/')), 'no poll for the closed tab: ' + after.join(' '));
});

// ---- sending from chat tabs (Task 10)
test('sent message is not duplicated by the next poll', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  assert.strictEqual(panel.webview.posted.find((x) => x.type === 'init').canSend, true);
  panel.webview._receive({ type: 'send', text: 'hello & bye', pendingId: 'p1' }); await settle();
  const post = h.fetch.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages'));
  assert.deepStrictEqual(JSON.parse(post.body), { body: { contentType: 'html', content: 'hello &amp; bye' } });
  const sent = panel.webview.posted.find((x) => x.type === 'sent');
  assert.strictEqual(sent.pendingId, 'p1');
  assert.strictEqual(sent.message.mine, true);
  const before = panel.webview.posted.length;
  await h.api.conversations.poll('chat:' + PLAT);
  assert.ok(!panel.webview.posted.slice(before).some((x) => x.type === 'messages' && x.messages.some((y) => y.id === sent.message.id)));
  assert.ok(fs.readFileSync(path.join(h.dir, '.chirp', 'current.teams'), 'utf8').includes('hello & bye'), 'the file has it');
});

test('a refused send reports failure', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  h.world.fail = (p, init) => (init.method === 'POST' && p.endsWith('/messages') ? new Response(JSON.stringify({ error: { code: 'BadRequest', message: 'nope' } }), { status: 400 }) : undefined);
  panel.webview._receive({ type: 'send', text: 'x', pendingId: 'p2' }); await settle();
  const failed = panel.webview.posted.find((x) => x.type === 'failed');
  assert.deepStrictEqual([failed.pendingId, failed.retryable], ['p2', true]);
});

// ---- channels (Task 11)
const TEAM = 'T1', CHAN = '19:Xq7TfGkL2mPz9RbW4nVhJ8sYd5KwA6uE1oNiBtF2xy0@thread.tacv2';
function channelWorld() {
  const w = chatWorld();
  w.teams = [{ id: TEAM, displayName: 'Product Team' }];
  w.channels = { [TEAM]: [{ id: CHAN, displayName: 'chirp-test' }] };
  w.posts = { [CHAN]: [msg('p2', 'b', '2026-11-18T10:00:00Z', 'second', { replies: [] }), msg('p1', 'b', '2026-11-18T09:00:00Z', 'first', { subject: 'Hello', replies: [msg('r2', 'me', '2026-11-18T09:10:00Z', 'reply two'), msg('r1', 'b', '2026-11-18T09:05:00Z', 'reply one')] })] };
  return w;
}

test('channel tab title and mirror path', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(channelWorld()); const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual(lastState(view).teams, [{ id: TEAM, name: 'Product Team', channels: [{ id: CHAN, name: 'chirp-test', mention: false }] }]);
  view.webview._receive({ type: 'open', ref: { kind: 'channel', teamId: TEAM, id: CHAN } });
  const panel = ui.panels.at(-1);
  panel.webview._receive({ type: 'ready' }); await settle();
  assert.strictEqual(panel.title, 'Product Team › chirp-test');
  const init = panel.webview.posted.find((x) => x.type === 'init');
  assert.deepStrictEqual([init.kind, init.ref.teamId, init.ref.id], ['channel', TEAM, CHAN]);
  const msgs = panel.webview.posted.find((x) => x.type === 'messages');
  assert.deepStrictEqual(msgs.messages.map((x) => [x.id, x.replies.map((r) => r.id)]), [['p1', ['r1', 'r2']], ['p2', []]]);
  const file = path.join(h.dir, '.chirp', 'channels', `Product Team › chirp-test ${shortId(CHAN)}.teams`);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('# Teams channel: Product Team › chirp-test\n# team id: T1\n'));
  assert.ok(/  first\n    \[[^\]]+\] Ben Carter \(id r1\):\n      reply one/.test(text));
  assert.strictEqual(await ui.commands['chirp.activeConversationFile'](), file);
  assert.deepStrictEqual(h.world.marked, [], 'channels are never marked read');
  h.world.posts[CHAN][1].replies.unshift(msg('r3', 'b', '2026-11-18T09:20:00Z', 'reply three'));
  await h.api.conversations.poll('channel:' + TEAM + '/' + CHAN);
  const upd = panel.webview.posted.filter((x) => x.type === 'messages').at(-1);
  assert.deepStrictEqual(upd.messages.map((x) => [x.id, x.replies.length]), [['p1', 3]], 'a post with a new reply is sent again');
});

// ---- posting in channels (Task 12)
async function openChannel(h) {
  ui.view.webview._receive({ type: 'open', ref: { kind: 'channel', teamId: TEAM, id: CHAN } });
  const panel = ui.panels.at(-1);
  panel.webview._receive({ type: 'ready' }); await settle();
  return panel;
}
test('new post and reply targets', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(channelWorld()); ui.resolveSidebar(); await settle();
  const panel = await openChannel(h);
  assert.strictEqual(panel.webview.posted.find((x) => x.type === 'init').canSend, true);
  panel.webview._receive({ type: 'send', text: 'a post', pendingId: 'p1' }); await settle();
  panel.webview._receive({ type: 'send', text: 'a reply', pendingId: 'p2', target: { postId: 'p1' } }); await settle();
  const posts = h.fetch.calls.filter((c) => c.method === 'POST' && c.path !== '/search/query').map((c) => c.path);
  assert.deepStrictEqual(posts, [`/teams/${TEAM}/channels/${CHAN}/messages`, `/teams/${TEAM}/channels/${CHAN}/messages/p1/replies`]);
  assert.deepStrictEqual(panel.webview.posted.filter((x) => x.type === 'sent').map((x) => x.pendingId), ['p1', 'p2']);
  const text = fs.readFileSync(path.join(h.dir, '.chirp', 'current.teams'), 'utf8');
  assert.ok(/first\n[\s\S]*    \[[^\]]+\] Sean Ahn \(id [^)]+\):\n      a reply/.test(text), 'the reply is filed under its post');
  assert.ok(text.includes('a post'));
});

test('a 403 makes the channel tab read-only', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(channelWorld()); ui.resolveSidebar(); await settle();
  const panel = await openChannel(h);
  h.world.fail = (p, init) => (init.method === 'POST' ? new Response(JSON.stringify({ error: { code: 'Forbidden', message: 'no' } }), { status: 403 }) : undefined);
  panel.webview._receive({ type: 'send', text: 'x', pendingId: 'p1' }); await settle();
  assert.strictEqual(panel.webview.posted.find((x) => x.type === 'failed').forbidden, true);
  delete h.world.fail;
  const before = h.fetch.calls.length;
  panel.webview._receive({ type: 'send', text: 'y', pendingId: 'p2' }); await settle();
  assert.ok(!h.fetch.calls.slice(before).some((c) => c.method === 'POST' && c.path !== '/search/query'), 'no more posts from a read-only tab');
});

// ---- channel mentions (Task 13)
test('a channel mention shows in the sidebar and clears when opened', async () => {
  ui.focused = true; ui.panels.length = 0;
  const w = channelWorld();
  w.search = [{ resource: { id: 'p1', createdDateTime: new Date(Date.now() + 60000).toISOString(), channelIdentity: { teamId: TEAM, channelId: CHAN } } }];
  w.posts[CHAN][1].mentions = [{ mentioned: { user: { id: 'me' } } }];
  const h = start(w); const view = ui.resolveSidebar(); await settle(60);
  assert.strictEqual(lastState(view).teams[0].channels[0].mention, true);
  assert.deepStrictEqual(view.badge, { value: 1, tooltip: 'Mentions you: Product Team › chirp-test' }, 'the channel mention; the unread chat does not mention Sean');
  await openChannel(h);
  assert.strictEqual(lastState(view).teams[0].channels[0].mention, false);
});

// ---- deletions (found live: a message deleted in Teams stayed in the tab)
test('a message deleted in Teams leaves the tab and the file', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  const m2 = h.world.messages[PLAT][0];
  h.world.messages[PLAT][0] = Object.assign({}, m2, { deletedDateTime: '2026-11-17T11:30:00Z', body: { content: '' } });
  await h.api.conversations.poll('chat:' + PLAT);
  const removed = panel.webview.posted.filter((x) => x.type === 'removed');
  assert.deepStrictEqual(removed.map((x) => x.ids), [['m2']]);
  assert.ok(!fs.readFileSync(path.join(h.dir, '.chirp', 'current.teams'), 'utf8').includes('newer'), 'gone from the file too');
  await h.api.conversations.poll('chat:' + PLAT);
  assert.strictEqual(panel.webview.posted.filter((x) => x.type === 'removed').length, 1, 'removed once');
});

test('a deleted channel post leaves the tab', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(channelWorld()); ui.resolveSidebar(); await settle();
  const panel = await openChannel(h);
  const posts = h.world.posts[CHAN];
  posts[0] = Object.assign({}, posts[0], { deletedDateTime: '2026-11-18T11:00:00Z' });
  await h.api.conversations.poll('channel:' + TEAM + '/' + CHAN);
  assert.deepStrictEqual(panel.webview.posted.filter((x) => x.type === 'removed').map((x) => x.ids), [['p2']]);
});


// ---- speed after a reload (found live: the chat list took long to appear)
test('chat rows show before the mention checks finish', async () => {
  ui.focused = true;
  let release; const gate = new Promise((r) => { release = r; });
  const world = { chats: [chat('a', { lastMessagePreview: msg('pa', 'b', '2026-11-17T11:00:00Z') })], messages: { a: [msg('pa', 'b', '2026-11-17T11:00:00Z')] } };
  const h = start(world);
  world.fail = (p) => (p.startsWith('/chats/a/messages') ? gate.then(() => undefined) : undefined);
  const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual((lastState(view).chats || []).map((r) => r.id), ['a'], 'listed while its messages are still loading');
  delete world.fail; release(); await settle();
});

test('the last lists show at once after a reload', async () => {
  ui.focused = true;
  const saved = memento();
  const w = channelWorld();
  const h1 = start(w, { memento: saved }); ui.resolveSidebar(); await settle(60);
  h1.api.dispose();
  const hang = Object.assign(channelWorld(), { fail: () => new Promise(() => {}) });
  start(hang, { memento: saved });
  const view = ui.resolveSidebar(); await settle();
  const st = lastState(view);
  assert.deepStrictEqual(st.chats.map((r) => r.name), ['Design Team Chat'], 'chats from the cache, though Graph has not answered');
  assert.deepStrictEqual(st.teams.map((t) => t.name), ['Product Team']);
  assert.ok(view.webview.html.length > 0);
});

test('Retry after an unknown outcome does not post twice', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  let posts = 0, listFails = true;
  h.world.fail = (p, init) => {
    if (init.method === 'POST' && p.endsWith('/messages')) { posts++; h.world.messages[PLAT].unshift(msg('posted', 'me', new Date().toISOString(), 'hello')); return new Response('{}', { status: 500 }); }
    if (listFails && p.startsWith(`/chats/${PLAT}/messages?`)) return new Response('{}', { status: 500 });
    return undefined;
  };
  panel.webview._receive({ type: 'send', text: 'hello', pendingId: 'p1' }); await settle();
  assert.strictEqual(panel.webview.posted.filter((x) => x.type === 'failed').length, 1, 'outcome unknown, the check failed too: Retry is offered');
  listFails = false;
  panel.webview._receive({ type: 'send', text: 'hello', pendingId: 'p1' }); await settle();
  assert.strictEqual(posts, 1, 'the Retry found the first attempt and did not post again');
  assert.strictEqual(panel.webview.posted.find((x) => x.type === 'sent').message.id, 'posted');
});

test('opening an already open channel clears its new mention', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(channelWorld()); const view = ui.resolveSidebar(); await settle();
  await openChannel(h);
  h.api.mentions.flag(`channel:${TEAM}/${CHAN}`, 'mm'); h.api.sidebar.update({ teams: h.api.teamRows() });
  assert.strictEqual(lastState(view).teams[0].channels[0].mention, true);
  view.webview._receive({ type: 'open', ref: { kind: 'channel', teamId: TEAM, id: CHAN } });
  assert.strictEqual(lastState(view).teams[0].channels[0].mention, false);
});

test('a tab whose first load fails says so and loads later', async () => {
  ui.focused = true; ui.panels.length = 0;
  const w = chatWorld();
  const h = start(w); ui.resolveSidebar(); await settle();
  w.fail = (p) => (p.startsWith(`/chats/${PLAT}/messages`) ? new Response('{}', { status: 500 }) : undefined);
  const panel = await openTab(h, PLAT);
  const err = panel.webview.posted.find((x) => x.type === 'error');
  assert.ok(err && /couldn't load/i.test(err.text), 'the tab says it could not load');
  delete w.fail;
  await h.api.conversations.poll('chat:' + PLAT);
  assert.ok(panel.webview.posted.some((x) => x.type === 'messages'), 'the next poll loads it');
});

test('sign-in comes back even if the token file does not change again', async () => {
  ui.focused = true;
  const ticks = [];
  const world = { chats: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-host-'));
  const tokenFile = path.join(dir, 'token.json');
  world.marked = []; world.messages = {};
  const fetch = graph(world);
  const context = { extensionUri: { fsPath: path.join(__dirname, '..') }, globalState: memento(), subscriptions: [] };
  ui.config['chirp.signIn.method'] = 'auto'; ui.config['chirp.signIn.tokenFile'] = tokenFile;
  const api = ext.activate(context, { fetch, chirpDir: path.join(dir, '.chirp'), watchFile: () => {}, unwatchFile: () => {}, setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => {}, secrets: secrets(), sleep: async () => {}, clientId: 'cid' });
  running.push({ api });
  const view = ui.resolveSidebar(); await settle();
  assert.strictEqual(lastState(view).status.kind, 'signin');
  fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a', refresh_token: 'r', client_id: 'c', tenant_id: 'tid', expires_at: Date.now() / 1000 + 3600 }));
  await ticks[0](); await settle();
  assert.strictEqual(lastState(view).status, null, 'the periodic check found a good login');
  assert.ok(fetch.calls.some((c) => c.path.startsWith('/me/chats')));
});

test('Refresh while signed out recovers', async () => {
  ui.focused = true;
  const h = start({ chats: [] }, { noToken: true }); const view = ui.resolveSidebar(); await settle();
  assert.strictEqual(lastState(view).status.kind, 'signin');
  fs.writeFileSync(path.join(h.dir, 'token.json'), JSON.stringify({ access_token: 'a', refresh_token: 'r', client_id: 'c', tenant_id: 'tid', expires_at: Date.now() / 1000 + 3600 }));
  await h.api.refresh(); await settle();
  assert.strictEqual(lastState(view).status, null);
  assert.strictEqual(h.api.state.signedOut, false, 'signed back in: the pollers run again');
});

test('conversation tabs carry the Teams icon', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  assert.ok(panel.iconPath && /media[\\/]teams-tab\.svg$/.test(panel.iconPath.fsPath), 'a chat tab');
  const restored = require('vscode').window.createWebviewPanel('chirp.conversation', 'old', 1, {});
  await ui.serializer.deserializeWebviewPanel(restored, { ref: { kind: 'chat', id: PLAT } });
  assert.ok(restored.iconPath && /teams-tab\.svg$/.test(restored.iconPath.fsPath), 'a tab restored after a reload');
  assert.ok(fs.existsSync(panel.iconPath.fsPath), 'the image exists');
});

// ---- @mentions from chirp's message box
test('a chat tab offers its other members, and sends real mentions', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  assert.deepStrictEqual(panel.webview.posted.find((x) => x.type === 'init').people, [{ id: 'b', name: 'Ben Carter' }], 'members other than Sean');
  panel.webview._receive({ type: 'send', text: 'ping @Ben Carter', pendingId: 'p1', mentions: [{ name: 'Ben Carter', userId: 'b' }] }); await settle();
  const post = h.fetch.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages'));
  const body = JSON.parse(post.body);
  assert.strictEqual(body.body.content, 'ping <at id="0">Ben Carter</at>');
  assert.strictEqual(body.mentions[0].mentioned.user.id, 'b');
});

test('someone added to the chat shows up in the open tab: title, header and @ list', async () => {
  ui.focused = true; ui.panels.length = 0;
  const w = chatWorld(); w.chats[0].topic = null;
  const h = start(w); ui.resolveSidebar(); await settle();
  const panel = await openTab(h, PLAT);
  assert.deepStrictEqual(panel.webview.posted.find((x) => x.type === 'init').people.map((p) => p.name), ['Ben Carter']);
  w.chats[0].members.push(mem('n', 'Mia Torres'));
  await h.api.refresh();
  await h.api.conversations.poll('chat:' + PLAT);
  const upd = panel.webview.posted.filter((x) => x.type === 'header').at(-1);
  assert.ok(upd, 'the tab is told');
  assert.deepStrictEqual(upd.people.map((p) => p.name), ['Ben Carter', 'Mia Torres']);
  assert.strictEqual(upd.title, 'Ben, Mia');
  assert.strictEqual(panel.title, 'Ben, Mia');
  const n = panel.webview.posted.filter((x) => x.type === 'header').length;
  await h.api.conversations.poll('chat:' + PLAT);
  assert.strictEqual(panel.webview.posted.filter((x) => x.type === 'header').length, n, 'nothing new, nothing sent');
});


// ---- chirp's own sign-in (sign-in plan, Task 5)
const graphCalls = (h) => h.fetch.calls.filter((c) => !c.path.startsWith('login:'));
const signInState = (view) => lastState(view).signIn;

test('signed out at first: the sidebar asks to sign in, no Graph calls', async () => {
  ui.focused = true; ui.session = () => undefined;
  const h = start(chatWorld(), { method: 'auto' }); const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' });
  assert.deepStrictEqual(graphCalls(h), []);
  assert.strictEqual(lastState(view).account, null);
});

test('sign in with device code shows the code, then the chats', async () => {
  ui.focused = true;
  const h = start(chatWorld(), { method: 'deviceCode' }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  const states = view.webview.posted.filter((x) => x.type === 'state');
  assert.ok(states.some((x) => x.signIn && x.signIn.stage === 'code' && x.signIn.userCode === 'ABCD-1234' && x.signIn.verificationUri === 'https://microsoft.com/devicelogin'), 'the code was shown');
  assert.ok(ui.infos.some((m) => m.includes('ABCD-1234')), 'and in a notification');
  assert.strictEqual(signInState(view), null);
  assert.deepStrictEqual(lastState(view).account, { username: 'sean@example.com', method: 'deviceCode' });
  assert.deepStrictEqual(lastState(view).chats.map((r) => r.id), [PLAT]);
});

test('signing in through the editor uses chirp\'s app', async () => {
  ui.focused = true; ui.sessions.length = 0;
  ui.session = (scopes, options) => (options && options.silent && !ui.signedInViaEditor ? undefined : (ui.signedInViaEditor = true, { accessToken: MY_TOKEN, account: { label: 'sean' } }));
  ui.signedInViaEditor = false;
  const h = start(chatWorld(), { method: 'auto' }); const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' });
  await ui.commands['chirp.signIn'](); await settle();
  assert.deepStrictEqual(lastState(view).account, { username: 'sean@example.com', method: 'editor' });
  assert.ok(ui.sessions.some((c) => c.scopes[0] === 'VSCODE_CLIENT_ID:cid' && c.options.createIfNone));
  assert.deepStrictEqual(lastState(view).chats.map((r) => r.id), [PLAT]);
  ui.session = () => undefined;
});

test('channels wait for Enable channels', async () => {
  ui.focused = true;
  const w = channelWorld();
  const h = start(w, { method: 'deviceCode' }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  assert.strictEqual(lastState(view).channels, 'off');
  assert.ok(!h.fetch.calls.some((c) => c.path === '/me/joinedTeams'), 'no teams before channels are enabled');
  await ui.commands['chirp.enableChannels'](); await settle();
  assert.ok(h.fetch.calls.some((c) => c.path === 'login:devicecode' && /ChannelMessage\.Read\.All/.test(c.scope)), 'asked for the channel permissions');
  assert.strictEqual(lastState(view).channels, 'enabled');
  assert.ok(h.fetch.calls.some((c) => c.path === '/me/joinedTeams'));
  assert.strictEqual(h.context.globalState.get('chirp.channelsWanted'), true, 'remembered for the next sign-in');
});

test('enable channels failing keeps chats and offers the admin link', async () => {
  ui.focused = true;
  const w = channelWorld();
  const h = start(w, { method: 'deviceCode' }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  w.loginAnswers = [{ status: 400, body: { error: 'expired_token' } }];
  await ui.commands['chirp.enableChannels'](); await settle();
  assert.strictEqual(lastState(view).channels, 'failed');
  assert.deepStrictEqual(lastState(view).chats.map((r) => r.id), [PLAT], 'chats still there');
  await ui.commands['chirp.copyAdminLink']();
  assert.deepStrictEqual(ui.copied.at(-1), 'https://login.microsoftonline.com/organizations/adminconsent?client_id=cid');
});

test('sign out clears lists, mentions and tabs', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld(), { method: 'deviceCode' }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  const panel = await openTab(h, PLAT);
  h.api.mentions.flag('chat:x', 'm');
  await ui.commands['chirp.signOut'](); await settle();
  assert.strictEqual(h.context.globalState.get('chirp.lists'), undefined);
  assert.deepStrictEqual(h.api.mentions.flagged(), []);
  assert.strictEqual(panel.disposed, true, 'tabs closed');
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' });
  assert.deepStrictEqual(lastState(view).chats, []);
  assert.strictEqual(lastState(view).account, null);
  assert.strictEqual(h.secrets.m.size, 0, 'device-code tokens deleted');
  const n = graphCalls(h).length; await settle(40);
  assert.strictEqual(graphCalls(h).length, n, 'polling stopped');
});

test('a different account clears the old one\'s data first', async () => {
  ui.focused = true;
  const mem = memento();
  await mem.update('chirp.lists', { me: { id: 'someone-else', displayName: 'X' }, chats: [chat('zzz')], teams: [] });
  await mem.update('chirp.mentions', { flagged: { 'chat:zzz': 'm1' }, seen: [], baseline: 1 });
  const h = start(chatWorld(), { method: 'deviceCode', memento: mem }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  assert.ok(!lastState(view).chats.some((r) => r.id === 'zzz'));
  assert.deepStrictEqual(h.api.mentions.flagged(), [], 'the other account\'s mentions are gone');
});

test('changing the method signs in again with the new one', async () => {
  ui.focused = true;
  const h = start(chatWorld()); const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual(lastState(view).chats.map((r) => r.id), [PLAT], 'signed in by the token file');
  ui.setConfig('chirp.signIn.tokenFile', '');
  ui.setConfig('chirp.signIn.method', 'deviceCode'); await settle();
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' }, 'the new method has no session yet');
  const n = graphCalls(h).length; await settle(40);
  assert.strictEqual(graphCalls(h).length, n, 'the old method no longer polls');
});

test('token file without channel permission shows the reason', async () => {
  ui.focused = true;
  const w = channelWorld();
  w.fail = (p) => (p === '/me/joinedTeams' ? new Response(JSON.stringify({ error: { code: 'Forbidden' } }), { status: 403 }) : undefined);
  const h = start(w); const view = ui.resolveSidebar(); await settle();
  assert.strictEqual(lastState(view).channels, 'forbidden');
  assert.deepStrictEqual(lastState(view).chats.map((r) => r.id), [PLAT]);
});

test('the sidebar\'s buttons run the sign-in commands', async () => {
  ui.focused = true;
  start(chatWorld(), { method: 'deviceCode' }); const view = ui.resolveSidebar(); await settle();
  ui.executed.length = 0;
  for (const type of ['signIn', 'cancelSignIn', 'copyCode', 'enableChannels', 'copyAdminLink']) view.webview._receive({ type });
  await settle();
  assert.deepStrictEqual(ui.executed.map((x) => x[0]), ['chirp.signIn', 'chirp.cancelSignIn', 'chirp.copyCode', 'chirp.enableChannels', 'chirp.copyAdminLink']);
});

test('turning agent files off stops writing at once', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  await openTab(h, PLAT);
  const file = path.join(h.dir, '.chirp', 'chats', `Design Team Chat ${shortId(PLAT)}.teams`);
  assert.ok(fs.existsSync(file));
  ui.setConfig('chirp.agentFiles', false); await settle();
  h.world.messages[PLAT].unshift(msg('m9', 'b', '2026-11-17T13:00:00Z', 'after'));
  await h.api.conversations.poll('chat:' + PLAT);
  assert.strictEqual(fs.existsSync(file), false, 'deleted when turned off, and not written again');
  assert.strictEqual(await ui.commands['chirp.activeConversationFile'](), null);
});

test('sign out deletes chirp\'s files', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld(), { method: 'deviceCode' }); ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  await openTab(h, PLAT);
  const file = path.join(h.dir, '.chirp', 'chats', `Design Team Chat ${shortId(PLAT)}.teams`);
  assert.ok(fs.existsSync(file));
  await ui.commands['chirp.signOut'](); await settle();
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.existsSync(path.join(h.dir, '.chirp', 'current.teams')), false);
});

// ---- from the final review (sign-in)
function startWithTicks(world, o = {}) {
  const ticks = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-host-'));
  const tokenFile = path.join(dir, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ access_token: o.token || MY_TOKEN, refresh_token: 'r', client_id: 'c', tenant_id: 'tid', expires_at: Date.now() / 1000 + 3600 }));
  world.marked = []; world.messages = world.messages || {};
  const fetch = graph(world);
  const context = { extensionUri: { fsPath: path.join(__dirname, '..') }, globalState: o.memento || memento(), subscriptions: [] };
  ui.config['chirp.signIn.method'] = o.method || 'auto';
  ui.config['chirp.signIn.tokenFile'] = o.method && o.method !== 'tokenFile' ? '' : tokenFile;
  ui.config['chirp.agentFiles'] = true;
  const api = ext.activate(context, { fetch, chirpDir: path.join(dir, '.chirp'), watchFile: () => {}, unwatchFile: () => {}, setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => {}, secrets: o.secrets || secrets(), sleep: async () => {}, clientId: 'cid' });
  const h = { api, fetch, dir, context, world, ticks, tokenFile };
  running.push(h);
  return h;
}

test('Sign Out with a token file stays signed out until Sign In', async () => {
  ui.focused = true;
  const h = startWithTicks(chatWorld()); const view = ui.resolveSidebar(); await settle();
  assert.ok(lastState(view).account);
  await ui.commands['chirp.signOut'](); await settle();
  for (const t of h.ticks) await t();
  await settle();
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' }, 'the recheck did not sign back in');
  assert.strictEqual(lastState(view).account, null);
  await ui.commands['chirp.signIn'](); await settle();
  assert.ok(lastState(view).account, 'an explicit Sign In does');
});

test('signed out by the user stays signed out after a reload', async () => {
  ui.focused = true;
  const mem = memento();
  const h = startWithTicks(chatWorld(), { memento: mem }); ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signOut'](); await settle();
  h.api.dispose();
  const h2 = startWithTicks(chatWorld(), { memento: mem }); const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' });
  assert.ok(!h2.fetch.calls.some((c) => c.path.startsWith('/me')), 'no Graph calls');
});

test('a different account through any path clears the old one first', async () => {
  ui.focused = true;
  const mem = memento();
  await mem.update('chirp.lists', { me: { id: 'someone-else', displayName: 'X' }, chats: [chat('zzz')], teams: [] });
  await mem.update('chirp.mentions', { flagged: { 'chat:zzz': 'm1' }, seen: [], baseline: 1 });
  const h = startWithTicks(chatWorld(), { memento: mem }); const view = ui.resolveSidebar(); await settle();
  assert.strictEqual(h.api.state.me.id, 'me', 'start-up fetched who this login is');
  assert.deepStrictEqual(h.api.mentions.flagged(), [], 'the other account\'s mentions went');
  assert.ok(!lastState(view).chats.some((r) => r.id === 'zzz'));
});

test('Enable channels can\'t start twice, or while signed out', async () => {
  ui.focused = true;
  const w = channelWorld();
  const h = start(w, { method: 'deviceCode' }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.enableChannels'](); await settle();
  assert.strictEqual(h.fetch.calls.filter((c) => c.path === 'login:devicecode').length, 0, 'signed out: nothing happens');
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' }, 'the Sign in button stays');
  await ui.commands['chirp.signIn'](); await settle();
  let release; w.loginAnswers = [];
  const gate = new Promise((r) => { release = r; });
  const origFail = w.fail;
  w.fail = async (p) => undefined;
  const first = ui.commands['chirp.enableChannels']();
  const second = ui.commands['chirp.enableChannels']();
  await Promise.all([first, second]); await settle();
  assert.strictEqual(h.fetch.calls.filter((c) => c.path === 'login:devicecode').length, 2, 'sign-in once, channels once');
  w.fail = origFail; release();
});

test('a poll finishing after Sign Out leaves nothing behind', async () => {
  ui.focused = true;
  const w = chatWorld();
  const h = start(w, { method: 'deviceCode' }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  let release; const gate = new Promise((r) => { release = r; });
  w.fail = (p) => (p.startsWith('/me/chats') ? gate.then(() => undefined) : undefined);
  const polling = h.api.refresh();
  await settle();
  await ui.commands['chirp.signOut'](); await settle();
  delete w.fail; release(); await polling; await settle();
  assert.deepStrictEqual(lastState(view).chats, [], 'the late answer was dropped');
  assert.strictEqual(h.context.globalState.get('chirp.lists'), undefined, 'and not cached');
});

test('a start-up failure says so and offers Sign in', async () => {
  ui.focused = true;
  const sec = secrets(); sec.get = async () => { throw new Error('keyring locked'); };
  start(chatWorld(), { method: 'deviceCode', secrets: sec }); const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' });
  assert.strictEqual(lastState(view).status.kind, 'error');
  assert.match(lastState(view).status.text, /keyring locked/);
});

test('the token-file method with no file set says what to do', async () => {
  ui.focused = true;
  start(chatWorld(), { method: 'tokenFile' }); ui.config['chirp.signIn.tokenFile'] = '';
  ui.setConfig('chirp.signIn.method', 'tokenFile'); await settle();
  const view = ui.resolveSidebar(); await settle();
  assert.deepStrictEqual(lastState(view).status, { kind: 'signin', text: 'Set chirp.signIn.tokenFile to the token file to use.' });
});

test('losing the login while signed in says so', async () => {
  ui.focused = true;
  const sec = secrets();
  const w = chatWorld();
  const h = start(w, { method: 'deviceCode', secrets: sec }); const view = ui.resolveSidebar(); await settle();
  await ui.commands['chirp.signIn'](); await settle();
  await sec.delete('chirp.deviceCode.tokens');
  await h.api.refresh(); await settle();
  assert.deepStrictEqual(signInState(view), { stage: 'signedOut' });
  assert.deepStrictEqual(lastState(view).status, { kind: 'signin', text: 'Signed out: sign in again' });
});

test('turning agent files off deletes them', async () => {
  ui.focused = true; ui.panels.length = 0;
  const h = start(chatWorld()); ui.resolveSidebar(); await settle();
  await openTab(h, PLAT);
  const file = path.join(h.dir, '.chirp', 'chats', `Design Team Chat ${shortId(PLAT)}.teams`);
  assert.ok(fs.existsSync(file));
  ui.setConfig('chirp.agentFiles', false); await settle();
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.existsSync(path.join(h.dir, '.chirp', 'current.teams')), false);
});

test('the first load says it is loading; a cached start does not', async () => {
  ui.focused = true;
  let release; const gate = new Promise((r) => { release = r; });
  const w = chatWorld();
  w.fail = (p) => (p.startsWith('/me/chats') ? gate.then(() => undefined) : undefined);
  const mem = memento();
  const h = start(w, { memento: mem }); const view = ui.resolveSidebar(); await settle();
  assert.strictEqual(lastState(view).chatsLoaded, false, 'waiting for the first chat list');
  delete w.fail; release(); await settle(60);
  assert.strictEqual(lastState(view).chatsLoaded, true);
  h.api.dispose();
  const h2 = start(chatWorld(), { memento: mem }); const view2 = ui.resolveSidebar();
  assert.strictEqual(lastState(view2).chatsLoaded, true, 'the cache shows at once, no loading text');
});
