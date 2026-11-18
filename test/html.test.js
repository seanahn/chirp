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
