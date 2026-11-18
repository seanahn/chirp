# 901 — Setup

How to set chirp up on a machine. The design is in [101](101-design.md).

## 1. The ms365 MCP server's login

chirp uses the login the ms365 MCP server keeps in
`~/.ms365-zig-mcp-token.json`. Set the server up and sign in with its
`login` tool first. chirp refreshes the token when needed and writes it
back in the same format. It never signs in itself: if the login is
missing or refused, the sidebar says "Sign in with the ms365 MCP
server's login tool" and waits for the file to change.

## 2. Install chirp

```
cd /git/chirp
make install
```

Then reload the window (Ctrl+Shift+P → "Developer: Reload Window"). The
Teams-like icon appears in the Activity Bar.

## 3. Tell Claude where the open conversation is

chirp keeps `~/.chirp/current.teams` as a copy of the conversation most
recently in front. Add this line to `~/.claude/CLAUDE.md` (chirp never
edits it):

```
- Teams: when I ask about "the chat", "this conversation" or "the thread" without naming one, read ~/.chirp/current.teams (written by chirp); reply only when I say so, with the ms365 MCP server and the ids in its header.
```

This works in the Claude Code panel, the Claude CLI in a terminal, and
Cursor. perch tabs don't need it: they report a chirp tab in front as the
active file.

## 4. What chirp writes to disk

- `~/.chirp/chats/<chat> <id>.teams` and `~/.chirp/channels/<team> ›
  <channel> <id>.teams`: each open conversation, at most its last 300
  messages, rewritten after each poll that brings anything new.
- `~/.chirp/current.teams`: the conversation most recently in front.
- The directory is mode 700, and the files are mode 600.

Delete them whenever you like. chirp writes them again for the tabs that
are open.
