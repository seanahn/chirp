'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const A = require('../src/auth');

/** A JWT-shaped token with the given payload; the signature is never checked. */
const jwt = (payload) => ['{"alg":"none"}', JSON.stringify(payload), 'sig'].map((x, i) => (i < 2 ? Buffer.from(x).toString('base64url') : x)).join('.');

test('scopes are exactly the design\'s', () => {
  assert.deepStrictEqual(A.CHAT_SCOPES, ['User.Read', 'Chat.ReadWrite', 'ChatMessage.Send', 'offline_access']);
  assert.deepStrictEqual(A.CHANNEL_SCOPES, ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All', 'ChannelMessage.Send']);
  assert.strictEqual(A.AUTHORITY, 'https://login.microsoftonline.com/organizations/oauth2/v2.0');
  assert.match(A.CHIRP_CLIENT_ID, /^[0-9a-f-]{36}$/);
});

test('graph scopes are prefixed, offline_access is not', () => {
  assert.strictEqual(A.graphScope('Chat.ReadWrite'), 'https://graph.microsoft.com/Chat.ReadWrite');
  assert.strictEqual(A.graphScope('offline_access'), 'offline_access');
});

test('claims reads appid, falling back to azp', () => {
  assert.deepStrictEqual(A.claims(jwt({ appid: 'app', tid: 't', oid: 'o', upn: 'u@x.com', name: 'U' })), { appid: 'app', tid: 't', oid: 'o', upn: 'u@x.com', name: 'U' });
  assert.strictEqual(A.claims(jwt({ azp: 'app2', tid: 't', oid: 'o', preferred_username: 'p@x.com' })).appid, 'app2');
  assert.strictEqual(A.claims(jwt({ azp: 'a', preferred_username: 'p@x.com' })).upn, 'p@x.com', 'upn falls back to preferred_username');
});

test('claims of garbage is null', () => {
  for (const bad of ['', 'nope', 'a.b', null, undefined, 'a.!!!.c']) assert.strictEqual(A.claims(bad), null);
});

test('the error kinds', () => {
  const e = new A.SignInFailed('expired', 'Sign-in code expired.');
  assert.ok(e instanceof Error); assert.strictEqual(e.kind, 'expired'); assert.strictEqual(e.message, 'Sign-in code expired.');
  assert.ok(new A.SignInCancelled() instanceof Error);
  assert.ok(A.SignInNeeded && A.Offline);
});

function tokenFile(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-auth-'));
  const file = path.join(dir, 't.json');
  fs.writeFileSync(file, JSON.stringify({ access_token: jwt(payload), refresh_token: 'r', client_id: 'c', tenant_id: 'tid', expires_at: Date.now() / 1000 + 3600 }));
  return file;
}

test('token-file auth reads the account from the token', async () => {
  const a = A.createTokenFileAuth({ file: tokenFile({ appid: 'x', tid: 'tid', oid: 'me', upn: 'alex@contoso.com', name: 'Alex' }), fetch: async () => { throw new Error('no'); } });
  assert.strictEqual(a.method, 'tokenFile');
  assert.strictEqual(a.account(), null, 'unknown until the token is read');
  await a.signIn({});
  assert.deepStrictEqual(a.account(), { id: 'me', username: 'alex@contoso.com', name: 'Alex', tenantId: 'tid' });
  assert.strictEqual(a.hasChannels(), true);
  assert.strictEqual(a.tenantId(), 'tid');
});

test('token-file signIn without a file is SignInNeeded', async () => {
  const a = A.createTokenFileAuth({ file: path.join(os.tmpdir(), 'no-such-chirp-file.json'), fetch: async () => null });
  await assert.rejects(a.signIn({}), A.SignInNeeded);
});

test('token-file signOut leaves the file alone', async () => {
  const file = tokenFile({ oid: 'me' });
  const before = fs.readFileSync(file, 'utf8');
  const a = A.createTokenFileAuth({ file, fetch: async () => null });
  await a.signOut();
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});
