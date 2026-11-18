'use strict';
// A conversation tab's page script, run in jsdom with a fake acquireVsCodeApi.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'media', 'conversation.js'), 'utf8');

function page() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window, posted = []; let saved;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: (s) => { saved = s; } });
  w.eval(SCRIPT);
  const send = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  return { w, d: w.document, posted, send, saved: () => saved };
}
const m = (id, o) => Object.assign({ id, from: 'Ben Carter', mine: false, time: '2026-11-18T15:52:00Z', html: 'hi', reactions: [], attachments: [] }, o);
const INIT = { type: 'init', ref: { kind: 'chat', id: 'c1' }, title: 'Design Team Chat', members: ['Sean Ahn', 'Mia Torres'], kind: 'chat' };

test('init: header, saved state, ready posted first', () => {
  const p = page();
  assert.deepStrictEqual(p.posted[0], { type: 'ready' });
  p.send(INIT);
  assert.strictEqual(p.d.querySelector('.header .title').textContent, 'Design Team Chat');
  assert.strictEqual(p.d.querySelector('.header .members').textContent, 'Sean Ahn, Mia Torres');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.saved())), { ref: { kind: 'chat', id: 'c1' } });
});

test('renders oldest first and own on the right', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, more: true, messages: [m('1', { html: 'first' }), m('2', { html: 'second', mine: true, from: 'Sean Ahn' })] });
  const msgs = [...p.d.querySelectorAll('.messages .msg')];
  assert.deepStrictEqual(msgs.map((x) => x.querySelector('.body').textContent), ['first', 'second']);
  assert.deepStrictEqual(msgs.map((x) => x.classList.contains('mine')), [false, true]);
  assert.strictEqual(msgs[0].querySelector('.sender').textContent, 'Ben Carter');
  assert.ok(msgs[0].querySelector('.time').textContent.length > 0);
  p.send({ type: 'messages', messages: [m('3', { html: 'third' })] });
  assert.deepStrictEqual([...p.d.querySelectorAll('.messages .msg .body')].map((x) => x.textContent), ['first', 'second', 'third'], 'new messages append');
  p.send({ type: 'messages', messages: [m('2', { html: 'second, edited', mine: true })] });
  assert.deepStrictEqual([...p.d.querySelectorAll('.messages .msg .body')].map((x) => x.textContent), ['first', 'second, edited', 'third'], 'a known id is replaced in place');
});

test('sanitizes hostile html', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, messages: [m('1', { html: '<p>Hi <at id="0">Sean Ahn</at></p><img src=x onerror="window.pwned=1"><script>window.pwned=2</script><a href="javascript:window.pwned=3">bad</a><a href="https://example.com/x" onclick="x()">good</a><div onclick="window.pwned=4" style="color:red">d</div><iframe src="https://x"></iframe>' })] });
  const body = p.d.querySelector('.msg .body');
  assert.strictEqual(p.w.pwned, undefined);
  assert.strictEqual(body.querySelector('script, iframe, img'), null);
  assert.strictEqual(body.querySelectorAll('[onclick], [onerror], [style]').length, 0);
  assert.deepStrictEqual([...body.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]), [['bad', null], ['good', 'https://example.com/x']]);
  const mention = body.querySelector('span.mention');
  assert.strictEqual(mention.textContent, 'Sean Ahn');
  assert.ok(body.textContent.includes('[image]'));
  assert.ok(!body.textContent.includes('pwned=2'), 'script text is dropped');
});

test('links open through the host', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, messages: [m('1', { html: '<a href="https://example.com/a">a</a>', attachments: [{ name: 'deck.pptx', url: 'https://contoso.sharepoint.com/deck.pptx' }] })] });
  p.d.querySelector('.body a').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  p.d.querySelector('.attachments a').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepStrictEqual(p.posted.filter((x) => x.type === 'link'), [{ type: 'link', url: 'https://example.com/a' }, { type: 'link', url: 'https://contoso.sharepoint.com/deck.pptx' }]);
  assert.strictEqual(p.d.querySelector('.attachments a').textContent, 'deck.pptx');
});

test('reactions show as emoji with counts', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, messages: [m('1', { reactions: [{ emoji: '❤️', count: 2 }, { emoji: '👍', count: 1 }] })] });
  assert.deepStrictEqual([...p.d.querySelectorAll('.reactions .reaction')].map((r) => r.textContent), ['❤️ 2', '👍 1']);
});

