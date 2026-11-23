// A chirp conversation tab: a chat's messages, or a channel's posts with their replies. Message bodies are Teams HTML,
// rebuilt here through an allowlist; everything else is set with textContent.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const d = document;
  const CLAMP_LINES = 6;
  const ALLOWED = new Set(['p', 'br', 'b', 'i', 'u', 's', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'span', 'div', 'at']);
  const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math']);

  let info = null, more = false, loadingOlder = false;
  const byId = new Map();

  const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const header = el('div', 'header');
  const title = el('div', 'title'), members = el('div', 'members');
  header.append(title, members);
  const list = el('div', 'messages');
  const composer = el('div', 'composer');
  d.body.append(header, list, composer);

  /** Teams HTML as safe DOM: allowlisted tags only, no attributes but an https href, mentions as span.mention. */
  function sanitize(html) {
    const src = new DOMParser().parseFromString('<body>' + (html || '') + '</body>', 'text/html').body;
    const frag = d.createDocumentFragment();
    (function walk(from, to) {
      for (const n of [...from.childNodes]) {
        if (n.nodeType === 3) { to.append(d.createTextNode(n.textContent)); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (DROP.has(tag)) continue;
        // Teams sends emoji as <emoji alt="🙂"> or as an <img> of item type Emoji: the character is the alt text
        if (tag === 'emoji' || (tag === 'img' && /Emoji/.test(n.getAttribute('itemtype') || ''))) { to.append(d.createTextNode(n.getAttribute('alt') || '')); continue; }
        if (tag === 'img') { to.append(d.createTextNode(n.getAttribute('alt') ? `[image: ${n.getAttribute('alt')}]` : '[image]')); continue; }
        if (!ALLOWED.has(tag)) { walk(n, to); continue; }
        const out = d.createElement(tag === 'at' ? 'span' : tag);
        if (tag === 'at') out.className = 'mention';
        if (tag === 'a') { const href = n.getAttribute('href') || ''; if (/^https:\/\//i.test(href)) out.setAttribute('href', href); }
        walk(n, out);
        to.append(out);
      }
    })(src, frag);
    return frag;
  }

  function when(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return '';
    const today = new Date();
    const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return t.toDateString() === today.toDateString() ? time : `${t.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
  }

  function linkOut(a, url, attachment) { a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage(Object.assign({ type: 'link', url }, attachment ? { attachment } : {})); }); }

  function body(m) {
    const b = el('div', 'body');
    b.append(sanitize(m.html));
    b.querySelectorAll('a[href]').forEach((a) => linkOut(a, a.getAttribute('href')));
    const lines = (b.textContent.match(/\n/g) || []).length + b.querySelectorAll('br, p, li, div').length;
    if (lines > CLAMP_LINES || b.textContent.length > 600) b.classList.add('clamped');
    return b;
  }

  function messageEl(m) {
    const box = el('div', 'msg' + (m.mine ? ' mine' : '') + (m.pending ? ' pending' : ''));
    box.dataset.id = m.id;
    const meta = el('div', 'meta');
    meta.append(el('span', 'sender', m.from || ''), el('span', 'time', when(m.time)));
    if (m.edited) meta.append(el('span', 'edited', 'Edited'));
    box.append(meta);
    if (m.subject) box.append(el('div', 'subject', m.subject));
    const b = body(m);
    box.append(b);
    if (b.classList.contains('clamped')) {
      const moreLink = el('a', 'more', 'Show more'); moreLink.href = '#';
      moreLink.addEventListener('click', (e) => { e.preventDefault(); b.classList.remove('clamped'); moreLink.remove(); });
      box.append(moreLink);
    }
    if (m.attachments && m.attachments.length) {
      const at = el('div', 'attachments');
      for (const f of m.attachments) { const a = el('a', null, f.name || 'Attachment'); a.href = '#'; linkOut(a, f.url, f.name || 'the attachment'); at.append(a); }
      box.append(at);
    }
    if (m.reactions && m.reactions.length) {
      const r = el('div', 'reactions');
      for (const x of m.reactions) { const s = el('span', 'reaction', `${x.emoji} ${x.count}`); if (x.who) s.title = x.who; r.append(s); }   // who reacted, on hover
      box.append(r);
    }
    return box;
  }

  // ---- channel cards: a post, its last two replies ("N more replies" shows the rest), and later a reply box
  const expanded = new Set();
  const REPLIES_SHOWN = 2;
  function cardEl(p, into) {
    // redrawn in place: the reply box (with whatever is being typed, and its focus) and any pending replies are kept
    const card = into || el('div', 'card');
    const keptReply = into ? into.querySelector(':scope > .reply') : null;
    const pending = into ? [...into.querySelectorAll('.replies .msg.pending')] : [];
    card.replaceChildren();
    card.dataset.id = p.id;
    const post = messageEl(p); post.classList.add('post');
    card.append(post);
    const replies = el('div', 'replies');
    const all = p.replies || [];
    const hidden = expanded.has(p.id) ? 0 : Math.max(0, all.length - REPLIES_SHOWN);
    if (hidden) {
      const more = el('a', 'show-replies', `${hidden} more ${hidden === 1 ? 'reply' : 'replies'}`); more.href = '#';
      more.addEventListener('click', (e) => { e.preventDefault(); expanded.add(p.id); cardEl(p, card); });
      replies.append(more);
    }
    for (const r of all.slice(hidden)) replies.append(messageEl(r));
    replies.append(...pending);
    card.append(replies);
    let reply = keptReply;
    if (!reply) { reply = el('div', 'reply'); reply.append(composerBox({ postId: p.id }, () => card.querySelector(':scope > .replies'), 'Reply')); }
    card.append(reply);
    return card;
  }
  const nodeFor = (m) => (info && info.kind === 'channel' ? cardEl(m) : messageEl(m));

  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;

  function put(messages, where) {
    const stick = where === 'append' && atBottom();
    const before = list.scrollHeight;
    const fresh = [];
    for (const m of messages) {
      const old = byId.get(m.id);
      if (old && old.isConnected && info && info.kind === 'channel' && old.classList.contains('card')) { cardEl(m, old); continue; }
      const node = nodeFor(m);
      byId.set(m.id, node);
      if (old) old.replaceWith(node); else fresh.push(node);
    }
    if (where === 'prepend') { list.prepend(...fresh); list.scrollTop += list.scrollHeight - before; }
    else { list.append(...fresh); if (stick) list.scrollTop = list.scrollHeight; }
  }

  list.addEventListener('scroll', () => {
    if (list.scrollTop > 0 || !more || loadingOlder) return;
    loadingOlder = true;
    vscode.postMessage({ type: 'older' });
  });

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'init') {
      info = m;
      title.textContent = m.title;
      members.textContent = (m.members || []).join(', ');
      vscode.setState({ ref: m.ref });
      d.title = m.title;
    } else if (m.type === 'header') {
      title.textContent = m.title; d.title = m.title;
      members.textContent = (m.members || []).join(', ');
      people = (m.people || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    } else if (m.type === 'error') {
      let e2 = d.querySelector('.load-error');
      if (!e2) { e2 = el('div', 'load-error'); header.after(e2); }
      e2.textContent = m.text;
    } else if (m.type === 'messages') {
      const le = d.querySelector('.load-error'); if (le) le.remove();
      if (m.reset) { list.replaceChildren(); byId.clear(); }
      if ('more' in m) more = !!m.more;
      put(m.messages || [], 'append');
      if (m.reset) list.scrollTop = list.scrollHeight;
    } else if (m.type === 'removed') {
      for (const id of m.ids || []) { const n = byId.get(id); if (n) n.remove(); byId.delete(id); }
    } else if (m.type === 'older') {
      loadingOlder = false; more = !!m.more;
      put(m.messages || [], 'prepend');
    }
  });

  // ---- sending
  const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');
  let pendingSeq = 0, canSend = false, readOnly = false;
  // ---- @mentions: the chat's other members, offered after @; what was picked rides along with the message
  let people = [];
  const picksOf = new WeakMap();   // textarea -> [{ name, userId }]
  let popup = null;                // { ta, start, items, sel, node }
  function closePopup() { if (popup) { popup.node.remove(); popup = null; } }
  function drawPopup() {
    popup.node.replaceChildren(...popup.items.map((p, i) => {
      const row = el('div', 'person' + (i === popup.sel ? ' selected' : ''), p.name);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      return row;
    }));
  }
  /** After each keystroke: is the caret just after "@something" that matches a member? */
  function lookForMention(ta) {
    if (!people.length) return closePopup();
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([^@\n]{0,40})$/.exec(before);
    const items = m ? people.filter((p) => p.name.toLowerCase().includes(m[2].toLowerCase())) : [];
    if (!items.length) return closePopup();
    if (!popup || popup.ta !== ta) { closePopup(); popup = { ta, node: el('div', 'mention-list') }; ta.after(popup.node); }
    popup.start = before.length - m[2].length - 1; popup.items = items; popup.sel = 0;
    drawPopup();
  }
  function pick(i) {
    const { ta, start } = popup, person = popup.items[i];
    const end = ta.selectionStart, text = '@' + person.name + ' ';
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    const picks = picksOf.get(ta) || []; picks.push({ name: person.name, userId: person.id }); picksOf.set(ta, picks);
    closePopup(); ta.focus();
  }
  /** Picked names still in the text, once each. */
  function mentionsIn(ta, text) {
    const seen = new Set();
    return (picksOf.get(ta) || []).filter((p) => text.includes('@' + p.name) && !seen.has(p.userId) && seen.add(p.userId));
  }
  const pendingText = new Map();   // pendingId -> { text, target }

  function sendNow(pendingId) {
    const p = pendingText.get(pendingId);
    vscode.postMessage(Object.assign({ type: 'send', text: p.text, pendingId, mentions: p.mentions || [] }, p.target ? { target: p.target } : {}));
  }
  /** Shows the message at once, pending, and asks the host to send it. `target` names a channel post to reply to. */
  function submit(textarea, target, where) {
    const text = textarea.value;
    if (!text.trim()) return;
    const mentions = mentionsIn(textarea, text);
    textarea.value = ''; picksOf.delete(textarea); closePopup();
    const pendingId = 'pending-' + Date.now() + '-' + (++pendingSeq);
    pendingText.set(pendingId, { text, target, mentions });
    const node = messageEl({ id: pendingId, from: '', mine: true, pending: true, time: new Date().toISOString(), html: escapeHtml(text), reactions: [], attachments: [] });
    byId.set(pendingId, node);
    (typeof where === 'function' ? where() : where || list).append(node);
    if (!where) list.scrollTop = list.scrollHeight;
    sendNow(pendingId);
  }
  function composerBox(target, where, placeholder) {
    const ta = el('textarea'); ta.rows = 1; ta.placeholder = placeholder || 'Type a message'; ta.disabled = !canSend || readOnly;
    ta.addEventListener('input', () => lookForMention(ta));
    ta.addEventListener('blur', () => { if (popup && popup.ta === ta) closePopup(); });
    ta.addEventListener('keydown', (e) => {
      if (popup && popup.ta === ta) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); popup.sel = (popup.sel + (e.key === 'ArrowDown' ? 1 : -1) + popup.items.length) % popup.items.length; drawPopup(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(popup.sel); return; }
        if (e.key === 'Escape') { e.preventDefault(); closePopup(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(ta, target, where); }
    });
    return ta;
  }
  const mainBox = composerBox(null, null);
  composer.append(mainBox);

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'init') {
      canSend = !!m.canSend;
      people = (m.people || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      mainBox.placeholder = m.kind === 'channel' ? 'Start a new post' : 'Type a message';
      for (const t of d.querySelectorAll('textarea')) t.disabled = !canSend || readOnly;
    }
    else if (m.type === 'sent') {
      const old = byId.get(m.pendingId);
      byId.delete(m.pendingId); pendingText.delete(m.pendingId);
      if (!old) return;
      if (byId.has(m.message.id)) { old.remove(); return; }
      const node = messageEl(m.message);
      byId.set(m.message.id, node);
      old.replaceWith(node);
    } else if (m.type === 'failed') {
      const box = byId.get(m.pendingId);
      if (!box) return;
      if (m.forbidden && info && info.kind === 'channel') {
        readOnly = true;
        for (const t of d.querySelectorAll('textarea')) t.disabled = true;
        if (!composer.querySelector('.readonly')) composer.prepend(el('div', 'readonly', 'Teams refused posting here (403).'));
      }
      const err = el('div', 'error', m.error || 'Not sent');
      if (m.retryable !== false) {
        const retry = el('button', 'retry', 'Retry');
        retry.addEventListener('click', () => { err.remove(); sendNow(m.pendingId); });
        err.append(retry);
      }
      box.append(err);
    }
  });

  window.chirp = { vscode, info: () => info, put, composer, el, composerBox, mainBox };
  vscode.postMessage({ type: 'ready' });
})();
