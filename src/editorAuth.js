'use strict';
// Sign-in through the editor's own Microsoft account provider (design 201, "1. Built-in Microsoft sign-in"), with chirp's
// app id passed in the provider's special VSCODE_CLIENT_ID / VSCODE_TENANT scopes. The editor keeps and refreshes the tokens.
const { CHAT_SCOPES, CHANNEL_SCOPES, claims, accountOf, SignInNeeded, SignInCancelled, SignInFailed } = require('./auth');

const SIGNED_OUT = 'chirp.editorAuth.signedOut';
const CHANNELS = 'chirp.editorAuth.channels';

function createEditorAuth({ authentication, clientId, state }) {
  let token = null;
  const scopes = (channels) => ['VSCODE_CLIENT_ID:' + clientId, 'VSCODE_TENANT:organizations', ...CHAT_SCOPES, ...(channels ? CHANNEL_SCOPES : [])];
  const channelsOn = () => !!state.get(CHANNELS);

  async function signIn({ channels = false, newAccount = false, cancel } = {}) {
    let s;
    try {
      const asking = authentication.getSession('microsoft', scopes(channels), Object.assign({ createIfNone: true }, newAccount ? { clearSessionPreference: true } : {}));
      // getSession takes no cancellation token: Cancel stops chirp waiting, and the editor's own prompt can be dismissed
      s = cancel ? await Promise.race([asking, new Promise((_, reject) => cancel.onCancellationRequested(() => reject(new SignInCancelled())))]) : await asking;
    } catch (e) {
      if (e instanceof SignInCancelled || /cancel/i.test(String(e && e.message))) throw new SignInCancelled();
      throw new SignInFailed('unusable', String(e && e.message || e));
    }
    if (!s || !s.accessToken) throw new SignInCancelled();
    // a provider that ignored VSCODE_CLIENT_ID would hand back a token for its own app: not chirp's to use
    const c = claims(s.accessToken);
    if (!c || c.appid !== clientId) throw new SignInFailed('unusable', "The editor's Microsoft sign-in didn't use chirp's app.");
    token = s.accessToken;
    await state.update(SIGNED_OUT, false);
    await state.update(CHANNELS, !!channels);   // what this session covers; the extension remembers separately that channels were wanted
  }

  async function silent() {
    if (state.get(SIGNED_OUT)) throw new SignInNeeded();
    let s;
    try { s = await authentication.getSession('microsoft', scopes(channelsOn()), { silent: true }); } catch (_) { s = null; }
    if (!s || !s.accessToken) throw new SignInNeeded();
    token = s.accessToken;
    return token;
  }

  return {
    method: 'editor', signIn,
    accessToken: silent,
    refresh: silent,   // the provider refreshes its tokens itself; asking again returns the current one
    tenantId: () => { const a = token && accountOf(token); return a ? a.tenantId : null; },
    account: () => (token ? accountOf(token) : null),
    hasChannels: channelsOn,
    async signOut() { token = null; await state.update(SIGNED_OUT, true); },   // VS Code can't remove a session; chirp stops using it
  };
}

module.exports = { createEditorAuth, SIGNED_OUT, CHANNELS };
