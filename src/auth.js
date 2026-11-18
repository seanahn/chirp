'use strict';
// Signing in (design 201). Every way to sign in returns the same Auth object, which the rest of chirp uses for tokens:
//   { method, accessToken(), refresh(), tenantId(), account(), signIn(opts), hasChannels(), signOut() }
const { createTokenStore, SignInNeeded, Offline } = require('./tokenStore');

/** chirp's app registration in Microsoft Entra: multitenant, a public client. Not a secret. */
const CHIRP_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
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

module.exports = { CHIRP_CLIENT_ID, AUTHORITY, CHAT_SCOPES, CHANNEL_SCOPES, graphScope, claims, accountOf, createTokenFileAuth, SignInNeeded, Offline, SignInCancelled, SignInFailed };
