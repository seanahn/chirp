'use strict';
// The ms365 MCP server's token file, in a throwaway directory, with a fake token endpoint. No real ~/.ms365-zig-mcp-token.json.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createTokenStore, SignInNeeded, Offline } = require('../src/tokenStore');

const NOW = Date.parse('2026-11-18T16:00:00Z'), S = NOW / 1000;
function setup(fields) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-token-'));
  const file = path.join(dir, 'token.json');
  if (fields !== undefined) fs.writeFileSync(file, typeof fields === 'string' ? fields : JSON.stringify(fields), { mode: 0o600 });
  return { dir, file };
}
const base = (o) => Object.assign({ access_token: 'old', refresh_token: 'r1', client_id: 'cid', tenant_id: 'tid', expires_at: S + 3600, extra: 1 }, o);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: String(init.body) }); return answer(url, init, calls.length); };
  f.calls = calls; return f;
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('fresh token is returned without a refresh', async () => {
  const { file } = setup(base());
  const fetch = fakeFetch(() => { throw new Error('no'); });
  assert.strictEqual(await createTokenStore({ file, fetch, now: () => NOW }).accessToken(), 'old');
  assert.strictEqual(fetch.calls.length, 0);
});

test('token near expiry is refreshed and written atomically', async () => {
  const { dir, file } = setup(base({ expires_at: S + 30 }));
  const fetch = fakeFetch(() => json(200, { access_token: 'new', refresh_token: 'r2', expires_in: 3600 }));
  const t = createTokenStore({ file, fetch, now: () => NOW });
  assert.strictEqual(await t.accessToken(), 'new');
  assert.strictEqual(fetch.calls[0].url, 'https://login.microsoftonline.com/tid/oauth2/v2.0/token');
  const body = new URLSearchParams(fetch.calls[0].body);
  assert.strictEqual(body.get('grant_type'), 'refresh_token');
  assert.strictEqual(body.get('client_id'), 'cid');
  assert.strictEqual(body.get('refresh_token'), 'r1');
  assert.strictEqual(body.get('scope'), 'https://graph.microsoft.com/.default offline_access');
  assert.strictEqual(body.has('client_secret'), false);
  const f = read(file);
  assert.deepStrictEqual([f.access_token, f.refresh_token, f.expires_at, f.extra, f.client_id], ['new', 'r2', Math.floor(S) + 3600, 1, 'cid']);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir), ['token.json'], 'no temp file left');
  assert.strictEqual(t.tenantId(), 'tid');
});

test('a refresh response without a refresh token keeps the old one', async () => {
  const { file } = setup(base({ expires_at: S - 10 }));
  const fetch = fakeFetch(() => json(200, { access_token: 'new', expires_in: 3600 }));
  await createTokenStore({ file, fetch, now: () => NOW }).accessToken();
  assert.strictEqual(read(file).refresh_token, 'r1');
});

test('a later token written by the MCP server wins', async () => {
  const { file } = setup(base({ expires_at: S + 30 }));
  const fetch = fakeFetch(() => { fs.writeFileSync(file, JSON.stringify(base({ access_token: 'mcp', expires_at: S + 7200 }))); return json(200, { access_token: 'new', refresh_token: 'r2', expires_in: 3600 }); });
  assert.strictEqual(await createTokenStore({ file, fetch, now: () => NOW }).accessToken(), 'mcp');
  assert.strictEqual(read(file).access_token, 'mcp');
});

test('concurrent callers share one refresh', async () => {
  const { file } = setup(base({ expires_at: S + 30 }));
  const fetch = fakeFetch(async () => { await new Promise((r) => setTimeout(r, 10)); return json(200, { access_token: 'new', refresh_token: 'r2', expires_in: 3600 }); });
  const t = createTokenStore({ file, fetch, now: () => NOW });
  assert.deepStrictEqual(await Promise.all([t.accessToken(), t.accessToken(), t.accessToken()]), ['new', 'new', 'new']);
  assert.strictEqual(fetch.calls.length, 1);
});

test('invalid_grant means sign-in needed', async () => {
  const { file } = setup(base({ expires_at: S + 30 }));
  const before = fs.readFileSync(file, 'utf8');
  const fetch = fakeFetch(() => json(400, { error: 'invalid_grant', error_description: 'expired' }));
  await assert.rejects(createTokenStore({ file, fetch, now: () => NOW }).accessToken(), SignInNeeded);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('missing file means sign-in needed', async () => {
  const { file } = setup();
  await assert.rejects(createTokenStore({ file, fetch: fakeFetch(() => null), now: () => NOW }).accessToken(), SignInNeeded);
});

test('network error is Offline and keeps the file', async () => {
  const { file } = setup(base({ expires_at: S + 30 }));
  const before = fs.readFileSync(file, 'utf8');
  const fetch = fakeFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(createTokenStore({ file, fetch, now: () => NOW }).accessToken(), Offline);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('torn file is retried, then sign-in needed', async () => {
  const { file } = setup('{"acc');
  const slept = [];
  await assert.rejects(createTokenStore({ file, fetch: fakeFetch(() => null), now: () => NOW, sleep: async (ms) => { slept.push(ms); } }).accessToken(), SignInNeeded);
  assert.deepStrictEqual(slept, [200]);
  const two = setup('{"acc');
  const t = createTokenStore({ file: two.file, fetch: fakeFetch(() => null), now: () => NOW, sleep: async () => { fs.writeFileSync(two.file, JSON.stringify(base())); } });
  assert.strictEqual(await t.accessToken(), 'old');
});
