'use strict';
// Which conversations mention Sean, kept across restarts in the extension's global state: flags until the conversation
// is opened, the search hits already looked at, and the time chirp first ran (older hits never count).
const { mentionsUser } = require('./model');

const KEY = 'chirp.mentions';
const SEARCH_SIZE = 25;
const SEEN_CAP = 500;

function createMentionState(memento, now = Date.now) {
  const s = Object.assign({ flagged: {}, seen: [], baseline: null }, memento.get(KEY) || {});
  if (!s.baseline) s.baseline = now();
  const save = () => { memento.update(KEY, s); };
  save();
  return {
    flag(convId, messageId) { if (s.flagged[convId] === messageId) return; s.flagged[convId] = messageId; save(); },
    clear(convId) { if (!(convId in s.flagged)) return; delete s.flagged[convId]; save(); },
    isFlagged: (convId) => convId in s.flagged,
    flagged: () => Object.keys(s.flagged),
    seen: (messageId) => s.seen.includes(messageId),
    markSeen(messageId) { if (s.seen.includes(messageId)) return; s.seen.push(messageId); if (s.seen.length > SEEN_CAP) s.seen = s.seen.slice(-SEEN_CAP); save(); },
    baseline: () => s.baseline,
    /** Forget everything: flags, seen hits and the baseline (signing out, or another account). */
    reset() { s.flagged = {}; s.seen = []; s.baseline = now(); save(); },
  };
}

/** Search hits that are channel messages, with what it takes to fetch each. */
function channelHits(hits) {
  return (hits || []).map((h) => h && h.resource).filter((r) => r && r.channelIdentity && r.channelIdentity.teamId && r.channelIdentity.channelId)
    .map((r) => ({ teamId: r.channelIdentity.teamId, channelId: r.channelIdentity.channelId, messageId: r.id, replyToId: r.replyToId || null, created: r.createdDateTime }));
}

/**
 * One pass of the channel mention check (design 101, "Polling and mentions"): search recent messages for Sean's name,
 * then fetch each new channel hit and flag its channel only if its mentions really include him. A hit that fails to
 * fetch stays unseen, so the next pass tries it again.
 */
async function scanChannelMentions({ api, g, me, state }) {
  const hits = channelHits(await api.searchMessages(g, `"${me.displayName}"`, SEARCH_SIZE));
  for (const h of hits) {
    if (state.seen(h.messageId) || !(Date.parse(h.created) >= state.baseline())) continue;
    let message;
    try { message = await api.channelMessage(g, h.teamId, h.channelId, h.messageId, h.replyToId); } catch (e) { if (e && e.status === 404) state.markSeen(h.messageId); continue; }
    state.markSeen(h.messageId);
    if (message && mentionsUser(message, me.id)) state.flag(`channel:${h.teamId}/${h.channelId}`, h.messageId);
  }
}

module.exports = { createMentionState, channelHits, scanChannelMentions, SEEN_CAP, SEARCH_SIZE, KEY };
