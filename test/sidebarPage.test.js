'use strict';
// The sidebar's page script, run in jsdom with a fake acquireVsCodeApi.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'media', 'sidebar.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'sidebar.css'), 'utf8');

function page() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window, posted = []; let saved;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: (s) => { saved = s; } });
  w.eval(SCRIPT);
  const send = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  const key = (k, target) => (target || w.document).dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  return { w, d: w.document, posted, send, key };
}
const row = (o) => Object.assign({ kind: 'chat', id: 'c', name: 'Chat', preview: 'X: hi', unread: false, unreadCount: null, mention: false, time: null }, o);
const state = (o) => Object.assign({ type: 'state', chats: [], teams: [], status: null, reduceMotion: false, meName: 'Sean Ahn' }, o);

test('asks for state when ready', () => { assert.deepStrictEqual(page().posted[0], { type: 'ready' }); });

test('renders unread bold with count', () => {
  const p = page();
  p.send(state({ chats: [row({ id: 'a', name: 'Design Team Chat', unread: true, unreadCount: 3 }), row({ id: 'b', name: 'Ted Tran' }), row({ id: 'c', name: 'Bold only', unread: true })] }));
  const rows = [...p.d.querySelectorAll('.chats .row')];
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.name').textContent), ['Design Team Chat', 'Ted Tran', 'Bold only']);
  assert.deepStrictEqual(rows.map((r) => r.classList.contains('unread')), [true, false, true]);
  assert.strictEqual(rows[0].querySelector('.count').textContent, '3');
  assert.strictEqual(rows[2].querySelector('.count'), null);
  assert.strictEqual(rows[0].querySelector('.preview').textContent, 'X: hi');
  assert.ok(/\.row\.unread[^{]*\{[^}]*font-weight:\s*(bold|[6-9]00)/.test(CSS), 'unread rows are bold');
});

test("mention row pulses and marks Sean's name", () => {
  const p = page();
  p.send(state({ chats: [row({ name: 'Launch Review', unread: true, mention: true, preview: 'Theo: Sam Ortiz Sean Ahn v1 PR here' })] }));
  const r = p.d.querySelector('.chats .row');
  assert.ok(r.classList.contains('mention'));
  assert.strictEqual(r.querySelector('.at').textContent, '@');
  assert.strictEqual(r.querySelector('.preview mark').textContent, 'Sean Ahn');
  assert.strictEqual(r.querySelector('.preview').textContent, 'Theo: Sam Ortiz Sean Ahn v1 PR here');
  assert.ok(/\.row\.mention[^{]*\{[^}]*animation:\s*pulse 2\.4s ease-in-out infinite/.test(CSS));
  assert.ok(/@keyframes pulse[\s\S]*opacity:\s*0?\.33/.test(CSS));
});

test('reduced motion: no animation, accent background', () => {
  const p = page();
  p.send(state({ reduceMotion: true, chats: [row({ mention: true })] }));
  assert.ok(p.d.body.classList.contains('reduce-motion'));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.row\.mention[^{]*\{[^}]*animation:\s*none[^}]*background:\s*var\(--vscode-list-inactiveSelectionBackground\)/.test(CSS));
  assert.ok(/\.reduce-motion \.row\.mention[^{]*\{[^}]*animation:\s*none[^}]*background:\s*var\(--vscode-list-inactiveSelectionBackground\)/.test(CSS));
  p.send(state({ reduceMotion: false }));
  assert.ok(!p.d.body.classList.contains('reduce-motion'));
});

test('filter narrows chats', () => {
  const p = page();
  p.send(state({ chats: [row({ id: 'a', name: 'Design Team Chat' }), row({ id: 'b', name: 'Ted Tran' })] }));
  const f = p.d.querySelector('input.filter');
  f.value = 'design'; f.dispatchEvent(new p.w.Event('input'));
  assert.deepStrictEqual([...p.d.querySelectorAll('.chats .row')].map((r) => r.querySelector('.name').textContent), ['Design Team Chat']);
  p.send(state({ chats: [row({ id: 'a', name: 'Design Team Chat' }), row({ id: 'b', name: 'Ted Tran' })] }));
  assert.strictEqual(p.d.querySelectorAll('.chats .row').length, 1, 'the filter survives an update');
  p.key('Escape', f);
  assert.strictEqual(f.value, '');
  assert.strictEqual(p.d.querySelectorAll('.chats .row').length, 2);
});

test('arrow keys and Enter post open', () => {
  const p = page();
  p.send(state({ chats: [row({ id: 'a' }), row({ id: 'b' })] }));
  p.key('ArrowDown'); p.key('ArrowDown'); p.key('Enter');
  assert.deepStrictEqual(p.posted.at(-1), { type: 'open', ref: { kind: 'chat', id: 'b' } });
  p.key('ArrowUp'); p.key('Enter');
  assert.deepStrictEqual(p.posted.at(-1), { type: 'open', ref: { kind: 'chat', id: 'a' } });
  p.d.querySelectorAll('.chats .row')[1].dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'open', ref: { kind: 'chat', id: 'b' } });
});

