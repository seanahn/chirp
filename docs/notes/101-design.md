# 101 — Design

What chirp is for, what it does, and how it is built. Written 2026-11-18,
before any code. It is the reference for the first version and is kept up
to date as the plan and build go. Calls marked *(builder's call)* were
made while writing this note, not by Sean; everything else is his.
Sean approved the design, builder's calls included, on 2026-11-18.

## Purpose

chirp shows Microsoft Teams inside VS Code (and Cursor): a Teams sidebar
of chats and channels, and the open conversation as an editor tab. It does
no AI work itself. The agent beside it (Claude Code, or a perch tab) does
the summarizing and replying, using the ms365 MCP server it already has.

The moment it exists for: a Teams thread is moving while Sean is coding.
Today he switches to the Teams PWA, reads the thread, and pastes or
screenshots it into Claude to ask "what are they talking about?" With
chirp the thread is already open in the editor; Claude knows which one,
reads it, and summarizes or replies.

chirp is a standalone extension. It works without perch; perch is one of
the agent panels that can sit on the right, and gets a small change so it
reports chirp's open tab (see "How the agent knows the open conversation").

### Goals

- Teams chats and channels in a sidebar of their own. Unread chats in
  bold; chats and channels that @mention Sean pulse.
- The open chat or channel as an editor tab, readable like Teams, with
  Sean able to type and send from it.
- The agent on the right knows which conversation is in front with no
  per-session setup.
- No second sign-in: chirp uses the ms365 MCP server's saved login.

### Non-goals (first version)

- Calls, meetings, presence, the calendar, files tabs, and app tabs.
- Creating chats, adding people, or editing and deleting messages.
- Push delivery. chirp polls; a few seconds' delay is accepted.
- Unread state for channels beyond mentions (see "Channels").
- Any AI inside chirp. Summaries and drafted replies come from the agent.
- Desktop notifications or sounds *(builder's call; easy to add later)*.
- Favorites (see "Later: Favorites").

### Anti-goals

- A chat list that disagrees with Teams about chats: a chat chirp shows
  read must be read in Teams too, and the other way round.
- Marking something read in Teams that Sean has not actually seen.
- Ever breaking the ms365 MCP server's login. chirp shares its token file
  and must never leave it corrupt or half-written.
- Hammering Microsoft Graph. chirp backs off when throttled and slows down
  when the window is not focused.
- Sending anything Sean did not send, including a duplicate from a retry.

## What Sean sees

Mockups: `.superpowers/brainstorm/*/content/layout-v2.html`,
`unread-v3.html`, `channel-v4.html` (not committed).

### The chirp sidebar

A Teams-like icon (a "T" beside two people, drawn for chirp) in the Activity Bar, with a badge counting only mentions of Sean he
hasn't read: chats that mention him and are still unread, and channels
that mention him and haven't been opened (Sean's change, 2026-11-18).
Its tooltip names them. Clicking it replaces the whole sidebar
with chirp, the way Source Control does; the Explorer icon brings files
back.

Top to bottom:

1. A filter box that narrows both sections by name.
2. **Chats**: every chat, most recent first. Each row shows the chat's
   name (its topic, or the other people's names when it has none) and a
   one-line preview: `Sender: start of the last message`.
3. **Teams and Channels**: each team Sean belongs to, expandable to its
   channels.

Row states:

- **Unread** (chats only): name and preview bold and bright, with an
  unread count when it can be computed from loaded messages (otherwise
  bold alone).
- **Read**: gray, normal weight. Channels are always in this state unless
  they mention Sean.
- **Mentions Sean** (chats and channels): a red `@` before the name, and
  the row pulses slowly (to about a third opacity and back over about 2.4
  seconds) until the conversation is opened. In a chat preview, Sean's
  name is highlighted. With reduced motion turned on in VS Code, the row
  does not pulse; the `@` and an accent background mark it instead
  *(builder's call)*.

Because the built-in VS Code tree cannot bold or animate a row, the
sidebar is a webview view. It follows the VS Code theme (the theme's CSS
variables) and works from the keyboard: arrow keys move between rows,
Enter opens, and the filter box can be focused with a key.

### A chat tab

Clicking a chat opens it as an editor tab titled with the chat's name.
Opening a chat that already has a tab focuses that tab.

- Header: chat name and the people in it.
- Messages oldest at the top, newest at the bottom, scrolled to the bottom
  on open. Each shows sender, time, and text. Sean's own messages sit on
  the right with a tinted background, like Teams.
- Long messages are cut after a few lines with "Show more".
- @mentions are drawn as names in the accent color.
- Reactions show under a message as emoji with counts.
- Images and attachments show as named links that open in the browser;
  inline images are the builder's call.
- Scrolling to the top loads older messages.
- A message box at the bottom: Enter sends, Shift+Enter adds a newline.
  Typing @mentions is not in the first version.

**Read state** *(builder's call)*: a chat is marked read in Teams
(`markChatReadForUser`) when its tab is visible and the VS Code window has
focus: on open, and again when new messages arrive while that holds. A
tab open in the background, or in an unfocused window, marks nothing read;
the chat stays bold in the sidebar until Sean looks at it.

Checked live on 2026-11-18: opening the unread "Ana, Kai" chat in chirp
marked it read in Teams.

### A channel tab

Clicking a channel opens it as an editor tab titled `Team › Channel`.

- One card per post, newest at the bottom: author, time, subject if any,
  and text.
- Under each post, its last two replies; "N more replies" expands the rest.
- Each card has a reply box that replies inside that post's thread.
- A box at the bottom of the tab starts a new post.
- Scrolling to the top loads older posts.

Opening a channel clears its mention pulse.

## How the agent knows the open conversation

Sean chose two mechanisms, used together.

**Every open tab has a file.** Each chat or channel chirp has open is
mirrored to a plain-text file:

- `~/.chirp/chats/<chat name> <short id>.teams`
- `~/.chirp/channels/<team> › <channel> <short id>.teams`

The short id (six hex characters of a hash of the Graph id) keeps two same-named
conversations apart. If a chat is renamed, its file is renamed only once
no tab has it open *(builder's call)*. Sean agreed recent messages may be
stored on disk; the directory is created mode 700 and files mode 600.

The tab itself is a webview panel, not a text editor, so the file is
chirp's output only: chirp writes it after each poll that brings anything
new, by writing a temp file and renaming it over the old one. Edits to it
are ignored and overwritten.

**A. perch reports chirp's tab.** perch's IDE context today comes only
from text editors (`src/extension.js`, `ideContext()`), so a chirp tab in
front is invisible to it. perch changes so that when the active tab
belongs to chirp, it reports that conversation's file instead:
`Active file: ~/.chirp/chats/Design Team Chat 264dd1.teams`. chirp exposes
the file of the active chirp tab through a command
(`chirp.activeConversationFile`, returning a path or null) that perch
calls when it builds context; perch must keep working when chirp is not
installed. This is a separate change in the perch repo.

**B. The pointer file.** chirp keeps `~/.chirp/current.teams` as a copy of
the file for the chirp tab most recently in front (rewritten whenever
that conversation's file is, and when another chirp tab comes to the
front). It stays pointing at the last conversation after Sean clicks into
a code file, so "what are they talking about?" still means the chat he
just read. One line in Sean's global `~/.claude/CLAUDE.md` tells Claude:
when asked about "the chat" or "this conversation" without another
reference, read `~/.chirp/current.teams`. This covers the Claude Code
panel, the Claude CLI in a terminal, perch, and Cursor alike. Adding
that line is part of setup (note 901), not done by the extension.

### The file format

Plain text, so the agent can read it directly:

```
# Teams chat: Design Team Chat
# chat id: 19:7e2a91f04b6d4e8fa1b5d9e0f6a2b4d8@thread.v2
# members: Sean Ahn, Jordan Lee, Priya Shah, Omar Haddad, Mia Torres, Lena Park
# Written by chirp; mirrors the latest messages. Older messages, and replies:
# use the ms365 MCP server with the chat id above (list-chat-messages, send-chat-message).

[2026-11-17 14:19] Jordan Lee (id 1794953943369):
  @Omar @Mia @Sean are you all ok to have a meeting about the Testing framework at 5 pm PT today?

[2026-11-17 14:32] Sean Ahn (id 1794954742774):
  @Jordan I'm out, so I can't make the 5 pm today. Go ahead without me.
```

A channel file has the team id and channel id in its header, each post
with its id, and its replies indented beneath it. The header says replies
go to a post id with the ms365 server's channel-posting tool.

The file holds the messages chirp has loaded, up to a cap (the builder's
call; a few hundred).

## Signing in: sharing the ms365 MCP server's login

The ms365 MCP server (`~/.local/bin/ms365-mcp`, a Zig binary; its source
was not found locally) keeps its login in `~/.ms365-zig-mcp-token.json`:
`access_token`, `refresh_token`, `client_id`, `tenant_id`, `expires_at`
(Unix seconds). Its sign-in is a public client: the refresh request it
sends has no client secret. Its access token's scopes (checked
2026-11-18) include `Chat.ReadWrite`, `ChatMessage.Send`,
`ChannelMessage.Read.All`, `ChannelMessage.Send`,
`ChannelMessage.ReadWrite`, `Team.ReadBasic.All` and
`Channel.ReadBasic.All`. It has no `Channel.Create` or `Team.Create`.

chirp:

1. Rereads the file before each Graph request.
2. If the access token expires within a minute, refreshes it at
   `https://login.microsoftonline.com/<tenant_id>/oauth2/v2.0/token`
   (grant `refresh_token`, the same client id and scopes), then rereads
   the file: if another process stored a token that expires later, chirp
   uses that and discards its own; otherwise it writes its new tokens in
   the same format (temp file plus rename, mode 600). A refresh token that
   was just rotated stays usable for a while on Microsoft's side, so an
   occasional overlap with the MCP server is harmless.
3. On a Graph 401 with a token that still looks valid, refreshes once and
   retries once.
4. Never starts a sign-in itself. If there is no file, or the token
   endpoint refuses the refresh (`invalid_grant`), chirp shows "Sign in
   with the ms365 MCP server's login tool" in the sidebar and stops
   polling until a read of the file succeeds: it watches the file and
   also tries it every 5 s, and Refresh tries it at once.
5. On a network error during refresh, it keeps the old file, shows
   "Offline, retrying", and retries with backoff.

**Channel access, verified.** An earlier reading of the token missed
`ChannelMessage.Read.All` and `ChannelMessage.Send`; the decoded token has
both. Sean's test channel is **chirp-test**, a private channel with only
Sean in it, in team Product Team (team id
`11111111-2222-4333-8444-555555555555`, channel id
`19:Xq7TfGkL2mPz9RbW4nVhJ8sYd5KwA6uE1oNiBtF2xy0@thread.tacv2`). Checked on
2026-11-18:

- Reading works there and in other channels.
- With Sean's go, chirp's sender posted "chirp test post" and replied
  "chirp test reply" to it. Each went out once.

Live tests that post use chirp-test only. If a channel ever refuses
posting (403), its tab turns read-only, with the reply boxes disabled and
the reason shown.

## Polling and mentions

| What | How often (window focused) | Graph call (v1.0) |
| --- | --- | --- |
| Chat list | 30 s | `/me/chats?$expand=lastMessagePreview,members&$orderby=lastMessagePreview/createdDateTime desc`; each chat's `viewpoint.lastMessageReadDateTime` decides unread |
| Chat mentions | with the chat list | for each chat whose last message changed since the last poll, fetch its new messages and check `mentions` for Sean's user id |
| Channel mentions | 60 s | one search: `POST /search/query` with entity type `chatMessage`, recent messages matching Sean's name; each hit in a channel is fetched and kept only if its `mentions` include Sean's user id |
| Teams and channels list | on start and every 30 min | `/me/joinedTeams`, `/teams/{id}/channels` |
| Open chat tab | 5 s | `/chats/{id}/messages`, newest first, until already-loaded messages |
| Open channel tab | 5 s | `/teams/{t}/channels/{c}/messages?$expand=replies` |

- With the window not focused, every interval is about four times longer.
- Sean's user id comes from `/me`, fetched once at start.
- On HTTP 429 or 503 chirp waits the `Retry-After` time (or backs off
  exponentially) and shows a small "Teams is throttling, retrying" note.
- Search results can trail live messages by a minute or more, so a channel
  mention may take a few minutes to start pulsing; Sean accepted this.
  Mentions of the whole team or channel are likely missed, since they do
  not name him.
- What the build found about search (2026-11-18):
  - Results come newest first, so a new mention lands near the top of the
    25.
  - Sorting is refused (400), and KQL filters such as `mentions:` match
    nothing.
  - Channel hits carry `channelIdentity` with a team and channel id; chat
    hits carry an empty one.
  - A hit has no `replyToId`, so a hit that is a reply and can't be
    fetched as a post (404) is set aside.
  - In two days there were no channel hits for Sean's name, so the
    channel-mention path hasn't been seen working on real data yet.
- Graph refuses `$expand=replies` on a single channel message. A post's
  replies come from `/messages/{id}/replies`.
- The last chat list, teams list and Sean's profile are kept in the
  extension's global state and shown at once after a reload, because
  `/me/chats` takes about 3.6 s for 40 chats. The first poll replaces
  them. Mention checks run after the list shows, four at a time.
- Channels keep no unread state: there is no per-channel activity call in
  Graph v1.0, and polling every channel is the hammering the anti-goals
  rule out.

## Sending

- Chat: `POST /chats/{id}/messages`, the typed text escaped as HTML.
- New channel post: `POST /teams/{t}/channels/{c}/messages`.
- Channel reply: `POST /teams/{t}/channels/{c}/messages/{id}/replies`.

A sent message shows at once in a pending style. When the POST returns,
the pending message is replaced by the returned message; the next poll
finds it already there.

On failure *(builder's call)*:

- **A clear refusal** (4xx other than 429): the message stays with the
  error and a Retry button.
- **429**: chirp waits `Retry-After` and resends by itself, once.
- **A timeout or network error**: whether it posted is unknown, so before
  offering Retry, chirp fetches the latest messages and looks for one from
  Sean with the same text sent after the attempt. If found, it uses that
  and does not resend.

## Diagrams

Opening a chat and asking Claude about it:

```
 Sean          chirp sidebar   chirp host            token file    Graph          ~/.chirp files    perch / Claude     ms365 MCP
  |                  |               |                      |            |                  |                 |                |
  |-- click chat --->|               |                      |            |                  |                 |                |
  |                  |-- open(id) -->|                      |            |                  |                 |                |
  |                  |               | [tab exists: focus it; stop]      |                  |                 |                |
  |                  |               |-- read ------------->|            |                  |                 |                |
  |                  |               |<-- access token -----|            |                  |                 |                |
  |                  |               |-- GET messages ------------------>|                  |                 |                |
  |                  |               |<-- messages ----------------------|                  |                 |                |
  |                  |               |-- write X.teams and current.teams (temp+rename) ---->|                 |                |
  |<-- tab "X" with messages --------|                      |            |                  |                 |                |
  |                  |               | [window focused, tab visible]     |                  |                 |                |
  |                  |               |-- POST markChatReadForUser ------>|                  |                 |                |
  |-- "what are they talking about?" ------------------------------------------------------------------------>|                |
  |                  |               |<-- chirp.activeConversationFile (perch only) ---------------------------|                |
  |                  |               |-- path of X.teams ---------------------------------------------------->|                |
  |                  |               |                      |            |                  |<-- read X.teams |                |
  |                  |               |                      |            |                  | (Claude panel/CLI: reads current.teams)
  |                  |               |                      |            |                  |  [needs older]  |-- list msgs -->|
  |<-- summary ------------------------------------------------------------------------------------------------|                |
```

(Sean's user id from `/me` and the chat's members come from the chat-list
poll that ran at start; the open uses them.)

A request when the token has expired, and when the login is gone:

```
 chirp host                         token file             login.microsoftonline.com      Graph
   |-- read -------------------------->|                            |                       |
   |<-- expires within a minute -------|                            |                       |
   |-- refresh_token grant ------------------------------------------>|                       |
   |   [granted]                       |                            |                       |
   |<-- new access + refresh tokens ----------------------------------|                       |
   |-- reread ------------------------>|                            |                       |
   |   [file has a later expiry: use it, discard own]               |                       |
   |   [otherwise: write own, temp+rename]                          |                       |
   |-- GET with access token -------------------------------------------------------------->|
   |   [401: refresh once, retry once]                              |                       |
   |   [refused at the token endpoint: invalid_grant]               |                       |
   |-- sidebar: "Sign in with the ms365 MCP server's login tool"; stop polling; watch file  |
   |   [network error during refresh: keep file; "Offline, retrying"; back off]             |
```

Sending a reply from a channel card:

```
 Sean           channel tab            chirp host                     Graph
  |-- type, Enter ->|                       |                            |
  |                 |-- send(post id) ----->|                            |
  |                 |<-- show pending ------|                            |
  |                 |                       |-- POST …/messages/{id}/replies ->|
  |                 |                       |   [201]                    |
  |                 |                       |<-- message ----------------|
  |                 |<-- replace pending ---|                            |
  |                 |                       |   [429: wait Retry-After, resend once]
  |                 |                       |   [403: no permission]     |
  |                 |<-- error + Retry; reply boxes disabled, reason shown
  |                 |                       |   [timeout]                |
  |                 |                       |-- GET latest replies ----->|
  |                 |                       |   [found own text: use it, no resend]
  |                 |<-- else: error + Retry|                            |
```

Chat messages and new channel posts follow the same path with their own
POST.

## How it is built

Following perch (Sean's choice: "like perch"):

- Plain JavaScript, CommonJS, no bundler, `src/*.js`, VS Code engine
  `^1.90.0`; works in Cursor through the same API.
- Tests under `test/` with Node's built-in test runner; Graph, the token
  endpoint, and the token file are faked.
- A `Makefile` to install into the local extension directories, package,
  and publish; publisher `seanahn`; MIT; repo `github.com/seanahn/chirp`.
- `docs/notes/` numbered notes: 1xx purpose and architecture, 2xx topics,
  9xx setup. This note is 101.
- No runtime dependencies: Node's `fetch` suffices. jsdom (dev only) runs
  the page tests.
- The perch change (mechanism A) is commit `ae39eb7` in `/git/perch`,
  described in perch's note 104 under "IDE context".

How to install and run it is in the [README](../../README.md); setup is
in [note 901](901-setup.md).

**Build:** v1 was built on 2026-11-18 and published as
[PR #1](https://github.com/seanahn/chirp/pull/1). The step-by-step
history, with the build plan and per-task commits, was squashed before
publishing because it held real names and Teams ids. It survives only on
the local branch `backup/v1-before-scrub`, where the last commit
containing the plan is `9fe4665`.

### The modules

| File | What it does |
| --- | --- |
| `src/tokenStore.js` | Reads and refreshes the ms365 MCP server's token file |
| `src/graph.js` | Graph transport: the token, a refresh and retry on 401, timeouts, error types |
| `src/api.js` | The Teams endpoints chirp calls |
| `src/poller.js` | Polling: no overlap, 4× slower when unfocused, backoff on 429/503 |
| `src/model.js` | Chat names, unread state, previews, mentions |
| `src/mentions.js` | Mention flags kept across restarts; the channel mention search |
| `src/mirror.js` | The `~/.chirp` files and `current.teams` |
| `src/sender.js` | Sending without double posts |
| `src/sidebar.js`, `media/sidebar.*` | The sidebar view and its page |
| `src/conversation.js`, `media/conversation.*` | Chat and channel tabs and their page |
| `src/extension.js` | Wires it all together |

Left to the builder: the module split, webview markup and styling within
the mockups, the history cap, HTML-to-text conversion for the files, the
search query's exact form and time window, and inline images.

## Builder's decisions from the plan

These were made while writing the v1 plan (2026-11-18). They all count as
*(builder's call)*, and Sean can overturn any of them.

- **Chat names:** the topic. Otherwise, for a 1:1, the other person's full
  name. For a group with no topic, the others' first names: the first
  three, then `+N` ("Ana, Dana, Ben, +2"), sorted by name. (Teams
  lists members in no fixed order, so an unsorted name changed between
  polls and gave one chat two files.)
- **Unread:** a chat is unread when its last message isn't Sean's and is
  newer than his `lastMessageReadDateTime`. The unread count shows only
  when the loaded messages reach back to the read time, so it is known to
  be complete.
- **Chat mention check:** only unread chats are checked, and only when
  their last message changed (at start, every unread chat), by fetching
  their 20 newest messages. A chat's mention clears when it is opened in
  chirp, or when it stops being unread (read in Teams elsewhere).
- **Channel mention check:** the search query is Sean's display name in
  quotes, 25 results, every 60 s. A hit counts only if it was created
  after chirp first ran (a stored baseline) and hasn't been seen before.
  The last 500 seen ids are kept. A hit that fails to fetch is retried on
  the next poll. A channel's mention clears when it is opened in chirp.
  Mention state persists across restarts.
- **Backoff:** `Retry-After` when Graph sends it. Otherwise 5 s, doubling
  up to 5 min, and back to normal after a success.
- **Sending:**
  - Requests time out after 30 s.
  - After a timeout or network error, chirp checks the 20 latest messages
    for one from Sean with the same text (whitespace-insensitive) sent no
    earlier than 5 s before the attempt.
  - A 429 is resent once, after `Retry-After` (5 s if Graph doesn't say).
  - A 403 when posting in a channel makes that tab read-only until it's
    closed, with the reason "Teams refused posting here (403)."
- **Token file:**
  - The refresh asks for scope `https://graph.microsoft.com/.default
    offline_access`.
  - Fields chirp doesn't know are kept when it writes the file.
  - A file that doesn't parse is reread once after 200 ms, then treated
    as "sign in needed".
  - While sign-in is needed, the file is watched by polling it every 5 s,
    because the MCP server replaces the file by renaming a new one into
    place, and a plain file watcher would miss that.
- **Files:**
  - At most 300 messages (or channel posts) per file.
  - The short id is the first 6 hex characters of a SHA-1 of the whole
    Graph id. (Meeting ids all start `meeting_`, and many 1:1 ids start
    with Sean's own user id, so the id's first characters collided.)
  - Message text is indented two spaces under its header line, so a
    message can't pass for a header or for another sender's message.
    Newlines in names are flattened.
  - In names, `/`, `\`, control characters, and a leading `.` become `_`,
    and names are cut to 80 characters.
  - Times are local, `YYYY-MM-DD HH:mm`.
- **Read marking** is checked on open, after a poll brings new messages,
  when the tab becomes visible, and when the window regains focus. It is
  sent only if the chat is unread.
- **Message bodies:**
  - Bodies are sanitized in the tab to a small allowlist of tags. Links
    are kept only if they're `https:`. `<at>` mentions render as accent
    names.
  - Inline images (Graph hosted content, which needs auth) and
    attachments show as named links that open in the browser.
  - Bodies longer than 6 lines are cut, with "Show more".
- **Sidebar:**
  - `/` focuses the filter, and Escape clears it.
  - Reduced motion follows the OS setting and VS Code's
    `workbench.reduceMotion`.
  - Channel rows are never bold.
  - Teams start collapsed, and their expansion is remembered.
- **Tabs** are restored after a window reload, as VS Code restores other
  webview tabs.
- **perch (mechanism A):** a chirp tab counts as "in front" when it became
  active more recently than any file editor. perch's own tabs don't
  change this. perch caches chirp's path when the tabs change, so its
  context stays synchronous. perch reports it as `Active file: <path>
  (Teams conversation)`.
- **The `~/.claude/CLAUDE.md` line** (written in note 901, added by Sean):
  "Teams: when I ask about "the chat", "this conversation" or "the thread"
  without naming one, read ~/.chirp/current.teams (written by chirp);
  reply only when I say so, with the ms365 MCP server and the ids in its
  header."
- **Live tests:** chat sends go only to Sean's self-chat (to be confirmed
  with Sean at that step). Channel posts and replies go only to
  chirp-test. Each live send needs Sean's go at the time.

### Rulings during the build

Each of these was made while building and checking with Sean on
2026-11-18. They describe what shipped.

- **Badge:** see "The chirp sidebar": unread mentions only. A zero count
  is set as 0, which VS Code hides; clearing it with `undefined` left a
  stale "1" on screen.
- **Teams in the sidebar:** a collapsed team shows the `@` and pulse of a
  channel inside it that mentions Sean.
- **Files skip some messages:** system events (such as "X was added") and
  deleted messages aren't written to the files or drawn in tabs. A post's
  subject is written as a `Subject:` line.
- **Invisible characters in names:** characters such as the soft hyphen
  at the end of one "General" channel's name are left out of file names.
- **Deleted messages:** a message deleted in Teams leaves the open tab and
  its file at the next poll. Graph still lists it, with `deletedDateTime`
  set and an empty body.
- **Edits:** polls also redraw edited messages among the latest 50, and
  posts that got a new reply.
- **Inline images:** they show as `[image]` text, not links, because
  hosted-content URLs need the token and wouldn't open in a browser.
- **A 403 when posting in a channel:** no Retry is offered, and the tab
  stays read-only until it's closed.
- **Unknown outcomes when sending:** a 503 is resent once, like a 429.
  Any other 5xx counts as "outcome unknown", like a timeout, so the
  latest messages are checked before Retry is offered.
- **Restored tabs:** a tab remembers its names, so after a reload it has
  a title before the lists arrive.
- **perch:** while a chirp tab is in front, perch asks chirp for the file
  again on every tab change, so a closed chirp tab stops counting.

### Changes from the final review

A fresh reviewer checked the whole branch on 2026-11-18. These fixes
followed, each with a test that failed first:

- **Retry never posts twice:** a Retry carries the first attempt's time.
  The latest messages are checked for that attempt before anything is
  posted, and nothing is posted if the check itself fails.
- **Short ids and indented text:** see "Files" above.
- **`current.teams` per window:** a window refreshes it only while it
  still names that window's conversation, so a background window with a
  busy chat can't take it over.
- **Emoji:** Teams sends them as `<emoji alt="🙂">` (seen in real
  messages), or as an `<img>` of item type Emoji. Both show as the
  character, in tabs and in files.
- **Mentions clear on reopen:** opening a conversation whose tab is
  already open clears its mention.
- **Failed loads:** a tab whose first load fails says "Couldn't load this
  conversation. Retrying." and its poller keeps trying.
- **Reply drafts survive:** channel cards are redrawn in place, so a
  reply being typed, its focus, and pending replies all survive a new
  reply from someone else.
- **Sign-in recovery:** see "Signing in", step 4.
- **Offline backoff:** being offline backs the pollers off like
  throttling: 5 s doubling to 5 min, without the throttling note.

**Known gap: mentions in channel replies.** A search hit doesn't say
whether it's a reply or which post it belongs to: there's no
`replyToId`, and the hits checked had no `parentMessageId` in their
link. A reply fetched as a post can fail, and such a hit is set aside.
So an @mention of Sean inside a thread may never pulse; mentions in top-
level posts do. Fixing this needs a way to find a reply's post from the
hit.

Smaller findings were left for later. They're in the v1 PR description.

## Later: Favorites

Sean asked for a Favorites section on 2026-11-18, with his self-chat in it
by default, and wanted it to be the same list as Teams' own Favorites. He
put it off once the limits below were known. Kept here for a future
version.

What Graph allows (checked 2026-11-18):

- **Teams' Favorites (pinned chats) can't be read or changed by an app.**
  A chat from `/me/chats` has only `isHidden` and
  `lastMessageReadDateTime` in its `viewpoint`, with no favorite or pin
  field. Graph has `/chats/{id}/pinnedMessages`, which covers messages
  pinned inside a chat, not chats pinned in the sidebar. So chirp can't
  share Teams' list.
- **The self-chat ("Sean Ahn (You)") isn't reachable.** It's the
  `48:notes` thread. `GET /chats/48:notes` answers 400 "Call made for a
  thread which is not a ChatThread", and it isn't among the 402 chats
  `/me/chats` returns. So neither chirp nor the ms365 MCP server can show
  it or post to it.

What could be built: a Favorites list chirp keeps itself. It would be a
section at the top of the sidebar, with a star on any chat or channel to
add or remove it, saved in the extension's global state. It wouldn't be
synced with Teams and couldn't hold the self-chat. Revisit if Graph adds
pinned chats or access to the notes thread.
