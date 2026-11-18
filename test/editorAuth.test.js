'use strict';
// Sign-in through the editor's Microsoft provider, against a fake vscode.authentication.
const test = require('node:test'); const assert = require('node:assert');
const { createEditorAuth } = require('../src/editorAuth');
const { SignInFailed, SignInCancelled, SignInNeeded, CHAT_SCOPES, CHANNEL_SCOPES } = require('../src/auth');

const jwt = (payload) => ['{"alg":"none"}', JSON.stringify(payload), 's'].map((x, i) => (i < 2 ? Buffer.from(x).toString('base64url') : x)).join('.');
const MINE = jwt({ appid: 'cid', oid: 'u1', tid: 't1', upn: 'alex@contoso.com', name: 'Alex' });
function memento() { const m = new Map(); return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); }, m }; }
function fakeAuthentication(answer) {
  const calls = [];
  return { calls, getSession: async (provider, scopes, options) => { calls.push({ provider, scopes, options }); return answer(scopes, options); } };
}
const session = (token) => ({ accessToken: token, account: { id: 'x', label: 'alex@contoso.com' }, scopes: [] });

test('scopes carry chirp\'s app id and tenant', async () => {
  const authentication = fakeAuthentication(() => session(MINE));
  const a = createEditorAuth({ authentication, clientId: 'cid', state: memento() });
  await a.signIn({});
  const c = authentication.calls[0];
  assert.strictEqual(c.provider, 'microsoft');
  assert.deepStrictEqual(c.scopes, ['VSCODE_CLIENT_ID:cid', 'VSCODE_TENANT:organizations', ...CHAT_SCOPES]);
  assert.strictEqual(c.options.createIfNone, true);
  assert.strictEqual(a.method, 'editor');
  assert.deepStrictEqual(a.account(), { id: 'u1', username: 'alex@contoso.com', name: 'Alex', tenantId: 't1' });
  assert.strictEqual(a.tenantId(), 't1');
  assert.strictEqual(await a.accessToken(), MINE);
  assert.strictEqual(authentication.calls[1].options.silent, true, 'later calls never prompt');
});

test('cancel is SignInCancelled, other errors unusable', async () => {
  const cancelled = createEditorAuth({ authentication: fakeAuthentication(() => { throw new Error('Cancelled'); }), clientId: 'cid', state: memento() });
  await assert.rejects(cancelled.signIn({}), SignInCancelled);
  const broken = createEditorAuth({ authentication: fakeAuthentication(() => { throw new Error('AADSTS700016: Application not found'); }), clientId: 'cid', state: memento() });
  await assert.rejects(broken.signIn({}), (e) => e instanceof SignInFailed && e.kind === 'unusable');
});

test('a token for another app is refused', async () => {
  const a = createEditorAuth({ authentication: fakeAuthentication(() => session(jwt({ appid: 'vscode-own-app', oid: 'u1' }))), clientId: 'cid', state: memento() });
  await assert.rejects(a.signIn({}), (e) => e instanceof SignInFailed && e.kind === 'unusable');
  assert.strictEqual(a.account(), null, 'nothing kept');
});

test('no silent session means sign-in needed', async () => {
  const a = createEditorAuth({ authentication: fakeAuthentication(() => undefined), clientId: 'cid', state: memento() });
  await assert.rejects(a.accessToken(), SignInNeeded);
});

test('signOut then accessToken needs sign-in', async () => {
  const state = memento();
  const a = createEditorAuth({ authentication: fakeAuthentication(() => session(MINE)), clientId: 'cid', state });
  await a.signIn({});
  await a.signOut();
  assert.strictEqual(state.get('chirp.editorAuth.signedOut'), true);
  await assert.rejects(a.accessToken(), SignInNeeded);
  const again = createEditorAuth({ authentication: fakeAuthentication(() => session(MINE)), clientId: 'cid', state });
  await assert.rejects(again.accessToken(), SignInNeeded, 'stays signed out after a restart');
});

test('sign-in after sign-out offers the account picker', async () => {
  const authentication = fakeAuthentication(() => session(MINE));
  const a = createEditorAuth({ authentication, clientId: 'cid', state: memento() });
  await a.signIn({ newAccount: true });
  assert.strictEqual(authentication.calls[0].options.clearSessionPreference, true);
  assert.strictEqual(await a.accessToken(), MINE, 'signed in again');
});

test('channels are remembered for later calls', async () => {
  const state = memento();
  const authentication = fakeAuthentication(() => session(MINE));
  const a = createEditorAuth({ authentication, clientId: 'cid', state });
  await a.signIn({ channels: true });
  assert.deepStrictEqual(authentication.calls[0].scopes.slice(2), [...CHAT_SCOPES, ...CHANNEL_SCOPES]);
  assert.strictEqual(a.hasChannels(), true);
  await a.accessToken();
  assert.deepStrictEqual(authentication.calls[1].scopes.slice(2), [...CHAT_SCOPES, ...CHANNEL_SCOPES]);
  const later = createEditorAuth({ authentication, clientId: 'cid', state });
  assert.strictEqual(later.hasChannels(), true, 'after a restart');
});

test('refresh asks silently again', async () => {
  const authentication = fakeAuthentication(() => session(MINE));
  const a = createEditorAuth({ authentication, clientId: 'cid', state: memento() });
  await a.signIn({});
  assert.strictEqual(await a.refresh(), MINE);
  assert.strictEqual(authentication.calls.at(-1).options.silent, true);
});

test('a plain sign-in asks only for chats, even after channels were on', async () => {
  const state = memento();
  const authentication = fakeAuthentication(() => session(MINE));
  const a = createEditorAuth({ authentication, clientId: 'cid', state });
  await a.signIn({ channels: true });
  await a.signIn({});
  assert.deepStrictEqual(authentication.calls[1].scopes.slice(2), CHAT_SCOPES, 'chats never wait on the channel permissions');
  assert.strictEqual(a.hasChannels(), false);
  await a.accessToken();
  assert.deepStrictEqual(authentication.calls[2].scopes.slice(2), CHAT_SCOPES, 'later calls use the same set, so the session matches');
});

test('Cancel stops waiting on the editor', async () => {
  let fire; const cancel = { isCancellationRequested: false, onCancellationRequested: (fn) => { fire = fn; return { dispose() {} }; } };
  const a = createEditorAuth({ authentication: fakeAuthentication(() => new Promise(() => {})), clientId: 'cid', state: memento() });
  const p = a.signIn({ cancel });
  setTimeout(() => { cancel.isCancellationRequested = true; fire(); }, 5);
  await assert.rejects(p, SignInCancelled);
});