test('slash focuses the filter, as does the host', () => {
  const p = page();
  p.key('/');
  assert.strictEqual(p.d.activeElement, p.d.querySelector('input.filter'));
  p.d.activeElement.blur();
  p.send({ type: 'focusFilter' });
  assert.strictEqual(p.d.activeElement, p.d.querySelector('input.filter'));
});

test('status shows above the lists', () => {
  const p = page();
  p.send(state({ status: { kind: 'signin', text: "Sign in with the ms365 MCP server's login tool" } }));
  assert.strictEqual(p.d.querySelector('.status').textContent, "Sign in with the ms365 MCP server's login tool");
  assert.ok(p.d.querySelector('.status').classList.contains('signin'));
  p.send(state({ status: null }));
  assert.strictEqual(p.d.querySelector('.status').hidden, true);
});

test('data is never parsed as html', () => {
  const p = page();
  p.send(state({ chats: [row({ name: '<img src=x onerror="window.pwned=1">', preview: '<b>x</b>' })] }));
  assert.strictEqual(p.d.querySelector('img'), null);
  assert.strictEqual(p.d.querySelector('.chats .row .name').textContent, '<img src=x onerror="window.pwned=1">');
  assert.strictEqual(p.w.pwned, undefined);
});

test('teams expand to channels; channels never bold', () => {
  const p = page();
  const teams = [{ id: 'T1', name: 'Product Team', channels: [{ id: 'C1', name: 'General', mention: false }, { id: 'C2', name: 'chirp-test', mention: true }] }, { id: 'T2', name: 'Support', channels: [{ id: 'C4', name: 'General', mention: false }] }];
  p.send(state({ teams }));
  const names = () => [...p.d.querySelectorAll('.teams .row')].map((r) => r.querySelector('.name').textContent);
  assert.deepStrictEqual(names(), ['Product Team', 'Support'], 'collapsed at first');
  assert.ok(p.d.querySelector('.teams .row.team').classList.contains('mention'), 'a collapsed team shows its channel mention');
  p.d.querySelector('.teams .row.team').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(names(), ['Product Team', 'General', 'chirp-test', 'Support']);
  const chirp = [...p.d.querySelectorAll('.teams .row.channel')][1];
  assert.ok(chirp.classList.contains('mention'));
  assert.ok(![...p.d.querySelectorAll('.teams .row')].some((r) => r.classList.contains('unread')), 'no channel is ever bold');
  chirp.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'open', ref: { kind: 'channel', teamId: 'T1', id: 'C2' } });
  p.send(state({ teams }));
  assert.deepStrictEqual(names(), ['Product Team', 'General', 'chirp-test', 'Support'], 'expansion survives an update');
  const f = p.d.querySelector('input.filter'); f.value = 'chirp'; f.dispatchEvent(new p.w.Event('input'));
  assert.deepStrictEqual(names(), ['Product Team', 'chirp-test']);
});

// ---- sign-in states (sign-in plan, Task 6)
const btn = (p, label) => [...p.d.querySelectorAll('button')].find((b) => b.textContent === label);
const click = (p, el) => el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));

test('signed out: a sign-in button in place of the lists', () => {
  const p = page();
  p.send(state({ signIn: { stage: 'signedOut' }, account: null, chats: [row({ id: 'a' })] }));
  assert.ok(btn(p, 'Sign in to Microsoft'));
  assert.strictEqual(p.d.querySelector('.chats').hidden, true, 'the lists are hidden while signed out');
  assert.strictEqual(p.d.querySelector('.teams').hidden, true);
  click(p, btn(p, 'Sign in to Microsoft'));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'signIn' });
});

