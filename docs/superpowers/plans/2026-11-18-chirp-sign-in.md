# chirp sign-in and Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trivialpowers:subagent-driven-development (recommended) or trivialpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chirp signs in to Microsoft by itself, by any of three methods (the editor's Microsoft provider, device code, or an existing token file), so people at any company can use it, and it's ready for the Marketplace.

**Architecture:** Each method is a module that returns the same `Auth` object. `src/auth.js` picks one by `chirp.signIn.method`, and `graph.js` and the rest of chirp use that object where they now use the token store. The sidebar gains signed-out, waiting, device-code and account states, and an "Enable channels" step.

**Tech Stack:** as in 0.1.x: plain CommonJS, no runtime dependencies, `node:test`, jsdom for page tests; VS Code API `authentication.getSession` and `ExtensionContext.secrets`.

**Spec:** `docs/notes/201-sign-in.md` (and `docs/notes/101-design.md` for everything it doesn't change)

The design holds every design decision; this plan holds build steps and
code-level names only, and is deleted when the work merges. If a decision
changes during the build, change the design in the same commit.

## Global Constraints

- No runtime dependencies. Tests never touch the network: Microsoft's endpoints, the editor's provider and secret storage are all faked.
- Nothing in chirp's code, docs, defaults or messages names a company, an internal tool, or a person.
- Tokens are stored only in `context.secrets` (key `chirp.deviceCode.tokens`) or in the token file the user named; the token-file rules of 101 ("Signing in") are unchanged.
- Authority: `https://login.microsoftonline.com/organizations/oauth2/v2.0` (work and school accounts only).
- Chat permissions: `User.Read`, `Chat.ReadWrite`, `ChatMessage.Send`, `offline_access`. Channel permissions: `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `ChannelMessage.Send`.
- Settings: `chirp.signIn.method` (`auto` | `editor` | `deviceCode` | `tokenFile`, default `auto`), `chirp.signIn.tokenFile` (string, default `""`), `chirp.agentFiles` (boolean, default `true`).
- Messages are copied exactly from 201's "When signing in fails" table and its quoted strings.
- Version 0.2.0. Publishing (`make publish`) only with Sean's explicit go.
- Work on branch `sign-in`, committing after each task.

## Review Focus

1. **Two windows sign in with device code at once, or one window refreshes while another reads:** both end up signed in, and no window keeps a token the other replaced. (Task 2 test `a refresh in another window is picked up`.)
2. **The method setting changes while signed in** (say `auto` to `tokenFile`): chirp switches at once and doesn't keep polling with the old method's token. (Task 5 test `changing the method signs in again with the new one`.)
3. **Secret storage is unavailable** (Linux with no keyring: `secrets.store` throws): device-code sign-in says so instead of failing silently. (Task 2 test `secret storage failing is reported`.)
4. **`chirp.agentFiles` is turned off while tabs are open:** no file is written after that, and `chirp.activeConversationFile` returns null. (Task 7 test `turning agent files off stops writing at once`.)
5. **A token-file login without channel permissions:** chats work, and the Teams section shows the reason instead of an empty list. (Task 5 test `token file without channel permission shows the reason`.)

---

### Task 1: The Auth interface, scopes, and the token-file method behind it

**Files:**
- Create: `src/auth.js`, `test/auth.test.js`
- Modify: `src/tokenStore.js` (add `account()`), `src/graph.js` (doc comment only: it takes an `Auth`)

**Interfaces:**
- Produces (`src/auth.js`):
  - `CHIRP_CLIENT_ID` (string; placeholder `'00000000-0000-0000-0000-000000000000'` until Task 9).
  - `AUTHORITY`, `CHAT_SCOPES`, and `CHANNEL_SCOPES` (arrays of the names in Global Constraints).
  - `graphScope(name)`, which returns `name` for `offline_access` and `'https://graph.microsoft.com/' + name` otherwise.
  - `claims(jwt) => { appid, tid, oid, upn, name } | null`. It base64url-decodes the payload, with no signature check; `appid` falls back to `azp`.
  - Errors:
    - `SignInNeeded` and `Offline`, re-exported from `tokenStore.js`;
    - `class SignInCancelled extends Error`;
    - `class SignInFailed extends Error { kind }`, where `kind` is one of `'expired' | 'declined' | 'personal' | 'misconfigured' | 'unusable' | 'storage' | 'other'`.
  - `createTokenFileAuth({ file, fetch })`, which returns `Auth`.
- **`Auth`**, the shape every method returns:

  ```
  { method: 'editor'|'deviceCode'|'tokenFile',
    accessToken(): Promise<string>, refresh(): Promise<string>, tenantId(): string|null,
    account(): { id, username, name, tenantId } | null,
    signIn({ channels: boolean, newAccount: boolean, cancel: { isCancellationRequested, onCancellationRequested } }): Promise<void>,
    hasChannels(): boolean, signOut(): Promise<void> }
  ```

  - For `tokenFile`:
    - `signIn` throws `SignInNeeded` if the file can't be read.
    - `hasChannels()` is `true`, since its permissions are whatever the file's token has.
    - `signOut` does nothing to the file.
    - `account()` comes from the token's claims.

- [ ] **Step 1: Write the failing tests in `test/auth.test.js`:**
  - `graph scopes are prefixed, offline_access is not`.
  - `claims reads appid, falling back to azp`, using a token built in the test from base64url JSON.
  - `claims of garbage is null`.
  - `token-file auth reads the account from the token`.
  - `token-file signOut leaves the file alone`.
  - `scopes are exactly the design's`: `assert.deepStrictEqual(CHAT_SCOPES, ['User.Read','Chat.ReadWrite','ChatMessage.Send','offline_access'])`, and the same for `CHANNEL_SCOPES`.
- [ ] **Step 2:** Run `npm run -s test`. Expected: the new tests FAIL (module not found).
- [ ] **Step 3:** Implement `src/auth.js` and `createTokenFileAuth`, which wraps `createTokenStore` and adds `account()`, `signIn`, `hasChannels` and `signOut`.
- [ ] **Step 4:** Run `npm run -s test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "auth: one interface, and the token file behind it"`

---

### Task 2: Device-code sign-in

**Files:**
- Create: `src/deviceCode.js`, `test/deviceCode.test.js`

**Interfaces:**
- Consumes: `AUTHORITY`, `graphScope`, `claims`, and the errors (Task 1).
- Produces: `createDeviceCodeAuth({ secrets, fetch, clientId, onCode, now = Date.now, sleep })`, which returns an `Auth` with `method: 'deviceCode'`.
  - `onCode({ userCode, verificationUri, expiresAt })` is called once the code is known; the extension shows it.
  - `secrets` is `{ get(key), store(key, value), delete(key), onDidChange(fn) }`.
- Behavior:
  - **signIn:** POST `${AUTHORITY}/devicecode` with form data `client_id` and `scope`. The scope is the chat scopes, plus the channel scopes when `channels`, joined by spaces. Then POST `${AUTHORITY}/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, every `interval` seconds:
    - `authorization_pending` keeps polling;
    - `slow_down` adds 5 s to the interval;
    - `expired_token` throws `SignInFailed('expired')`;
    - `authorization_declined` throws `SignInFailed('declined')`;
    - `invalid_client`, or an `error_description` containing `AADSTS7000218`, throws `SignInFailed('misconfigured')`;
    - an `error_description` containing `AADSTS50020` or `AADSTS9002331`, or mentioning a Microsoft account, throws `SignInFailed('personal')` *(guess, checked live in Task 9)*;
    - cancellation throws `SignInCancelled`.
  - **Stored tokens:** on success, store JSON `{ access_token, refresh_token, expires_at, tenant_id, scope, channels }` under `chirp.deviceCode.tokens`. A failing `secrets.store` throws `SignInFailed('storage')`.
  - **accessToken / refresh:** the token-file rules: refresh 60 s before expiry, one refresh in flight at a time.
    - `invalid_grant` deletes the stored tokens and throws `SignInNeeded`.
    - A network error throws `Offline` and keeps the tokens.
    - The refresh asks for the scope the tokens already have.
  - **Other windows:** `secrets.onDidChange` for this key drops the cached copy, so the next call rereads it.
  - **signOut** deletes the key.

- [ ] **Step 1: Write the failing tests**, with a fake `fetch` that answers per URL and a fake `secrets` backed by a `Map` that records `store` calls:
  - `sign-in polls until tokens arrive`: answers `pending`, `pending`, then tokens. `onCode` gets the user code; there are three token calls; the stored JSON has `channels: false`.
  - `slow_down adds five seconds`: the recorded sleeps are `[5000, 10000]` for interval 5.
  - `expired, declined and misconfigured map to SignInFailed kinds`: one case per error.
  - `cancel stops polling`.
  - `channels sign-in asks for both scope sets`.
  - `refresh near expiry updates secret storage`.
  - `invalid_grant on refresh signs out`: the key is deleted and `SignInNeeded` is thrown.
  - `network error on refresh is Offline and keeps tokens`.
  - `a refresh in another window is picked up`: change the Map and fire `onDidChange`; `accessToken()` returns the new token.
  - `secret storage failing is reported`: `store` throws, giving `SignInFailed` with `kind 'storage'`.
- [ ] **Step 2:** Run `npm run -s test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement `src/deviceCode.js`. Refresh shares the request-and-merge logic with `tokenStore.js` where the shapes allow; otherwise it's a small local function. Don't change `tokenStore.js`'s behavior.
- [ ] **Step 4:** Run `npm run -s test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "auth: device-code sign-in with tokens in secret storage"`

---

### Task 3: The editor's Microsoft provider

**Files:**
- Create: `src/editorAuth.js`, `test/editorAuth.test.js`

**Interfaces:**
- Consumes: `claims`, `CHAT_SCOPES`, `CHANNEL_SCOPES`, and the errors (Task 1).
- Produces: `createEditorAuth({ authentication, clientId, state })`, which returns an `Auth` with `method: 'editor'`.
  - `authentication` is `vscode.authentication`.
  - `state` is a memento (`context.globalState`): `get`/`update`, keys `chirp.editorAuth.signedOut` and `chirp.editorAuth.channels`.
- Behavior:
  - **Scopes:** every request is `['VSCODE_CLIENT_ID:' + clientId, 'VSCODE_TENANT:organizations', ...CHAT_SCOPES, ...(channels ? CHANNEL_SCOPES : [])]`.
  - **signIn:** `getSession('microsoft', scopes, { createIfNone: true, clearSessionPreference: newAccount })`, with the cancellation token passed in.
    - A rejection whose message matches `/cancel/i` throws `SignInCancelled`. Any other rejection throws `SignInFailed('unusable')`.
    - If `claims(accessToken).appid !== clientId`, it throws `SignInFailed('unusable')` and keeps nothing.
    - On success it sets `signedOut` to false and records `channels`.
  - **accessToken:** `getSession('microsoft', scopes, { silent: true })`, where `scopes` includes the channel scopes if recorded. No session, or `signedOut` set, throws `SignInNeeded`.
  - **refresh:** the same silent call. The provider refreshes tokens itself.
  - **signOut:** sets `signedOut` to true. VS Code has no API to remove a session.

- [ ] **Step 1: Write the failing tests**, with a fake `authentication.getSession` that records its calls:
  - `scopes carry chirp's app id and tenant`.
  - `cancel is SignInCancelled, other errors unusable`.
  - `a token for another app is refused`.
  - `signOut then accessToken needs sign-in`.
  - `sign-in after sign-out offers the account picker`: `clearSessionPreference: true` when `newAccount`.
  - `channels are remembered for later calls`.
- [ ] **Step 2:** Run `npm run -s test`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/editorAuth.js`.
- [ ] **Step 4:** Run `npm run -s test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "auth: sign in through the editor's Microsoft provider"`

---

### Task 4: Choosing the method

**Files:**
- Modify: `src/auth.js`, `test/auth.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `createAuth({ method, tokenFile, makeEditor, makeDeviceCode, makeTokenFile, onNote })`, which returns `Auth & { current(): Auth|null }`.
  - The `make*` functions build each method lazily.
  - `onNote(text)` reports a switch, for example the exact text "Your editor's Microsoft sign-in can't be used; using a sign-in code".
- The rules are 201's "Choosing a way":
  - With `tokenFile` set and `method` `auto` or `tokenFile`, use the token file.
  - Otherwise `auto` tries the editor. If that throws `SignInFailed('unusable')`, it calls `onNote` and signs in with device code.
  - `SignInCancelled` propagates and doesn't move on to device code.
  - An explicit method uses only that method.
  - Every `Auth` call goes to the method that signed in. Before any sign-in, the methods already holding a session are tried in the same order with `accessToken()`, so a restart stays signed in.

- [ ] **Step 1: Write the failing tests:**
  - `auto prefers a configured token file`.
  - `auto falls back to device code when the editor is unusable, with the note`.
  - `cancel does not fall back`.
  - `explicit deviceCode never touches the editor`.
  - `a restart finds the existing device-code session`.
- [ ] **Step 2:** Run `npm run -s test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run -s test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "auth: choose the sign-in method"`

---

### Task 5: Wiring sign-in into the extension

**Files:**
- Modify: `src/extension.js`, `src/conversation.js` (`tenantId` comes from the `Auth`), `package.json` (settings and commands), `test/host.test.js`, `test/vscodeStub.js` (adds `authentication.getSession`, `secrets`, `workspace.onDidChangeConfiguration`, and `env.clipboard`)

**Interfaces:**
- Consumes: `createAuth` (Task 4).
- Produces:
  - **Commands:** `chirp.signIn`, `chirp.signOut`, `chirp.enableChannels`, `chirp.cancelSignIn`.
  - **`activate` deps** gain `authentication`, `secrets`, `clientId`, and `config` (an object read in place of `getConfiguration('chirp')` in tests). `deps.tokenFile` remains as a test override.
  - **Sidebar state** gains `account: { username, method } | null`, `signIn: null | { stage: 'signedOut' | 'waiting' | 'code', userCode?, verificationUri? }`, and `channels: 'enabled' | 'off' | 'failed' | 'forbidden'`. Task 6 draws these.
- Behavior:
  - **Signed out:** the lists are hidden and the sidebar shows `signIn.stage: 'signedOut'`. The 0.1.x token-file message stays for the token file, as "Sign in with the tool that keeps <file>", and the polling recovery from 101 still applies to it.
  - **chirp.signIn:**
    - Show `waiting` (or `code` once `onCode` fires) and call `signIn({ channels: rememberedChannels, newAccount: afterSignOut })`.
    - If `channels` is remembered, sign in with the chat scopes first, then request the channels separately. A failure there leaves chats signed in and sets `channels: 'failed'`.
    - On success: fetch `/me`. If its id differs from the cached profile's, clear first (below). Then start the pollers.
  - **chirp.enableChannels:** `signIn({ channels: true })`. On success, set `channels: 'enabled'` and start the teams and mention pollers; on failure, `channels: 'failed'`. Until channels are enabled, those two pollers don't run for the `editor` and `deviceCode` methods.
  - **chirp.signOut:** `auth.signOut()`, stop the pollers, then clear:
    - the `chirp.lists` and `chirp.mentions` global state;
    - every file chirp wrote under the mirror directory. Add `mirror.clearAll()` in Task 7; until then, call it if present.
    - the open conversation tabs, which are closed.

    The sidebar shows `signedOut`.
  - **Token file without channel permission:** a 403 from `/me/joinedTeams` sets `channels: 'forbidden'` and stops the teams poller.
  - **Changing settings:** a change to `chirp.signIn.*` stops the pollers, rebuilds `createAuth`, and signs in again silently if the new method has a session; otherwise the sidebar shows `signedOut`.

- [ ] **Step 1: Write the failing host tests:**
  - `signed out at first: the sidebar asks to sign in, no Graph calls`.
  - `sign in with device code shows the code, then the chats`.
  - `channels wait for Enable channels`.
  - `enable channels failing keeps chats and offers the admin link`: state `channels: 'failed'`.
  - `sign out clears lists, mentions, files and tabs`.
  - `a different account clears the old one's data first`.
  - `changing the method signs in again with the new one`.
  - `token file without channel permission shows the reason`.
  - Update the 0.1.x host tests to set `config: { 'signIn.tokenFile': tokenFile }`, so they run unchanged under the token-file method.
- [ ] **Step 2:** Run `npm run -s test`. Expected: the new tests FAIL; the updated old ones pass.
- [ ] **Step 3:** Implement. In `package.json`:
  - add the three settings, with descriptions from 201;
  - add the four commands, with titles `chirp: Sign In`, `chirp: Sign Out`, `chirp: Enable Channels`, `chirp: Cancel Sign-in`;
  - add `chirp.signIn` and `chirp.signOut` to the view's title menu.
- [ ] **Step 4:** Run `make check && npm run -s test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "sign-in wired in: commands, settings, channels step, sign-out clears"`

---

### Task 6: The sidebar's sign-in states

**Files:**
- Modify: `media/sidebar.js`, `media/sidebar.css`, `src/sidebar.js` (forwards the new page messages), `test/sidebarPage.test.js`

**Interfaces:**
- Consumes: the sidebar state from Task 5.
- Produces page to host messages: `{ type: 'signIn' }`, `{ type: 'cancelSignIn' }`, `{ type: 'copyCode' }` (the host copies the code and opens the verification URI), `{ type: 'enableChannels' }`, and `{ type: 'copyAdminLink' }`.
- What the page shows:
  - **`signedOut`:** a **Sign in to Microsoft** button in place of both lists.
  - **`waiting`:** "Waiting for sign-in in the browser…" and **Cancel**.
  - **`code`:** the user code, large; **Copy code & open**; "Enter it at <verificationUri>"; and **Cancel**.
  - **Account line** under the filter: "Signed in as <username> (<method>)", where `method` is shown as `editor`, `sign-in code`, or `token file`.
  - **Teams section** by `channels`:
    - `off`: **Enable channels**.
    - `failed`: "Channels weren't enabled. If your company requires an admin to approve chirp, send them this link.", with **Copy admin link** and **Try again**.
    - `forbidden`: "Channels need permissions this login doesn't have."

- [ ] **Step 1: Write the failing page tests:**
  - one per state, each checking its exact text and that its buttons post the right message;
  - `the lists are hidden while signed out`;
  - `the user code is text, never html`.
- [ ] **Step 2:** Run `npm run -s test`. Expected: FAIL.
- [ ] **Step 3:** Implement with `textContent` only, using theme variables as in 0.1.x.
- [ ] **Step 4:** Run `make check && npm run -s test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "sidebar: sign-in, sign-in code, account and channels states"`

---

### Task 7: Agent files for everyone

**Files:**
- Modify: `src/mirror.js`, `src/conversation.js`, `src/extension.js`, `test/mirror.test.js`, `test/host.test.js`

**Interfaces:**
- Produces:
  - `createMirror({ dir, enabled: () => boolean })`. When `enabled()` is false, `write` and `setCurrent` do nothing and `pathFor` returns null.
  - `mirror.clearAll()`, which deletes every file this mirror wrote and `current.teams`.
- The header text is exactly as in 201's "The ~/.chirp files for everyone". For chats: `# use a Microsoft Graph tool (for example a Microsoft 365 MCP server) with the chat id above.` For channels: `# Older posts, and replies: use a Microsoft Graph tool (for example a Microsoft 365 MCP server) with the ids above.`

- [ ] **Step 1: Write the failing tests:**
  - `headers name no particular tool`: no `ms365`, no `list-chat-messages`, and the new lines are present.
  - `disabled mirror writes nothing`.
  - `clearAll removes what it wrote`.
  - Host: `turning agent files off stops writing at once`. Toggle `config['agentFiles']` and fire the configuration change; poll; no file changed, and `chirp.activeConversationFile` is null.
- [ ] **Step 2:** Run `npm run -s test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update 101's "The file format" example header to the new wording in the same commit.
- [ ] **Step 4:** Run `npm run -s test`. Expected: all pass.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "agent files: generic header, a setting to turn them off, cleared on sign-out"`

---

### Task 8: README, listing icon, 0.2.0

**Files:**
- Modify: `README.md`, `docs/notes/901-setup.md`, `package.json`
- Create: `media/listing-icon.png` (128×128), `media/listing-icon.svg` (its source)

**Interfaces:** none.
- **README:**
  - A **"Signing in"** section, exactly as 201's "The README's sign-in section" describes. It covers the three methods, the settings, the permission table, the admin consent link with `CHIRP_CLIENT_ID`, and the publisher-verification caveat.
  - A **"What chirp writes to disk"** paragraph: `~/.chirp`, and `chirp.agentFiles`.
  - A line saying chirp is not made by or affiliated with Microsoft.
  - No company names.
- **901-setup:** rewritten for the three methods.
- **package.json:**
  - `"version": "0.2.0"`;
  - `"icon": "media/listing-icon.png"`;
  - a `description` ending "Not affiliated with Microsoft.";
  - `"categories": ["Other"]` and `"keywords": ["teams", "chat", "microsoft 365", "agent"]`.
- **Listing icon:** a speech bubble with a small bird, distinct from Teams' logo. Draw it as SVG and render it to PNG with headless Chrome, as was done for the Activity Bar icon. That's a development step only, not a dependency. The Activity Bar and tab icons stay as they are.

- [ ] **Step 1: Write a failing test `test/manifest.test.js`:**
  - `package.json has the listing icon and the new settings`: the icon file exists and is a PNG (it starts with the PNG signature); the three settings have the defaults from Global Constraints; the version is `0.2.0`.
  - `no company or tool names ship`: scan every file `vsce` would package (`git ls-files` minus `.vscodeignore` patterns) for `ms365`, `zig` and `c3`, case-insensitive. Expect none.
- [ ] **Step 2:** Run `npm run -s test`. Expected: FAIL.
- [ ] **Step 3:** Make the edits and render the PNG.
- [ ] **Step 4:** Run `npm run -s test && npx --yes @vscode/vsce package --out /tmp/chirp-0.2.0.vsix`. Expected: tests pass and the package builds with no warnings.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "0.2.0: README sign-in options, listing icon"`

---

### Task 9: Live checks with Sean (chirp's app id, real sign-ins)

**Files:**
- Modify: `src/auth.js` (`CHIRP_CLIENT_ID`), `docs/notes/201-sign-in.md` (outcomes)

- [ ] **Step 1: Sean registers chirp's app** by 201's steps and gives the Application (client) ID. Check the redirect URI the bundled provider uses: read `/usr/share/code/resources/app/extensions/microsoft-authentication/dist/extension.js` for `vscode.dev/redirect` or a loopback, and tell Sean if a second redirect URI is needed.
- [ ] **Step 2:** Set `CHIRP_CLIENT_ID`. Run `npm run -s test` (expected: pass), then commit.
- [ ] **Step 3:** Run `make install` and ask Sean to reload. Sean signs in with each method, setting `chirp.signIn.method` to `editor` and then `deviceCode`, ideally with a work account outside his company if he has one, otherwise his own. Check each time: the chat list loads, **Enable channels** behaves, Sign Out clears, and VS Code and Cursor both work.
- [ ] **Step 4:** Record what Microsoft actually returns in 201: the admin-approval behavior, the personal-account error code, and any unusual error text. Fix the Task 2 error mapping if it differs, with a failing test first.
- [ ] **Step 5:** Sean's company setup: `chirp.signIn.tokenFile` set to his existing token file still works. Commit.

---

### Task 10: Closing (design, PR, plan deleted, publish on Sean's go)

**Files:**
- Modify: `docs/notes/201-sign-in.md`, `docs/notes/101-design.md` (the sign-in section points to 201)
- Delete: `docs/superpowers/plans/2026-11-18-chirp-sign-in.md`

- [ ] **Step 1:** Make 201 describe what was built: copy over the rulings from the build. 201 links to the README, and the README links to 201 and 101.
- [ ] **Step 2:** Run `npm run -s test`. Expected: all pass. Commit, and record that SHA, the last commit that contains the plan.
- [ ] **Step 3:** Push `sign-in` as `seanahn`, the same way as the first push, and open a PR to `main`. Record the PR number and the Step 2 SHA in 201. Delete this plan, commit and push.
- [ ] **Step 4: Ask Sean** for the go to publish. With it, run `make publish`. Then check the listing at `https://marketplace.visualstudio.com/items?itemName=seanahn.chirp`.