test('show more clamps long bodies', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, messages: [m('1', { html: Array.from({ length: 10 }, (_, i) => 'line ' + i).join('<br>') }), m('2', { html: 'short' })] });
  const [long, short] = p.d.querySelectorAll('.msg');
  assert.ok(long.querySelector('.body').classList.contains('clamped'));
  assert.strictEqual(short.querySelector('.more'), null);
  long.querySelector('.more').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  assert.ok(!long.querySelector('.body').classList.contains('clamped'));
  assert.strictEqual(long.querySelector('.more'), null);
});

test('scroll to top asks for older, once', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, more: true, messages: [m('5')] });
  const list = p.d.querySelector('.messages');
  list.scrollTop = 0; list.dispatchEvent(new p.w.Event('scroll'));
  list.dispatchEvent(new p.w.Event('scroll'));
  assert.strictEqual(p.posted.filter((x) => x.type === 'older').length, 1);
  p.send({ type: 'older', more: false, messages: [m('3', { html: 'older' }), m('4')] });
  assert.deepStrictEqual([...p.d.querySelectorAll('.msg')].map((x) => x.dataset.id), ['3', '4', '5']);
  list.dispatchEvent(new p.w.Event('scroll'));
  assert.strictEqual(p.posted.filter((x) => x.type === 'older').length, 1, 'no more to load');
});

// ---- sending (Task 10)
const key = (p, k, o) => { const ta = p.d.querySelector('.composer textarea'); ta.dispatchEvent(new p.w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o))); };

test('Enter sends, Shift+Enter is newline', () => {
  const p = page(); p.send(Object.assign({}, INIT, { canSend: true }));
  const ta = p.d.querySelector('.composer textarea');
  assert.strictEqual(ta.disabled, false);
  ta.value = 'line one'; key(p, 'Enter', { shiftKey: true });
  assert.strictEqual(p.posted.filter((x) => x.type === 'send').length, 0);
  ta.value = '   '; key(p, 'Enter');
  assert.strictEqual(p.posted.filter((x) => x.type === 'send').length, 0, 'blank text is not sent');
  ta.value = 'hello <b>there</b>'; key(p, 'Enter');
  const sent = p.posted.filter((x) => x.type === 'send');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, 'hello <b>there</b>');
  assert.ok(sent[0].pendingId);
  assert.strictEqual(ta.value, '');
  const pending = p.d.querySelector('.msg.pending');
  assert.strictEqual(pending.querySelector('.body').textContent, 'hello <b>there</b>', 'shown at once, as text');
  assert.ok(pending.classList.contains('mine'));
});

test('composer is disabled until sending is allowed', () => {
  const p = page(); p.send(INIT);
  assert.strictEqual(p.d.querySelector('.composer textarea').disabled, true);
});

test('pending replaced by sent', () => {
  const p = page(); p.send(Object.assign({}, INIT, { canSend: true }));
  p.d.querySelector('.composer textarea').value = 'hi'; key(p, 'Enter');
  const { pendingId } = p.posted.find((x) => x.type === 'send');
  p.send({ type: 'sent', pendingId, message: m('n1', { html: 'hi', mine: true }) });
  assert.strictEqual(p.d.querySelectorAll('.msg').length, 1);
  assert.strictEqual(p.d.querySelector('.msg').dataset.id, 'n1');
  assert.ok(!p.d.querySelector('.msg').classList.contains('pending'));
  p.send({ type: 'messages', messages: [m('n1', { html: 'hi', mine: true })] });
  assert.strictEqual(p.d.querySelectorAll('.msg').length, 1, 'the poll brings it again: still one');
});

test('failed shows Retry', () => {
  const p = page(); p.send(Object.assign({}, INIT, { canSend: true }));
  p.d.querySelector('.composer textarea').value = 'hi'; key(p, 'Enter');
  const { pendingId } = p.posted.find((x) => x.type === 'send');
  p.send({ type: 'failed', pendingId, error: 'Not sent (no answer from Teams)', retryable: true });
  const box = p.d.querySelector('.msg.pending');
  assert.strictEqual(box.querySelector('.error').textContent.startsWith('Not sent (no answer from Teams)'), true);
  box.querySelector('button.retry').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  const sends = p.posted.filter((x) => x.type === 'send');
  assert.deepStrictEqual(sends.map((x) => [x.text, x.pendingId]), [['hi', pendingId], ['hi', pendingId]]);
  assert.strictEqual(box.querySelector('.error'), null, 'the error goes while it retries');
});