test('waiting: the message and Cancel', () => {
  const p = page();
  p.send(state({ signIn: { stage: 'waiting' }, account: null }));
  assert.ok(p.d.querySelector('.signin').textContent.includes('Waiting for sign-in in the browser…'));
  click(p, btn(p, 'Cancel'));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'cancelSignIn' });
});

test('a sign-in code: large, copy and open, where to enter it', () => {
  const p = page();
  p.send(state({ signIn: { stage: 'code', userCode: 'ABCD-1234', verificationUri: 'https://microsoft.com/devicelogin' }, account: null }));
  assert.strictEqual(p.d.querySelector('.signin .code').textContent, 'ABCD-1234');
  assert.ok(p.d.querySelector('.signin').textContent.includes('Enter it at https://microsoft.com/devicelogin'));
  click(p, btn(p, 'Copy code & open'));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'copyCode' });
  click(p, btn(p, 'Cancel'));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'cancelSignIn' });
});

test('the user code is text, never html', () => {
  const p = page();
  p.send(state({ signIn: { stage: 'code', userCode: '<img src=x onerror="window.pwned=1">', verificationUri: '<b>x</b>' }, account: null }));
  assert.strictEqual(p.d.querySelector('img'), null);
  assert.strictEqual(p.w.pwned, undefined);
});

test('the account line names the method', () => {
  const p = page();
  for (const [method, shown] of [['editor', 'editor'], ['deviceCode', 'sign-in code'], ['tokenFile', 'token file']]) {
    p.send(state({ signIn: null, account: { username: 'alex@contoso.com', method } }));
    assert.strictEqual(p.d.querySelector('.account').textContent, `Signed in as alex@contoso.com (${shown})`);
  }
  p.send(state({ signIn: null, account: null }));
  assert.strictEqual(p.d.querySelector('.account').hidden, true);
});

test('the Teams section by channel state', () => {
  const p = page();
  const signedIn = { signIn: null, account: { username: 'a@b.com', method: 'editor' } };
  p.send(state(Object.assign({ channels: 'off' }, signedIn)));
  click(p, btn(p, 'Enable channels'));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'enableChannels' });
  p.send(state(Object.assign({ channels: 'failed' }, signedIn)));
  assert.ok(p.d.querySelector('.channels-note').textContent.includes("Channels weren't enabled. If your company requires an admin to approve chirp, send them this link."));
  click(p, btn(p, 'Copy admin link'));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'copyAdminLink' });
  click(p, btn(p, 'Try again'));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'enableChannels' });
  p.send(state(Object.assign({ channels: 'forbidden' }, signedIn)));
  assert.strictEqual(p.d.querySelector('.channels-note').textContent, "Channels need permissions this login doesn't have.");
  assert.strictEqual(btn(p, 'Enable channels'), undefined);
  p.send(state(Object.assign({ channels: 'enabled', teams: [{ id: 'T', name: 'Team', channels: [] }] }, signedIn)));
  assert.strictEqual(p.d.querySelector('.channels-note').hidden, true);
  assert.strictEqual(p.d.querySelectorAll('.teams .row.team').length, 1);
});

test('no Enable channels button while a sign-in is under way', () => {
  const p = page();
  p.send(state({ signIn: { stage: 'waiting' }, account: { username: 'a@b.com', method: 'editor' }, channels: 'off' }));
  assert.strictEqual(btn(p, 'Enable channels'), undefined);
});

test('a row\'s name and its last message have different colors', () => {
  assert.ok(/\.row \.name\s*\{[^}]*color:\s*var\(--vscode-foreground\)/.test(CSS), 'the name in the normal text color');
  assert.ok(/\.row \.preview\s*\{[^}]*color:\s*var\(--vscode-descriptionForeground\)/.test(CSS), 'the last message dimmer');
});

