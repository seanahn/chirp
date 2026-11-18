'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createGraph, GraphError, GraphTimeout } = require('../src/graph');
const { Offline } = require('../src/tokenStore');

function tokens() { let n = 1; const t = { refreshed: 0, accessToken: async () => 't' + n, refresh: async () => { t.refreshed++; n++; return 't' + n; } }; return t; }
const json = (status, body, headers) => new Response(body === null ? null : JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
function fakeFetch(answers) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return typeof a === 'function' ? a(url, init) : a; };
  f.calls = calls; return f;
}

test('bearer header and json', async () => {
  const fetch = fakeFetch([json(200, { id: 'me' })]);
  const g = createGraph({ tokens: tokens(), fetch });
  assert.deepStrictEqual(await g.get('/me'), { id: 'me' });
  assert.strictEqual(fetch.calls[0].url, 'https://graph.microsoft.com/v1.0/me');
  assert.strictEqual(fetch.calls[0].init.headers.Authorization, 'Bearer t1');
});

test('post sends json, 204 is null', async () => {
  const fetch = fakeFetch([new Response(null, { status: 204 })]);
  const g = createGraph({ tokens: tokens(), fetch });
  assert.strictEqual(await g.post('/x', { a: 1 }), null);
  assert.strictEqual(fetch.calls[0].init.method, 'POST');
  assert.strictEqual(fetch.calls[0].init.body, '{"a":1}');
  assert.strictEqual(fetch.calls[0].init.headers['Content-Type'], 'application/json');
});

test('401 refreshes once and retries', async () => {
  const tk = tokens();
  const fetch = fakeFetch([json(401, { error: { code: 'InvalidAuthenticationToken' } }), json(200, { ok: 1 })]);
  assert.deepStrictEqual(await createGraph({ tokens: tk, fetch }).get('/me'), { ok: 1 });
  assert.strictEqual(fetch.calls[1].init.headers.Authorization, 'Bearer t2');
  const again = fakeFetch([json(401, {})]);
  await assert.rejects(createGraph({ tokens: tokens(), fetch: again }).get('/me'), (e) => e instanceof GraphError && e.status === 401);
  assert.strictEqual(again.calls.length, 2);
});

test('429 carries retry-after', async () => {
  const fetch = fakeFetch([json(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '7' })]);
  await assert.rejects(createGraph({ tokens: tokens(), fetch }).get('/me'), (e) => e instanceof GraphError && e.status === 429 && e.retryAfterMs === 7000 && e.code === 'TooManyRequests');
});

test('timeout aborts', async () => {
  const fetch = fakeFetch([(url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))]);
  await assert.rejects(createGraph({ tokens: tokens(), fetch, timeoutMs: 20 }).get('/me'), GraphTimeout);
});

test('network failure is Offline', async () => {
  const fetch = fakeFetch([() => { throw new TypeError('fetch failed'); }]);
  await assert.rejects(createGraph({ tokens: tokens(), fetch }).get('/me'), Offline);
});

test('getAll follows nextLink up to max', async () => {
  const fetch = fakeFetch([json(200, { value: [1, 2], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next?p=2' }), json(200, { value: [3, 4], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next?p=3' }), json(200, { value: [5] })]);
  assert.deepStrictEqual(await createGraph({ tokens: tokens(), fetch }).getAll('/list', 3), [1, 2, 3]);
  assert.strictEqual(fetch.calls[1].url, 'https://graph.microsoft.com/v1.0/next?p=2');
  assert.strictEqual(fetch.calls.length, 2);
});
