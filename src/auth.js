'use strict';
// Signing in (design 201). Every way to sign in returns the same Auth object, which the rest of chirp uses for tokens:
//   { method, accessToken(), refresh(), tenantId(), account(), signIn(opts), hasChannels(), signOut() }
const { createTokenStore, SignInNeeded, Offline } = require('./tokenStore');

/** chirp's app registration in Microsoft Entra: multitenant, a public client. Not a secret. */
const CHIRP_CLIENT_ID = '5d0faf94-77bc-41c5-8c4f-73bacc2040ff';
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
const CHAT_SCOPES = ['User.Read', 'Chat.ReadWrite', 'ChatMessage.Send', 'offline_access'];
const CHANNEL_SCOPES = ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All', 'ChannelMessage.Send'];

class SignInCancelled extends Error { constructor() { super('Sign-in was cancelled'); this.name = 'SignInCancelled'; } }
/** kind: 'expired' | 'declined' | 'personal' | 'misconfigured' | 'unusable' | 'storage' | 'other' */
class SignInFailed extends Error { constructor(kind, message) { super(message || kind); this.name = 'SignInFailed'; this.kind = kind; } }

const graphScope = (name) => (name === 'offline_access' ? name : 'https://graph.microsoft.com/' + name);

/** What a token says about itself. The signature is not checked: chirp only reads its own tokens. */
function claims(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    if (!p || typeof p !== 'object') return null;
    return { appid: p.appid || p.azp || null, tid: p.tid || null, oid: p.oid || null, upn: p.upn || p.preferred_username || null, name: p.name || null };
  } catch (_) { return null; }
}

const accountOf = (token, tenant) => { const c = claims(token); return c && c.oid ? { id: c.oid, username: c.upn, name: c.name, tenantId: c.tid || tenant || null } : null; };

/** The token file another tool keeps (design 101, "Signing in"), as an Auth. */
function createTokenFileAuth({ file, fetch }) {
  const store = createTokenStore({ file, fetch });
  let last = null;
  const keep = (t) => { last = t; return t; };
  return {
    method: 'tokenFile',
    accessToken: async () => keep(await store.accessToken()),
    refresh: async () => keep(await store.refresh()),
    tenantId: () => store.tenantId(),
    account: () => (last ? accountOf(last, store.tenantId()) : null),
    async signIn() { keep(await store.accessToken()); },
    hasChannels: () => true,   // whatever the other tool's token carries; a 403 turns channels off
    async signOut() { last = null; },   // never touches the file
  };
}

const FALLBACK_NOTE = "Your editor's Microsoft sign-in can't be used; using a sign-in code";

/**
 * Picks the way to sign in (design 201, "Choosing a way"), building each method only when it's needed.
 * @param o.method   'auto' | 'editor' | 'deviceCode' | 'tokenFile'
 * @param o.tokenFile  the configured path, or ''
 * @param o.make*    build a method's Auth (makeEditor may return null: the editor has no Microsoft provider)
 * @param o.onNote   tells the user when auto moves on to a sign-in code
 * @returns an Auth that forwards to the method in use, plus current()
 */
function createAuth({ method = 'auto', tokenFile = '', makeEditor, makeDeviceCode, makeTokenFile, onNote = () => {} }) {
  const makers = { editor: makeEditor, deviceCode: makeDeviceCode, tokenFile: makeTokenFile };
  const built = {};
  const get = (name) => { if (!(name in built)) built[name] = makers[name] ? makers[name]() : null; return built[name]; };
  const order = () => {
    if (tokenFile && (method === 'auto' || method === 'tokenFile')) return ['tokenFile'];
    if (method === 'auto') return ['editor', 'deviceCode'];
    return [method];
  };
  let active = null;

  async function signIn(opts = {}) {
    if (active) return active.signIn(opts);   // the channel step, or signing in again: the same method
    const names = order();
    for (let i = 0; i < names.length; i++) {
      const m = get(names[i]);
      if (!m) continue;
      try { await m.signIn(opts); active = m; return; }
      catch (e) {
        const more = i < names.length - 1 && method === 'auto';
        if (more && e instanceof SignInFailed && e.kind === 'unusable') { onNote(FALLBACK_NOTE); continue; }
        throw e;   // cancelling never moves on to another method
      }
    }
    throw new SignInNeeded();
  }

  /** Before any sign-in in this window: a method that already holds a session (a restart) is used. */
  async function restore() {
    for (const name of order()) {
      const m = get(name);
      if (!m) continue;
      try { const t = await m.accessToken(); active = m; return t; }
      catch (e) { if (!(e instanceof SignInNeeded)) { active = m; throw e; } }
    }
    throw new SignInNeeded();
  }

  return {
    get method() { return active ? active.method : null; },
    current: () => active,
    signIn,
    accessToken: () => (active ? active.accessToken() : restore()),
    refresh: () => (active ? active.refresh() : restore()),
    tenantId: () => (active ? active.tenantId() : null),
    account: () => (active ? active.account() : null),
    hasChannels: () => (active ? active.hasChannels() : false),
    async signOut() { if (active) await active.signOut(); active = null; },
  };
}

module.exports = { CHIRP_CLIENT_ID, createAuth, FALLBACK_NOTE, AUTHORITY, CHAT_SCOPES, CHANNEL_SCOPES, graphScope, claims, accountOf, createTokenFileAuth, SignInNeeded, Offline, SignInCancelled, SignInFailed };
