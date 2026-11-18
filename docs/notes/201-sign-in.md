# 201 — Sign-in

How chirp signs in to Microsoft so people at any company can use it, and
what publishing it to the VS Code Marketplace takes. Written 2026-11-18.
It extends [101](101-design.md), which covers what chirp is and does.
Calls marked *(builder's call)* were made while writing this note, not by
Sean; everything else is his.

## Why

chirp 0.1.1 has no sign-in of its own. It reads the token file one
particular MCP server keeps, which only people who run that server have.
Sean wants chirp on the Marketplace for **people at other companies**, so
chirp must sign in by itself, in VS Code and in Cursor.

## Goals

- Anyone with a work or school Microsoft 365 account can install chirp
  and sign in from inside the editor, with no other tool.
- chirp works in VS Code and in Cursor.
- The README lists every way to sign in, so a company with its own setup
  can pick one.
- Where a company hasn't approved the channel permissions, chats still
  work, and chirp says why channels are missing.

## Non-goals

- Personal Microsoft accounts (outlook.com, Teams free). Graph's Teams
  calls used here are for work and school accounts.
- Instructions for any particular company. Sean will document his own
  company's setup in that company's repo, not here.
- Admin-consent tooling inside chirp: chirp explains what an admin must
  approve, and the admin approves it in Entra.

## Anti-goals

- chirp storing tokens anywhere but the editor's secret storage, or the
  token file the user named.
- Breaking the token-file setup that works today.
- A sign-in that fails silently: every failure says what happened and
  what to do next.
- chirp naming any company, internal tool or person in its code, docs or
  defaults.

## The three ways to sign in

### 1. Built-in Microsoft sign-in (the default)

chirp asks the editor's own Microsoft account provider for a session:

```js
vscode.authentication.getSession('microsoft', [
  'VSCODE_CLIENT_ID:<chirp app id>', 'VSCODE_TENANT:organizations',
  'offline_access', ...scopes,
], { createIfNone: true })
```

The editor shows its usual "chirp wants to sign in using Microsoft"
prompt, opens the browser, keeps the tokens and refreshes them.

- **Verified on this machine (2026-11-18):** the `VSCODE_CLIENT_ID:` and
  `VSCODE_TENANT:` scopes are understood by the `microsoft-authentication`
  extension bundled with VS Code 1.129.1 and with Cursor 3.12.17.
- **Risk:** those two scopes are undocumented; they come from the
  provider's source. If a release drops them, option 2 takes over (see
  "Choosing a way").
- `offline_access` is required: without it, the session is lost at the
  next window reload.

### 2. Device-code sign-in (the fallback)

chirp runs the OAuth device-code flow itself, against
`https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode`
then `…/token`, with chirp's app id and no secret (a public client).

- chirp shows the code in the sidebar, with a button that copies it and
  opens `https://microsoft.com/devicelogin`. The code and link are also in
  a notification *(builder's call)*.
- chirp polls the token endpoint at the interval Microsoft returns,
  until the code expires.
- Tokens go in the editor's secret storage (`context.secrets`, key
  `chirp.deviceCode.tokens`): access token, refresh token, expiry, tenant
  id. chirp refreshes them itself with the same rules as the token file
  in 101: a minute before expiry, one in-flight refresh, a 401 refreshes
  once.
- Secret storage is shared by all windows of the editor. When one window
  refreshes, the others reread it (`context.secrets.onDidChange`).

### 3. An existing token file

What chirp 0.1.1 does, made general. The user points chirp at a token
file another tool keeps, and chirp reuses that login.

- The file holds `access_token`, `refresh_token`, `client_id`,
  `tenant_id` and `expires_at` (Unix seconds). Every rule from 101's
  "Signing in" section still applies:
  - reread before each request;
  - refresh with that file's own client id and tenant;
  - write back by temp file and rename, mode 600;
  - a newer token in the file wins;
  - never sign in through it.
- The path is the setting `chirp.signIn.tokenFile`. It's empty by
  default, and nothing in chirp names any particular tool or file.
- **There's no migration from 0.1.x** *(builder's call)*: 0.1.x read one
  fixed file. Someone upgrading sets `chirp.signIn.tokenFile` to that
  file, or signs in another way. Sean's note for his company covers this
  for his colleagues. The anti-goal "breaking the token-file setup" means
  the method keeps working once it's configured.

## Choosing a way

Setting `chirp.signIn.method`: `auto` (default), `editor`, `deviceCode`,
or `tokenFile`.

`auto` picks:

1. `tokenFile`, if `chirp.signIn.tokenFile` is set;
2. `editor`, if the Microsoft provider is present and accepts chirp's app
   id;
3. `deviceCode` otherwise.