// ---- channels (Task 11)
const CINIT = { type: 'init', ref: { kind: 'channel', teamId: 'T', id: 'C' }, title: 'Product Team › chirp-test', members: [], kind: 'channel' };
test('channel cards with last two replies and N more', () => {
  const p = page(); p.send(CINIT);
  const replies = Array.from({ length: 5 }, (_, i) => m('r' + i, { html: 'reply ' + i }));
  p.send({ type: 'messages', reset: true, messages: [m('p1', { html: 'first post', subject: 'Release', replies }), m('p2', { html: 'second post', replies: [] })] });
  const cards = [...p.d.querySelectorAll('.messages .card')];
  assert.strictEqual(cards.length, 2);
  assert.strictEqual(cards[0].querySelector('.post .subject').textContent, 'Release');
  assert.deepStrictEqual([...cards[0].querySelectorAll('.replies .msg .body')].map((x) => x.textContent), ['reply 3', 'reply 4']);
  const more = cards[0].querySelector('.show-replies');
  assert.strictEqual(more.textContent, '3 more replies');
  more.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(cards[0].querySelectorAll('.replies .msg').length, 5);
  assert.strictEqual(cards[1].querySelector('.show-replies'), null);
  p.send({ type: 'messages', messages: [m('p1', { html: 'first post', replies: replies.concat([m('r5', { html: 'reply 5' })]) })] });
  const again = p.d.querySelector('.card');
  assert.strictEqual(again.querySelectorAll('.replies .msg').length, 6, 'an expanded card stays expanded when updated');
});

// ---- posting in channels (Task 12)
test('reply goes to its post id', () => {
  const p = page(); p.send(Object.assign({}, CINIT, { canSend: true }));
  p.send({ type: 'messages', reset: true, messages: [m('p1', { replies: [] }), m('p2', { replies: [] })] });
  const box = p.d.querySelectorAll('.card')[1].querySelector('.reply textarea');
  assert.strictEqual(box.placeholder, 'Reply');
  box.value = 'my reply';
  box.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const sent = p.posted.filter((x) => x.type === 'send');
  assert.deepStrictEqual([sent[0].text, sent[0].target], ['my reply', { postId: 'p2' }]);
  assert.strictEqual(p.d.querySelectorAll('.card')[1].querySelector('.replies .msg.pending .body').textContent, 'my reply', 'pending under its post');
  const main = p.d.querySelector('.composer textarea');
  assert.strictEqual(main.placeholder, 'Start a new post');
  main.value = 'new post'; main.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.strictEqual(p.posted.filter((x) => x.type === 'send').at(-1).target, undefined, 'a new post has no target');
});

test('forbidden disables all boxes with the reason', () => {
  const p = page(); p.send(Object.assign({}, CINIT, { canSend: true }));
  p.send({ type: 'messages', reset: true, messages: [m('p1', { replies: [] })] });
  const main = p.d.querySelector('.composer textarea');
  main.value = 'x'; main.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const { pendingId } = p.posted.find((x) => x.type === 'send');
  p.send({ type: 'failed', pendingId, error: 'Forbidden', retryable: true, forbidden: true });
  assert.ok([...p.d.querySelectorAll('textarea')].every((t) => t.disabled));
  assert.strictEqual(p.d.querySelector('.readonly').textContent, 'Teams refused posting here (403).');
  p.send({ type: 'messages', messages: [m('p9', { replies: [] })] });
  assert.ok([...p.d.querySelectorAll('textarea')].every((t) => t.disabled), 'new cards come disabled too');
});

test('removed messages leave the page', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, messages: [m('1'), m('2'), m('3')] });
  p.send({ type: 'removed', ids: ['2', 'nope'] });
  assert.deepStrictEqual([...p.d.querySelectorAll('.msg')].map((x) => x.dataset.id), ['1', '3']);
  p.send({ type: 'messages', messages: [m('2', { html: 'back?' })] });
  assert.deepStrictEqual([...p.d.querySelectorAll('.msg')].map((x) => x.dataset.id), ['1', '3', '2'], 'a removed id is forgotten');
});

test('emoji show as their character', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'messages', reset: true, messages: [m('1', { html: '<p>nice <emoji id="smile" alt="🙂" title="Smile"></emoji></p>' }), m('2', { html: '<img alt="👍" itemtype="http://schema.skype.com/Emoji" src="https://x/y.png">' })] });
  assert.deepStrictEqual([...p.d.querySelectorAll('.msg .body')].map((b) => b.textContent), ['nice 🙂', '👍']);
});

