# chirp

Microsoft Teams chats and channels in VS Code and Cursor. Chats and
channels get a sidebar of their own, and each conversation opens as an
editor tab you can read and type in.

chirp has no AI in it. An agent beside it (Claude Code, the Claude CLI,
or any agent that reads files) can read the conversation in front and
summarize it or draft a reply.

chirp is not made by or affiliated with Microsoft.

- **Sidebar:** chirp's icon in the Activity Bar. A filter box, then Chats
  (unread ones in bold, a red pulsing `@` on those that mention you),
  then Teams and Channels. The badge counts unread mentions.
- **Chat tabs:** messages as in Teams, with a message box. Enter sends,
  Shift+Enter adds a new line, and typing `@` offers the chat's members.
  Opening a chat marks it read in Teams, but only while its tab is
  visible and the window has focus.
- **Channel tabs:** one card per post, with its last two replies and a
  reply box, and a box at the bottom for a new post.

## Signing in

chirp signs in to Microsoft 365 with a **work or school account**.
Personal Microsoft accounts aren't supported. There are three ways to
sign in. The setting `chirp.signIn.method` picks one; the default,
`auto`, picks for you.

| Way | `chirp.signIn.method` | When to use it |
| --- | --- | --- |
| **The editor's Microsoft sign-in** | `editor` | The default. VS Code or Cursor shows its usual account prompt and keeps your sign-in. |
| **A sign-in code** | `deviceCode` | If the editor's sign-in isn't available. chirp shows a code; you enter it at microsoft.com/devicelogin. chirp keeps the tokens in the editor's secret storage. |
| **An existing token file** | `tokenFile` | If another tool already signs you in to Microsoft Graph and keeps its tokens in a file. Set `chirp.signIn.tokenFile` to that file, and chirp reuses that login. |

With `auto`, chirp uses the token file if `chirp.signIn.tokenFile` is set;
otherwise the editor's sign-in; otherwise a sign-in code.

- **Commands:** **chirp: Sign In** and **chirp: Sign Out**, also in the
  sidebar's title bar.
- **Signing out** deletes chirp's own tokens, the cached lists, and the
  files chirp wrote under `~/.chirp`. It never changes a token file.
- **The token file** is JSON with `access_token`, `refresh_token`,
  `client_id`, `tenant_id` and `expires_at` (Unix seconds). chirp
  refreshes it in place, using that file's own `client_id`.

### Permissions, and what your admin may need to approve

chirp asks for these delegated Microsoft Graph permissions in two steps,
so chats never wait on channels:

| Step | Permissions | What they're for | Who can approve |
| --- | --- | --- | --- |
| Signing in | `User.Read`, `Chat.ReadWrite`, `ChatMessage.Send`, `offline_access` | your profile; reading your chats, sending, marking read; staying signed in | usually you, if your company lets users approve apps |
| **Enable channels** (a button in the sidebar) | `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `ChannelMessage.Send` | your teams and channels, reading and posting in them, channel mentions | `ChannelMessage.Read.All` needs an admin |

- If your company requires an admin to approve chirp, send them this link:
  `https://login.microsoftonline.com/organizations/adminconsent?client_id=00000000-0000-0000-0000-000000000000`
  (also under **Copy admin link** in the sidebar).
- chirp's app is from an unverified publisher. Many companies block
  users from approving such apps, and there even the first step needs an
  admin.
- With a token file, chirp has whatever permissions that tool's login
  has. If channels aren't among them, the sidebar says so.

## What chirp writes to disk

Each open conversation is written as plain text to `~/.chirp/chats/` or
`~/.chirp/channels/`, and `~/.chirp/current.teams` is the one most
recently in front. The files are readable only by you. This lets an
agent beside chirp know which conversation you mean by "the chat". Set
`chirp.agentFiles` to `false` to turn it off.

## Install from source

```
make install     # links this checkout into VS Code / code-server; reload the window
make test        # offline tests: no network
make package     # a .vsix
```

Setup notes: [docs/notes/901-setup.md](docs/notes/901-setup.md).

## Design

What chirp is for and the decisions behind it:
[docs/notes/101-design.md](docs/notes/101-design.md), and sign-in in
[docs/notes/201-sign-in.md](docs/notes/201-sign-in.md).

## License

MIT