`auto` decides once per sign-in, not per request. It moves from `editor`
to `deviceCode`, and says so in the sidebar, in either of these cases
*(builder's call)*:

- `getSession` throws an error that isn't the user cancelling;
- the token it returns wasn't issued to chirp's app. Its `appid` (or
  `azp`) claim isn't `CHIRP_CLIENT_ID`, which is what a provider that
  ignored `VSCODE_CLIENT_ID:` would do. chirp discards that token.

Finding out this way can cost one browser round-trip that fails. That's
accepted, since it can only happen after a future editor release changes
the provider.

While the editor's prompt or the browser is open, the sidebar shows
"Waiting for sign-in in the browser…" with **Cancel**. `getSession` gets a
cancellation token, so Cancel ends it. If the user just closes the
browser, Cancel is the way out.

## Commands and what the sidebar shows

- **chirp: Sign In** starts the chosen method. While signed out, the
  sidebar shows a **Sign in to Microsoft** button in place of the lists.
- **chirp: Sign Out** forgets chirp's own tokens. It never edits or
  deletes a token file. The sidebar shows the Sign in button again.
  - **Device code:** the tokens are deleted from secret storage.
  - **Editor:** VS Code gives extensions no way to remove a session. chirp
    records "signed out" in its global state and stops using the session.
    The next Sign In passes `clearSessionPreference: true`, so the editor
    offers an account picker instead of silently reusing the same
    account *(builder's call)*.
  - **In every case, Sign Out also clears what chirp keeps about the
    account** *(builder's call, for shared machines)*:
    - the cached lists and profile;
    - the mention state;
    - every file chirp wrote under `~/.chirp`.
  - **A different account:** signing in as a different user id than last
    time clears the same things first.
  - **Other windows:** they notice the signed-out state at their next poll
    and show the Sign in button.
- The sidebar's status line names the signed-in account and the method,
  for example "Signed in as alex@contoso.com (editor)" *(builder's call:
  shown under the filter box, small)*.
- The existing "sign in needed" state from 101 stays for `tokenFile`,
  with the message "Sign in with the tool that keeps <file>".

## Permissions

chirp's app asks for delegated Graph permissions in two steps, so chats
never wait on an admin.

| Step | Permissions | Who can approve |
| --- | --- | --- |
| Chats | `User.Read`, `Chat.ReadWrite`, `ChatMessage.Send`, `offline_access` | usually the user, if their company allows user consent |
| Channels | `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `ChannelMessage.Send` | `ChannelMessage.Read.All` needs an admin |

- **Sign-in asks only for the chat permissions.** Chats, chat tabs,
  sending, read marking and chat mentions work with these.
- **Channels are a second request.** The Teams and Channels section shows
  **Enable channels**. That requests the channel permissions, using the
  same method as sign-in.
  - If an admin must approve, Microsoft says so in the browser. chirp
    usually can't tell that apart from the user cancelling or the code
    expiring: the editor reports a generic error, and a device code just
    stays pending. So on any failure, chirp shows the same neutral
    message *(builder's call)*: "Channels weren't enabled. If your company
    requires an admin to approve chirp, send them this link." It has a
    button that copies the admin consent link (below), and a **Try again**
    button.
  - Once granted, channels load as in 101 and the channel-mention search
    starts. chirp remembers that channels were enabled, and asks for the
    channel permissions again at the next sign-in, as a separate second
    request after the chat permissions. If that second request fails, for
    example because consent was revoked, chats still come up and the
    Teams section shows **Enable channels** again *(builder's call)*.
- **Channel mentions** (search) need `ChannelMessage.Read.All` too, so
  they run only once channels are enabled.
- **The token-file method has no steps.** It gets whatever permissions
  the other tool's token carries. A call that fails for lack of a
  permission (403) turns off that feature, with the reason shown, as in
  101 for posting.

**Admin consent link:**
`https://login.microsoftonline.com/organizations/adminconsent?client_id=<chirp app id>`.
The README tells admins what each permission is for.

**Publisher verification.** Many companies block users from approving apps
by unverified publishers. Verification needs a Microsoft Partner Network
account, which Sean doesn't have yet. Until then, at those companies,
even the chat step needs an admin. The README says so plainly. Getting
verified is outside this note.

## When signing in fails

Each case gets a message in the sidebar, with the next step
*(builder's calls)*.

| Case | Under | Message and next step |
| --- | --- | --- |
| User cancels | editor, device code | back to the **Sign in** button, no error |
| Device code expires (about 15 min) | device code | "Sign-in code expired." **Sign in** again |
| User declines (`authorization_declined`) | device code | "Sign-in was declined." **Sign in** again |
| Personal Microsoft account | editor, device code | "chirp needs a work or school Microsoft 365 account." |
| App misconfigured (`AADSTS7000218` / `invalid_client`: public client flows off) | device code | "chirp's app registration doesn't allow device sign-in (AADSTS7000218)." Logged in full. A setup mistake on chirp's side, fixed in Entra. |
| Network down while polling or refreshing | device code, token file | keep the tokens; "Offline, retrying", with backoff as in 101 |
| Refresh token refused (`invalid_grant`) | device code | tokens deleted; "Signed out: sign in again", with the **Sign in** button |
| Graph returns 401 | editor | ask for the session again without prompting (`getSession` with `silent: true`), retry once; if no session comes back: **Sign in** button |
| Graph returns 401 | device code, token file | refresh once, retry once, as in 101 |
| Window reloads mid sign-in | device code | the flow is dropped; the sidebar shows **Sign in** |
| Secret storage unavailable (on Linux, no keyring) | device code | "chirp couldn't save your sign-in: the editor's secret storage isn't available. On Linux, install a keyring such as gnome-keyring." |
| Token file's login lacks channel permissions (403 on teams) | token file | Teams section: "Channels need permissions this login doesn't have." |

## Registering chirp's app (Sean, once)

In the Microsoft Entra admin center (entra.microsoft.com), signed in as
the account that publishes chirp, in that account's own directory (a
personal Microsoft account gets a "Default Directory"):

1. **App registrations → New registration.**
   - Name: `chirp`.
   - Supported account types: **Accounts in any organizational directory
     (multitenant)**.
   - Redirect URI: none for now.
2. **Authentication.**
   - Add a platform: **Mobile and desktop applications**, with redirect
     URI `https://vscode.dev/redirect`. That's the one VS Code's provider
     uses; check the provider's source at build time and add `http://localhost`
     if it uses a loopback.
   - Turn on **Allow public client flows**, which the device-code flow
     needs.
3. **API permissions:** add the delegated Microsoft Graph permissions in
   the table above. Don't grant admin consent in your own directory; it
   only applies there.
4. **Branding:** set the publisher domain, and the homepage URL
   `https://github.com/seanahn/chirp`.
5. Copy the **Application (client) ID**. It goes in chirp's source as a
   constant, `CHIRP_CLIENT_ID` in `src/auth.js`. It isn't a secret.

## The README's sign-in section

A section "Signing in" listing the three ways:

- what each way is;
- when to use it;
- how to choose it (`chirp.signIn.method`, `chirp.signIn.tokenFile`);
- the permission table, and what an admin must approve;
- the admin consent link;
- the publisher-verification caveat.

No company is named.

## Publishing to the Marketplace

- **Icon (Sean's decision):**
  - The Marketplace listing gets a distinct chirp mark: a 128×128 PNG,
    set as `icon` in `package.json`. It only hints at chat, for example a
    speech bubble with a small bird *(builder's call on the drawing)*.
  - Inside the editor, the Activity Bar and tab icons keep the Teams-like
    icon. The Teams-like one is too close to Microsoft's logo for a
    public listing.
- The Marketplace description says chirp is not made by Microsoft.
- The version bumps to 0.2.0, and `make publish` publishes. That needs
  Sean's explicit go.

## The ~/.chirp files for everyone

- **On by default (Sean's decision):** open conversations are still
  written to `~/.chirp` (mode 700/600), as in 101, so an agent beside
  chirp knows the open chat out of the box.
- **A setting turns it off:** `chirp.agentFiles` (default `true`). When
  `false`, chirp writes no files and `chirp.activeConversationFile`
  returns null.
- **The README and the listing say plainly** that open conversations are
  written to disk, and where.
- **The file header names no particular tool** *(builder's call)*. It
  reads: "Older messages, and replies: use a Microsoft Graph tool (for
  example a Microsoft 365 MCP server) with the chat id above." The
  channel header is changed the same way.
- **The perch hook stays:** `chirp.activeConversationFile` is harmless
  without perch.

## How it is built

- **`src/auth.js`** defines one interface that all three methods meet,
  `{ accessToken(), refresh(), account(), signOut() }`, plus the errors
  `SignInNeeded` and `Offline` from 101. `graph.js` uses it in place of
  the token store, unchanged otherwise.
- **The token-file method** is `src/tokenStore.js` as it is, behind that
  interface.
- **The device-code method** is a new `src/deviceCode.js`. It shares the
  refresh logic with `tokenStore.js` where it can.
- **The editor method** is a new `src/editorAuth.js`.
- **Tests** fake the editor's provider, the device-code and token
  endpoints, and secret storage. Nothing contacts Microsoft.
- **Live checks need Sean:** the app id, one sign-in by each method, and
  the admin-consent message.

Left to the builder: the module split within those files, the wording of
messages not quoted here, and how the device code is laid out in the
sidebar.

## Diagrams

Signing in with the editor's provider, then enabling channels where an
admin must approve:

```
 Sean        chirp sidebar   chirp host            editor MS provider        login.microsoftonline.com    Graph
  |               |               |                        |                            |                  |
  |-- Sign in --->|               |                        |                            |                  |
  |               |-- signIn ---->|                        |                            |                  |
  |               |<-- "Waiting for sign-in in the browser…" + Cancel                  |                  |
  |               |               |-- getSession(VSCODE_CLIENT_ID, VSCODE_TENANT:organizations,
  |               |               |     offline_access + chat scopes, createIfNone) ->|                  |
  |<-- editor prompt "chirp wants to sign in using Microsoft" -|                       |                  |
  |-- Allow ------------------------------------------------->|-- browser sign-in ---->|                  |
  |<-- browser: consent for chat permissions -------------------------------------------|                  |
  |-- Accept -------------------------------------------------------------------------->|                  |
  |               |               |<-- session ------------|<-- tokens -----------------|                  |
  |               |               |   [token appid != chirp's app id: discard; fall back to device code]   |
  |               |               |-- GET /me, /me/chats ---------------------------------------------->|
  |<-- chats; "Signed in as …" ---|                        |                            |                  |
  |-- Enable channels ->|         |                        |                            |                  |
  |               |-- enableChannels ->|                   |                            |                  |
  |               |               |-- getSession(… + channel scopes, createIfNone) --->|                  |
  |               |               |                        |-- browser sign-in -------->|                  |
  |               |               |   [admin approval needed, cancelled, or error]     |                  |
  |               |               |<-- error --------------|<-- "Need admin approval" --|                  |
  |<-- "Channels weren't enabled…" + Copy admin consent link + Try again               |                  |
  |               |               |   [granted]            |                            |                  |
  |               |               |<-- session ------------|                            |                  |
  |               |               |-- remember: channels enabled                       |                  |
  |               |               |-- GET /me/joinedTeams; start the channel-mention search ---------->|
```

The device-code fallback, when the editor's provider can't use chirp's
app id:

```
 Sean        chirp sidebar   chirp host         editor MS provider   secret storage   login.microsoftonline.com   Graph
  |               |               |                     |                  |                     |                |
  |-- Sign in --->|               |                     |                  |                     |                |
  |               |-- signIn ---->|                     |                  |                     |                |
  |               |               |-- getSession ------>|                  |                     |                |
  |               |               |<-- error (not cancel) or token for another app               |                |
  |               |<-- "Your editor's Microsoft sign-in can't be used; using a sign-in code"     |                |
  |               |               |-- POST /devicecode (client_id, offline_access + chat scopes) ->|              |
  |               |               |<-- user_code, verification_uri, interval, expires_in ------------|              |
  |<-- code ABCD-1234 + "Copy & open" + Cancel (also a notification)                              |                |
  |-- enters the code at microsoft.com/devicelogin, signs in ---------------------------------------->|              |
  |               |               |-- POST /token (device_code), every interval --------------------->|              |
  |               |               |<-- authorization_pending … then tokens ---------------------------|              |
  |               |               |   [expired: "Sign-in code expired"; declined: "Sign-in was declined"; Sign in again]
  |               |               |-- store tokens ------------------------->|                     |                |
  |               |               |   (other windows reread on secrets.onDidChange)               |                |
  |               |               |-- GET /me, /me/chats ------------------------------------------------------------->|
  |<-- chats; "Signed in as …" ---|                     |                  |                     |                |
```

## Builder's decisions from the plan

Made while planning on 2026-11-18. All count as *(builder's call)*.

- **Device-code scopes** are sent as full Graph scope names
  (`https://graph.microsoft.com/Chat.ReadWrite`); `offline_access` is
  sent as is. When Microsoft answers `slow_down`, polling waits 5 s
  longer.
- **Personal-account errors** are recognized by `AADSTS50020` or
  `AADSTS9002331`, or by a mention of a Microsoft account. These codes
  are a guess, checked at the first live sign-in.
- **The editor method** remembers "signed out" and "channels enabled" in
  global state, which all windows share.
- **Until channels are enabled,** the teams list and the channel-mention
  search don't run under the `editor` and `deviceCode` methods. Under
  `tokenFile` they run, and a 403 turns them off with the reason shown.
- **Changing a `chirp.signIn.*` setting** stops polling and signs in again
  with the new method, silently if it already has a session.
- **Sign Out also closes the open conversation tabs.**
- **The sidebar's states and their exact text:**
  - signed out: **Sign in to Microsoft**;
  - waiting: "Waiting for sign-in in the browser…" with **Cancel**;
  - a sign-in code: the code shown large, **Copy code & open**, and
    "Enter it at <link>";
  - the account line: "Signed in as <user> (editor | sign-in code |
    token file)".
- **The listing icon** is a speech bubble with a small bird.
- **The version** becomes 0.2.0. The description ends "Not affiliated with
  Microsoft." A test checks that nothing shipped says `ms365`, `zig` or
  `c3`.
