'use strict';
// The ms365 MCP server's login, shared: chirp reads its token file before every request, refreshes it when it is about to
// expire, and writes it back in the same format. The file is never left half-written (temp file, then rename), and a
// newer token the MCP server stored meanwhile always wins (design 101, "Signing in").
const fs = require('fs');

const REFRESH_MARGIN_S = 60;
const SCOPE = 'https://graph.microsoft.com/.default offline_access';
const TORN_RETRY_MS = 200;

class SignInNeeded extends Error { constructor(msg) { super(msg || 'Sign in with the ms365 MCP server\'s login tool'); this.name = 'SignInNeeded'; } }
class Offline extends Error { constructor(msg) { super(msg || 'Offline'); this.name = 'Offline'; } }

function createTokenStore({ file, fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let lastTenant = null;
  let inflight = null;

  function readOnce() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') throw new SignInNeeded(); throw e; }
    return JSON.parse(text);
  }
  /** The file's contents. A torn read (the MCP server mid-write) is retried once. */
  async function read() {
    let t;
    try { t = readOnce(); } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      await sleep(TORN_RETRY_MS);
      try { t = readOnce(); } catch (e2) { if (e2 instanceof SyntaxError) throw new SignInNeeded(); throw e2; }
    }
    if (!t || !t.refresh_token && !t.access_token) throw new SignInNeeded();
    lastTenant = t.tenant_id || lastTenant;
    return t;
  }
  function write(obj) {
    const tmp = `${file}.chirp-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  async function doRefresh() {
    const t = await read();
    if (!t.refresh_token || !t.client_id || !t.tenant_id) throw new SignInNeeded();
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: t.client_id, refresh_token: t.refresh_token, scope: SCOPE });
    let res;
    try {
      res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(t.tenant_id)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    } catch (e) { throw new Offline(); }
    let data = {};
    try { data = await res.json(); } catch (_) { /* not json */ }
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_grant' || res.status === 400 || res.status === 401) throw new SignInNeeded();
      throw new Offline(`Token refresh failed (${res.status})`);
    }
    const expiresAt = Math.floor(now() / 1000) + Number(data.expires_in || 3600);
    const latest = await read();
    if (Number(latest.expires_at) > expiresAt) return latest.access_token;   // the MCP server refreshed meanwhile
    write(Object.assign({}, latest, { access_token: data.access_token, refresh_token: data.refresh_token || latest.refresh_token, expires_at: expiresAt }));
    return data.access_token;
  }

  function refresh() {
    if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
    return inflight;
  }

  async function accessToken() {
    if (inflight) return inflight;
    const t = await read();
    if (t.access_token && Number(t.expires_at) - now() / 1000 > REFRESH_MARGIN_S) return t.access_token;
    return refresh();
  }

  return { accessToken, refresh, tenantId: () => lastTenant };
}

module.exports = { createTokenStore, SignInNeeded, Offline, REFRESH_MARGIN_S, SCOPE };
