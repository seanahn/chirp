'use strict';
// Device-code sign-in (design 201, "2. Device-code sign-in"): chirp shows a code, the user enters it at microsoft.com, and
// chirp keeps the tokens in the editor's secret storage and refreshes them itself.
const { AUTHORITY, CHAT_SCOPES, CHANNEL_SCOPES, graphScope, accountOf, SignInNeeded, Offline, SignInCancelled, SignInFailed } = require('./auth');

const KEY = 'chirp.deviceCode.tokens';
const REFRESH_MARGIN_S = 60;
const MESSAGES = {
  expired: 'Sign-in code expired.',
  declined: 'Sign-in was declined.',
  personal: 'chirp needs a work or school Microsoft 365 account.',
  misconfigured: "chirp's app registration doesn't allow device sign-in (AADSTS7000218).",
  storage: "chirp couldn't save your sign-in: the editor's secret storage isn't available. On Linux, install a keyring such as gnome-keyring.",
};
const failed = (kind, detail) => new SignInFailed(kind, MESSAGES[kind] || detail || kind);

/** Which failure a token-endpoint error is. The personal-account codes are a guess, checked at the first live sign-in. */
function errorKind(data) {
  const e = (data && data.error) || '', d = (data && data.error_description) || '';
  if (e === 'expired_token') return 'expired';
  if (e === 'authorization_declined' || e === 'access_denied') return 'declined';
  if (e === 'invalid_client' || /AADSTS7000218/.test(d)) return 'misconfigured';
  if (/AADSTS50020|AADSTS9002331|Microsoft account/i.test(d)) return 'personal';
  return 'other';
}

function createDeviceCodeAuth({ secrets, fetch, clientId, onCode = () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let cached;            // undefined: not read yet; null: none stored
  let inflight = null;
  secrets.onDidChange((e) => { if (!e || e.key === KEY) cached = undefined; });   // another window signed in, refreshed or out

  const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
  async function post(path, o) {
    const res = await fetch(`${AUTHORITY}/${path}`, form(o));
    let data = {}; try { data = await res.json(); } catch (_) { /* not json */ }
    return { ok: res.ok, status: res.status, data };
  }
  async function read() {
    if (cached === undefined) { const raw = await secrets.get(KEY); try { cached = raw ? JSON.parse(raw) : null; } catch (_) { cached = null; } }
    return cached;
  }
  async function save(t) {
    try { await secrets.store(KEY, JSON.stringify(t)); } catch (_) { throw failed('storage'); }
    cached = t;
  }
  const record = (data, channels, old) => ({
    access_token: data.access_token, refresh_token: data.refresh_token || (old && old.refresh_token),
    expires_at: Math.floor(now() / 1000) + Number(data.expires_in || 3600),
    tenant_id: (accountOf(data.access_token) || {}).tenantId || (old && old.tenant_id) || null,
    scope: data.scope || (old && old.scope) || '', channels: !!channels,
  });

  async function signIn({ channels = false, cancel } = {}) {
    const scope = CHAT_SCOPES.concat(channels ? CHANNEL_SCOPES : []).map(graphScope).join(' ');
    let start;
    try { start = await post('devicecode', { client_id: clientId, scope }); } catch (_) { throw new Offline(); }
    if (!start.ok) { const k = errorKind(start.data); throw failed(k, start.data.error_description); }
    const c = start.data, expiresAt = now() + Number(c.expires_in || 900) * 1000;
    onCode({ userCode: c.user_code, verificationUri: c.verification_uri, expiresAt });
    let interval = Number(c.interval || 5);
    for (;;) {
      if (cancel && cancel.isCancellationRequested) throw new SignInCancelled();
      await sleep(interval * 1000);
      if (cancel && cancel.isCancellationRequested) throw new SignInCancelled();
      let r;
      try { r = await post('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: c.device_code }); }
      catch (_) { if (now() >= expiresAt) throw failed('expired'); continue; }   // a network blip: keep polling until the code runs out
      if (r.ok && r.data.access_token) { await save(record(r.data, channels)); return; }
      const err = r.data.error;
      if (err === 'authorization_pending') { if (now() >= expiresAt) throw failed('expired'); continue; }
      if (err === 'slow_down') { interval += 5; continue; }
      throw failed(errorKind(r.data), r.data.error_description);
    }
  }

  async function doRefresh() {
    const t = await read();
    if (!t || !t.refresh_token) throw new SignInNeeded();
    let r;
    try { r = await post('token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: t.refresh_token, scope: t.scope }); }
    catch (_) { throw new Offline(); }
    if (!r.ok || !r.data.access_token) {
      if (r.data.error === 'invalid_grant') { await secrets.delete(KEY); cached = null; throw new SignInNeeded(); }
      if (r.status >= 500) throw new Offline();
      throw new SignInNeeded();
    }
    cached = undefined;
    const latest = await read();   // another window may have refreshed meanwhile: a later expiry wins
    const mine = record(r.data, t.channels, t);
    if (latest && latest.expires_at > mine.expires_at) return latest.access_token;
    await save(mine);
    return mine.access_token;
  }
  function refresh() {
    if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
    return inflight;
  }
  async function accessToken() {
    if (inflight) return inflight;
    const t = await read();
    if (!t || !t.access_token) throw new SignInNeeded();
    if (t.expires_at - now() / 1000 > REFRESH_MARGIN_S) return t.access_token;
    return refresh();
  }

  return {
    method: 'deviceCode', signIn, accessToken, refresh,
    tenantId: () => (cached && cached.tenant_id) || null,
    account: () => (cached && cached.access_token ? accountOf(cached.access_token, cached.tenant_id) : null),
    hasChannels: () => !!(cached && cached.channels),
    async signOut() { await secrets.delete(KEY); cached = null; },
  };
}

module.exports = { createDeviceCodeAuth, KEY, MESSAGES, errorKind };
