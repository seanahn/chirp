'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { htmlToText, textToHtml, sameText } = require('../src/html');

test('teams html to text', () => {
  assert.strictEqual(htmlToText('<p>Hi <at id="0">Sean Ahn</at>,</p><p>a &amp; b<br>c</p>'), 'Hi @Sean Ahn,\na & b\nc');
  assert.strictEqual(htmlToText('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
  assert.strictEqual(htmlToText('x<img src="u" alt="chart">'), 'x[image: chart]');
  assert.strictEqual(htmlToText('x<img src="u">'), 'x[image]');
  assert.strictEqual(htmlToText('&#128512; &#x41;&nbsp;'), '😀 A');
  assert.strictEqual(htmlToText('<script>alert(1)</script>ok'), 'alert(1)ok');
  assert.strictEqual(htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
  assert.strictEqual(htmlToText(''), '');
  assert.strictEqual(htmlToText(null), '');
});

test('text to html escapes and keeps lines', () => {
  assert.strictEqual(textToHtml('a < b & "c"\nd'), 'a &lt; b &amp; &quot;c&quot;<br>d');
  assert.strictEqual(textToHtml("it's"), 'it&#39;s');
});

test('sameText ignores whitespace shape', () => {
  assert.ok(sameText('a  b\nc', ' a b c '));
  assert.ok(!sameText('a b', 'a c'));
});

test('emoji keep their character', () => {
  assert.strictEqual(htmlToText('ok <emoji id="smile" alt="🙂" title="Smile"></emoji>'), 'ok 🙂');
  assert.strictEqual(htmlToText('<emoji id="x" alt="👍" title="Like"></emoji>'), '👍');
  assert.strictEqual(htmlToText('a<img alt="🙂" itemtype="http://schema.skype.com/Emoji" src="u">'), 'a🙂');
});

// ---- @mentions in sent messages
const { withMentions } = require('../src/html');
test('picked names become Teams mentions, in order', () => {
  const r = withMentions('hi @Jordan Lee and @Priya Shah!', [{ name: 'Priya Shah', userId: 'p' }, { name: 'Jordan Lee', userId: 'j' }]);
  assert.strictEqual(r.html, 'hi <at id="0">Jordan Lee</at> and <at id="1">Priya Shah</at>!');
  assert.deepStrictEqual(r.mentions, [
    { id: 0, mentionText: 'Jordan Lee', mentioned: { user: { id: 'j', displayName: 'Jordan Lee', userIdentityType: 'aadUser' } } },
    { id: 1, mentionText: 'Priya Shah', mentioned: { user: { id: 'p', displayName: 'Priya Shah', userIdentityType: 'aadUser' } } },
  ]);
  assert.strictEqual(htmlToText(r.html), 'hi @Jordan Lee and @Priya Shah!', 'the double-post check still matches the typed text');
});
test('a picked name no longer in the text is not mentioned; names are escaped', () => {
  const r = withMentions('a & b, @O\'Neil <x>', [{ name: "O'Neil <x>", userId: 'o' }, { name: 'Gone Person', userId: 'g' }]);
  assert.strictEqual(r.html, 'a &amp; b, <at id="0">O&#39;Neil &lt;x&gt;</at>');
  assert.strictEqual(r.mentions.length, 1);
  assert.deepStrictEqual(withMentions('plain\ntext', []), { html: 'plain<br>text', mentions: [] });
});
