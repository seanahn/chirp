// The chirp sidebar: a filter box, Chats, then Teams and Channels. Rows are built with textContent only.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const d = document;
  const saved = vscode.getState() || { expanded: {} };
  let state = { chats: [], teams: [], status: null, meName: '' };
  let selected = -1;

  const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const filter = el('input', 'filter'); filter.type = 'text'; filter.placeholder = 'Filter chats and channels'; filter.setAttribute('aria-label', 'Filter chats and channels');
  const status = el('div', 'status'); status.hidden = true;
  const chatsHead = el('div', 'section', 'Chats');
  const chats = el('div', 'list chats'); chats.setAttribute('role', 'listbox');
  const teamsHead = el('div', 'section', 'Teams and Channels');
  const teams = el('div', 'list teams'); teams.setAttribute('role', 'listbox');
  const account = el('div', 'account'); account.hidden = true;
  const signin = el('div', 'signin'); signin.hidden = true;
  const channelsNote = el('div', 'channels-note'); channelsNote.hidden = true;
  d.body.append(filter, account, status, signin, chatsHead, chats, teamsHead, channelsNote, teams);
  const button = (label, type, cls) => { const b = el('button', cls || '', label); b.addEventListener('click', () => vscode.postMessage({ type })); return b; };
  const METHOD = { editor: 'editor', deviceCode: 'sign-in code', tokenFile: 'token file' };

  /** Signing in: the button, the wait, or the code. While signed out the lists are hidden. */
  function renderSignIn() {
    const si = state.signIn;
    const out = !state.account && !!si;
    for (const x of [chatsHead, chats, teamsHead, teams, channelsNote]) if (out) x.hidden = true;
    if (!out) { chatsHead.hidden = false; chats.hidden = false; teamsHead.hidden = false; teams.hidden = false; }
    signin.hidden = !si;
    if (!si) { signin.replaceChildren(); return; }
    if (si.stage === 'signedOut') signin.replaceChildren(button('Sign in to Microsoft', 'signIn', 'primary'));
    else if (si.stage === 'waiting') signin.replaceChildren(el('div', 'wait', 'Waiting for sign-in in the browser…'), button('Cancel', 'cancelSignIn'));
    else if (si.stage === 'code') signin.replaceChildren(el('div', 'code', si.userCode || ''), button('Copy code & open', 'copyCode', 'primary'), el('div', 'where', `Enter it at ${si.verificationUri || ''}`), button('Cancel', 'cancelSignIn'));
  }
  function renderAccount() {
    const a = state.account;
    account.hidden = !a;
    account.textContent = a ? `Signed in as ${a.username} (${METHOD[a.method] || a.method})` : '';
  }
  /** The Teams section before channels are enabled, or when they can't be. */
  function renderChannels() {
    const c = state.channels;
    if (!state.account || c === 'enabled' || !c) { channelsNote.hidden = true; channelsNote.replaceChildren(); return; }
    channelsNote.hidden = false;
    if (c === 'off') channelsNote.replaceChildren(button('Enable channels', 'enableChannels'));
    else if (c === 'failed') channelsNote.replaceChildren(el('div', null, "Channels weren't enabled. If your company requires an admin to approve chirp, send them this link."), button('Copy admin link', 'copyAdminLink'), button('Try again', 'enableChannels'));
    else if (c === 'forbidden') { channelsNote.replaceChildren(); channelsNote.textContent = "Channels need permissions this login doesn't have."; }
  }

  const matches = (name) => !filter.value.trim() || String(name).toLowerCase().includes(filter.value.trim().toLowerCase());

  /** The preview, with Sean's name marked wherever it appears. */
  function preview(text) {
    const p = el('div', 'preview');
    const name = state.meName;
    if (!name) { p.textContent = text; return p; }
    const parts = String(text).split(name);
    parts.forEach((part, i) => { if (i) p.append(el('mark', null, name)); if (part) p.append(d.createTextNode(part)); });
    return p;
  }

  function chatRow(r) {
    const row = el('div', 'row chat'); row.setAttribute('role', 'option');
    if (r.unread) row.classList.add('unread');
    if (r.mention) row.classList.add('mention');
    row.dataset.ref = JSON.stringify({ kind: 'chat', id: r.id });
    const line = el('div', 'line');
    if (r.mention) line.append(el('span', 'at', '@'));
    line.append(el('span', 'name', r.name));
    if (r.unread && r.unreadCount != null) line.append(el('span', 'count', String(r.unreadCount)));
    row.append(line);
    if (r.preview) row.append(preview(r.preview));
    return row;
  }

  function render() {
    d.body.classList.toggle('reduce-motion', !!state.reduceMotion);
    status.hidden = !state.status;
    status.className = 'status' + (state.status ? ' ' + state.status.kind : '');
    status.textContent = state.status ? state.status.text : '';
    chats.replaceChildren(...state.chats.filter((r) => matches(r.name)).map(chatRow));
    teams.replaceChildren(...renderTeams());
    renderAccount(); renderSignIn(); renderChannels();
    const rows = allRows();
    if (selected >= rows.length) selected = rows.length - 1;
    mark();
  }

  function renderTeams() {
    const out = [];
    for (const t of state.teams || []) {
      const chans = (t.channels || []).filter((c) => matches(c.name) || matches(t.name));
      if (!chans.length && !matches(t.name)) continue;
      const open = !!saved.expanded[t.id] || !!filter.value.trim();
      const head = el('div', 'row team' + (open ? ' open' : ''));
      head.dataset.team = t.id;
      head.append(el('span', 'twisty', open ? '⌄' : '›'), el('span', 'name', t.name));
      if (!open && chans.some((c) => c.mention)) { head.classList.add('mention'); head.prepend(el('span', 'at', '@')); }
      out.push(head);
      if (!open) continue;
      for (const c of chans) {
        const row = el('div', 'row channel');
        if (c.mention) row.classList.add('mention');
        row.dataset.ref = JSON.stringify({ kind: 'channel', teamId: t.id, id: c.id });
        const line = el('div', 'line');
        if (c.mention) line.append(el('span', 'at', '@'));
        line.append(el('span', 'name', c.name));
        row.append(line);
        out.push(row);
      }
    }
    return out;
  }

  const allRows = () => [...d.querySelectorAll('.list .row')];
  function mark() { allRows().forEach((r, i) => r.classList.toggle('selected', i === selected)); }

  function activate(row) {
    if (!row) return;
    if (row.dataset.team) { const id = row.dataset.team; saved.expanded[id] = !saved.expanded[id]; vscode.setState(saved); render(); return; }
    vscode.postMessage({ type: 'open', ref: JSON.parse(row.dataset.ref) });
  }

  filter.addEventListener('input', () => { selected = -1; render(); });
  d.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.row');
    if (!row) return;
    selected = allRows().indexOf(row); mark(); activate(row);
  });
  d.addEventListener('keydown', (e) => {
    const rows = allRows();
    if (e.key === 'Escape' && e.target === filter) { filter.value = ''; render(); return; }
    if (e.key === '/' && e.target !== filter) { e.preventDefault(); filter.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(rows.length - 1, selected + 1); mark(); scroll(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); mark(); scroll(); return; }
    if (e.key === 'Enter' && selected >= 0) { e.preventDefault(); activate(rows[selected]); }
  });
  function scroll() { const r = allRows()[selected]; if (r && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' }); }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'state') { state = m; render(); }
    else if (m.type === 'focusFilter') filter.focus();
  });
  vscode.postMessage({ type: 'ready' });
})();
