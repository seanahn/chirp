# 901 — Setup

How to set chirp up on a machine. The design is in [101](101-design.md)
and sign-in in [201](201-sign-in.md).

## 1. Install chirp

From the Marketplace, or from source:

```
cd chirp
make install
```

Then reload the window (Ctrl+Shift+P → "Developer: Reload Window").
chirp's icon appears in the Activity Bar.

## 2. Sign in

Open chirp's sidebar and click **Sign in to Microsoft**. With the
default setting, `chirp.signIn.method: auto`, chirp signs in in one of
these ways:

- **The editor's Microsoft sign-in:** VS Code or Cursor shows its
  account prompt, and the browser opens.
- **A sign-in code,** if the editor's sign-in isn't available: copy the
  code, open microsoft.com/devicelogin, and enter it.
- **An existing token file:** set `chirp.signIn.tokenFile` to a token
  file another tool keeps, and chirp reuses that login. Nothing to click.

Then, to see teams and channels, click **Enable channels** in the Teams
section. If your company needs an admin to approve that, chirp shows a
link to send them.

## 3. Tell your agent where the open conversation is

chirp keeps `~/.chirp/current.teams` as a copy of the conversation most
recently in front. For Claude Code, add a line like this to
`~/.claude/CLAUDE.md`. chirp never edits that file.

```
- Teams: when I ask about "the chat", "this conversation" or "the thread" without naming one, read ~/.chirp/current.teams (written by chirp); reply only when I say so, with a Microsoft Graph tool and the ids in its header.
```

## 4. What chirp writes to disk

- **`~/.chirp/chats/<chat> <id>.teams` and `~/.chirp/channels/<team> ›
  <channel> <id>.teams`:** each open conversation, at most its last 300
  messages, rewritten after each poll that brings anything new.
- **`~/.chirp/current.teams`:** the conversation most recently in front.
- **Permissions:** the directory is mode 700, and the files are mode 600.
- **`chirp.agentFiles: false`** stops chirp writing them. Signing out
  deletes them.