test('hovering a chat shows its last message', () => {
  const p = page();
  p.send(state({ chats: [row({ id: 'a', preview: 'X: short', tooltip: 'Xavier Ng: the whole\nmessage <b>here</b>' })] }));
  const r = p.d.querySelector('.chats .row');
  assert.strictEqual(r.getAttribute('title'), 'Xavier Ng: the whole\nmessage <b>here</b>');
  assert.strictEqual(r.querySelector('b'), null, 'as text');
});

// ---- first load (no cached lists yet)
test('loading text until the first lists arrive, then plain empty states', () => {
  const p = page();
  const signedIn = { signIn: null, account: { username: 'a@b.com', method: 'tokenFile' }, channels: 'enabled' };
  p.send(state(Object.assign({ chats: [], teams: [], chatsLoaded: false, teamsLoaded: false }, signedIn)));
  assert.strictEqual(p.d.querySelector('.chats .empty').textContent, 'Loading chats…');
  assert.strictEqual(p.d.querySelector('.teams .empty').textContent, 'Loading teams…');
  p.send(state(Object.assign({ chats: [], teams: [], chatsLoaded: true, teamsLoaded: true }, signedIn)));
  assert.strictEqual(p.d.querySelector('.chats .empty').textContent, 'No chats yet');
  assert.strictEqual(p.d.querySelector('.teams .empty').textContent, 'No teams');
  p.send(state(Object.assign({ chats: [row({ id: 'a', name: 'Alpha' })], teams: [], chatsLoaded: true, teamsLoaded: true }, signedIn)));
  assert.strictEqual(p.d.querySelector('.chats .empty'), null, 'rows replace it');
  const f = p.d.querySelector('input.filter'); f.value = 'zzz'; f.dispatchEvent(new p.w.Event('input'));
  assert.strictEqual(p.d.querySelector('.chats .empty').textContent, 'No matches');
});

test('no "Loading teams" before channels are enabled', () => {
  const p = page();
  p.send(state({ chats: [], teams: [], chatsLoaded: false, teamsLoaded: false, signIn: null, account: { username: 'a@b.com', method: 'editor' }, channels: 'off' }));
  assert.strictEqual(p.d.querySelector('.teams .empty'), null);
});

// ---- start a chat with someone not in the list
const typeFilter = (p, text) => { const f = p.d.querySelector('input.filter'); f.value = text; f.dispatchEvent(new p.w.Event('input')); return f; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('no chat matches: after a pause, people are searched', async () => {
  const p = page();
  p.send(state({ chats: [row({ id: 'a', name: 'Alpha' })], chatsLoaded: true }));
  typeFilter(p, 'N'); await wait(350);
  assert.strictEqual(p.posted.filter((x) => x.type === 'findPeople').length, 0, 'one letter is too few');
  typeFilter(p, 'Na'); typeFilter(p, 'Nor'); await wait(350);
  assert.deepStrictEqual(p.posted.filter((x) => x.type === 'findPeople'), [{ type: 'findPeople', query: 'Nor' }], 'once, after typing stops');
  typeFilter(p, 'Al'); await wait(350);
  assert.strictEqual(p.posted.filter((x) => x.type === 'findPeople').length, 1, 'a matching chat: no search');
});

test('people show under the chats, and picking one starts the chat', () => {
  const p = page();
  typeFilter(p, 'Nor');
  p.send(state({ chats: [], chatsLoaded: true, people: { query: 'Nor', results: [{ id: 'u1', name: 'Nora Lane', mail: 'nora@example.com' }] } }));
  const person = p.d.querySelector('.chats .row.person');
  assert.ok(p.d.querySelector('.chats').textContent.includes('Start a chat with'));
  assert.strictEqual(person.querySelector('.name').textContent, 'Nora Lane');
  assert.strictEqual(person.querySelector('.preview').textContent, 'nora@example.com');
  person.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.posted.at(-1), { type: 'startChat', userId: 'u1', name: 'Nora Lane' });
  p.send(state({ chats: [], chatsLoaded: true, people: { query: 'Zed', results: [{ id: 'u2', name: 'Zed Z', mail: '' }] } }));
  assert.strictEqual(p.d.querySelector('.chats .row.person'), null, 'results for another search are not shown');
  p.send(state({ chats: [], chatsLoaded: true, people: { query: 'Nor', results: [], error: "chirp can't search people with this login." } }));
  assert.ok(p.d.querySelector('.chats').textContent.includes("chirp can't search people with this login."));
});
