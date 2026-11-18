# chirp

Microsoft Teams in VS Code and Cursor. Chats and channels get a sidebar
of their own, and each conversation opens as an editor tab you can read
and type in.

chirp has no AI in it. The agent beside it (Claude Code, the Claude CLI,
or a perch tab) reads the conversation in front and summarizes it or
replies, using the ms365 MCP server it already has.

- **Sidebar:** the Teams-like icon in the Activity Bar. A filter box, then
  Chats (unread ones in bold, a red pulsing `@` on those that mention
  you), then Teams and Channels.
- **Chat tabs:** messages as in Teams, with a message box (Enter sends,
  Shift+Enter adds a new line). Opening a chat marks it read in Teams,
  but only while its tab is visible and the window has focus.
- **Channel tabs:** one card per post, with its last two replies and a
  reply box, and a box at the bottom for a new post.
- **The agent knows what's open:** every open conversation is written to
  `~/.chirp/chats/` or `~/.chirp/channels/` as plain text, and
  `~/.chirp/current.teams` is the one most recently in front. perch
  reports a chirp tab in front as its active file.

## Install

Prerequisites: the ms365 MCP server set up and signed in
(`~/.ms365-zig-mcp-token.json` exists). chirp reuses that login and
never starts a sign-in of its own.

```
make install     # links this checkout into VS Code / code-server; reload the window
make test        # offline tests: no network, no real token file
make package     # a .vsix
```

Setup, including the line for `~/.claude/CLAUDE.md`, is in
[docs/notes/901-setup.md](docs/notes/901-setup.md).

## Design

What chirp is for, what it does and why, and the decisions behind it:
[docs/notes/101-design.md](docs/notes/101-design.md).

## License

MIT
