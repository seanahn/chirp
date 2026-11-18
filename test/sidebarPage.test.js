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