test('a reply being typed survives its card being redrawn', () => {
  const p = page(); p.send(Object.assign({}, CINIT, { canSend: true }));
  p.send({ type: 'messages', reset: true, messages: [m('p1', { replies: [] })] });
  const box = p.d.querySelector('.card .reply textarea');
  box.value = 'half a thought';
  p.send({ type: 'messages', messages: [m('p1', { replies: [m('r1', { html: 'someone replied' })] })] });
  const after = p.d.querySelector('.card .reply textarea');
  assert.strictEqual(after.value, 'half a thought');
  assert.strictEqual(after, box, 'the same box, so focus stays too');
  box.value = 'sent now'; box.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  p.send({ type: 'messages', messages: [m('p1', { replies: [m('r1', { html: 'someone replied' }), m('r2', { html: 'another' })] })] });
  assert.ok(p.d.querySelector('.card .replies .msg.pending'), 'a pending reply stays until it is answered');
});

test('a load error shows in the tab', () => {
  const p = page(); p.send(INIT);
  p.send({ type: 'error', text: "Couldn't load this conversation. Retrying." });
  assert.strictEqual(p.d.querySelector('.load-error').textContent, "Couldn't load this conversation. Retrying.");
  p.send({ type: 'messages', reset: true, messages: [m('1')] });
  assert.strictEqual(p.d.querySelector('.load-error'), null, 'gone once it loads');
});

// ---- @mentions in the message box
const PEOPLE = [{ id: 'j', name: 'Jordan Lee' }, { id: 'p', name: 'Priya Shah' }, { id: 'm', name: 'Mia Torres' }];
function typeIn(p, ta, text) { ta.value = text; ta.selectionStart = ta.selectionEnd = text.length; ta.dispatchEvent(new p.w.Event('input', { bubbles: true })); }
const keyOn = (p, ta, k) => ta.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

test('typing @ lists matching members; Enter picks one', () => {
  const p = page(); p.send(Object.assign({}, INIT, { canSend: true, people: PEOPLE }));
  const ta = p.d.querySelector('.composer textarea');
  typeIn(p, ta, 'hello @');
  assert.deepStrictEqual([...p.d.querySelectorAll('.mention-list .person')].map((x) => x.textContent), ['Jordan Lee', 'Mia Torres', 'Priya Shah']);
  typeIn(p, ta, 'hello @pri');
  assert.deepStrictEqual([...p.d.querySelectorAll('.mention-list .person')].map((x) => x.textContent), ['Priya Shah']);
  keyOn(p, ta, 'Enter');
  assert.strictEqual(ta.value, 'hello @Priya Shah ');
  assert.strictEqual(p.d.querySelector('.mention-list'), null, 'the list closes');
  assert.strictEqual(p.posted.filter((x) => x.type === 'send').length, 0, 'Enter picked, it did not send');
  typeIn(p, ta, ta.value + 'thanks');
  keyOn(p, ta, 'Enter');
  const sent = p.posted.find((x) => x.type === 'send');
  assert.deepStrictEqual([sent.text, sent.mentions], ['hello @Priya Shah thanks', [{ name: 'Priya Shah', userId: 'p' }]]);
});

test('arrow keys move, Escape closes, a removed name is not mentioned', () => {
  const p = page(); p.send(Object.assign({}, INIT, { canSend: true, people: PEOPLE }));
  const ta = p.d.querySelector('.composer textarea');
  typeIn(p, ta, '@');
  keyOn(p, ta, 'ArrowDown');
  assert.strictEqual(p.d.querySelector('.mention-list .person.selected').textContent, 'Mia Torres');
  keyOn(p, ta, 'Tab');
  assert.strictEqual(ta.value, '@Mia Torres ');
  typeIn(p, ta, 'x @');
  keyOn(p, ta, 'Escape');
  assert.strictEqual(p.d.querySelector('.mention-list'), null);
  keyOn(p, ta, 'Enter');
  const sent = p.posted.find((x) => x.type === 'send');
  assert.deepStrictEqual(sent.mentions, [], 'Mia was picked, then her name was typed over');
});

test('clicking a name picks it; no people, no list', () => {
  const p = page(); p.send(Object.assign({}, INIT, { canSend: true, people: PEOPLE }));
  const ta = p.d.querySelector('.composer textarea');
  typeIn(p, ta, 'cc @jo');
  p.d.querySelector('.mention-list .person').dispatchEvent(new p.w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.strictEqual(ta.value, 'cc @Jordan Lee ');
  const q = page(); q.send(Object.assign({}, CINIT, { canSend: true }));
  const box = q.d.querySelector('.composer textarea');
  typeIn(q, box, 'hey @');
  assert.strictEqual(q.d.querySelector('.mention-list'), null, 'channels have no list yet');
});
