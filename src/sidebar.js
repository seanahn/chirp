'use strict';
// The chirp sidebar: a webview view, because the built-in tree can't bold or animate a row (design 101, "The chirp sidebar").
const vscode = require('vscode');
const crypto = require('crypto');

// the page's buttons, and the commands they run
const ACTIONS = { signIn: 'chirp.signIn', cancelSignIn: 'chirp.cancelSignIn', copyCode: 'chirp.copyCode', enableChannels: 'chirp.enableChannels', copyAdminLink: 'chirp.copyAdminLink' };

class Sidebar {
  constructor(extensionUri, { meName = () => '' } = {}) {
    this.extensionUri = extensionUri;
    this.meName = meName;
    this.view = null;
    this.state = { chats: [], teams: [], status: null };
    this.openers = [];
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    const csp = view.webview.cspSource;
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; img-src ${csp} https: data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.type === 'ready') { this.post(); if (this.frontRef) this.view.webview.postMessage({ type: 'front', ref: this.frontRef }); }
      else if (m && m.type === 'open' && m.ref) for (const fn of this.openers) fn(m.ref);
      else if (m && m.type === 'findPeople') vscode.commands.executeCommand('chirp.findPeople', String(m.query || ''));
      else if (m && m.type === 'startChat') vscode.commands.executeCommand('chirp.startChat', String(m.userId || ''), String(m.name || ''));
      else if (m && Object.prototype.hasOwnProperty.call(ACTIONS, m.type)) vscode.commands.executeCommand(ACTIONS[m.type]);
    });
    this.post();
  }

  /** New rows or status. Unset keys keep their last value. */
  update(next) {
    Object.assign(this.state, next);
    this.post();
  }

  post() {
    if (!this.view) return;
    const reduceMotion = vscode.workspace.getConfiguration('workbench').get('reduceMotion') === 'on';
    this.view.webview.postMessage(Object.assign({ type: 'state', reduceMotion, meName: this.meName() }, this.state));
    // only mentions Sean hasn't read: a chat that mentions him and is still unread, a channel mention not yet opened
    const names = this.state.chats.filter((r) => r.mention && r.unread).map((r) => r.name)
      .concat(...this.state.teams.map((t) => (t.channels || []).filter((c) => c.mention).map((c) => `${t.name} › ${c.name}`)));
    // a 0 badge is hidden; setting undefined may leave the last badge on screen
    this.view.badge = { value: names.length, tooltip: names.length ? `Mentions you: ${names.join(', ')}` : '' };
  }

  onOpen(fn) { this.openers.push(fn); }

  /** The chirp tab in front: its row is highlighted. Kept, so a sidebar shown later gets it too. */
  front(ref) {
    this.frontRef = ref ? { kind: ref.kind, id: ref.id, teamId: ref.teamId } : null;
    if (this.view && this.frontRef) this.view.webview.postMessage({ type: 'front', ref: this.frontRef });
  }

  focusFilter() {
    if (this.view && this.view.show) this.view.show(false);
    if (this.view) this.view.webview.postMessage({ type: 'focusFilter' });
  }
}

module.exports = { Sidebar };
