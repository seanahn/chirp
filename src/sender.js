'use strict';
// Sending a message so that nothing goes out twice (design 101, "Sending"): a 429 is resent once after Retry-After; a
// clear refusal fails with Retry; when the outcome is unknown (timeout, network, a 5xx), the latest messages are checked
// for this one before Retry is offered.
const { GraphError, GraphTimeout } = require('./graph');
const { Offline } = require('./tokenStore');
const { textToHtml, htmlToText, sameText } = require('./html');

const RETRY_AFTER_DEFAULT_MS = 5000;
const SKEW_MS = 5000;
const CHECK_LATEST = 20;

function createSender({ api, g, meId, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  function post(target, html) {
    if (target.kind === 'chat') return api.sendChatMessage(g, target.chatId, html);
    if (target.kind === 'post') return api.postChannelMessage(g, target.teamId, target.channelId, html);
    return api.replyToPost(g, target.teamId, target.channelId, target.postId, html);
  }
  async function latest(target) {
    if (target.kind === 'chat') return (await api.chatMessages(g, target.chatId, { top: CHECK_LATEST })).messages;
    if (target.kind === 'post') return (await api.channelMessages(g, target.teamId, target.channelId, { top: CHECK_LATEST })).posts;
    return api.postReplies(g, target.teamId, target.channelId, target.postId, { top: CHECK_LATEST });
  }
  /** Whether our message went out after all: { found } when the check ran, { failed: true } when it could not. */
  async function check(target, text, since) {
    try {
      return { found: (await latest(target)).find((m) => m.from && m.from.user && m.from.user.id === meId
        && Date.parse(m.createdDateTime) >= since - SKEW_MS && sameText(htmlToText(m.body && m.body.content), text)) || null };
    } catch (_) { return { failed: true }; }
  }
  const unknown = (e) => e instanceof GraphTimeout || e instanceof Offline || (e instanceof GraphError && e.status >= 500 && e.status !== 503);
  const fail = (e, extra) => Object.assign({ ok: false, error: (e && e.message) || 'Not sent', retryable: true, forbidden: false }, extra);

  /**
   * @param opts.since  for a Retry: when the first attempt began. The earlier attempt is looked for first, and nothing is
   *                    posted if that check can't be made, so a Retry never doubles a message that did go out.
   */
  async function send(target, text, { since } = {}) {
    const html = textToHtml(text);
    if (since != null) {
      const c = await check(target, text, since);
      if (c.failed) return fail(null, { error: 'Not sent (could not check whether the first try went out)' });
      if (c.found) return { ok: true, message: c.found };
    }
    const started = since != null ? since : now();
    let resent = false;
    for (;;) {
      try {
        return { ok: true, message: await post(target, html) };
      } catch (e) {
        if (e instanceof GraphError && (e.status === 429 || e.status === 503) && !resent) {
          resent = true;
          await sleep(e.retryAfterMs != null ? e.retryAfterMs : RETRY_AFTER_DEFAULT_MS);
          continue;
        }
        if (unknown(e)) {
          const c = await check(target, text, started);
          return c.found ? { ok: true, message: c.found } : fail(e, { error: 'Not sent (no answer from Teams)' });
        }
        if (e instanceof GraphError && e.status === 403) return fail(e, { forbidden: true });
        return fail(e);
      }
    }
  }
  return { send };
}

module.exports = { createSender };
