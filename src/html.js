'use strict';
// Teams message bodies are HTML. The ~/.chirp files and the sidebar previews want plain text; sending wants the reverse.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    if (e[0] === '#' && e !== '#39') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (_) { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Plain text from a Teams HTML body: line breaks kept, mentions as @Name, images as [image: alt]. */
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, '@$1');
  const alt = (tag) => { const a = /\balt\s*=\s*"([^"]*)"/i.exec(tag); return a ? a[1] : ''; };
  s = s.replace(/<emoji\b[^>]*>(?:[\s\S]*?<\/emoji>)?/gi, (tag) => alt(tag));
  s = s.replace(/<img\b[^>]*itemtype="[^"]*Emoji[^"]*"[^>]*>/gi, (tag) => alt(tag));
  s = s.replace(/<img\b[^>]*>/gi, (tag) => { const a = /\balt\s*=\s*"([^"]*)"/i.exec(tag); return a && a[1] ? `[image: ${a[1]}]` : '[image]'; });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decode(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** A typed message as the HTML Graph is sent: escaped, newlines as <br>. */
function textToHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r?\n/g, '<br>');
}

/** Whether two texts are the same message, whitespace aside. */
function sameText(a, b) {
  const n = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}

module.exports = { htmlToText, textToHtml, sameText };
