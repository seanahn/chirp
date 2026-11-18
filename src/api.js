'use strict';
// The Teams endpoints chirp uses (design 101, "Polling and mentions" and "Sending"). Each takes the graph from graph.js.
const e = encodeURIComponent;
const html = (content) => ({ body: { contentType: 'html', content } });
const chan = (teamId, channelId) => `/teams/${e(teamId)}/channels/${e(channelId)}`;

async function me(g) { const m = await g.get('/me'); return { id: m.id, displayName: m.displayName }; }

async function listChats(g) {
  const r = await g.get('/me/chats?$expand=lastMessagePreview,members&$orderby=lastMessagePreview/createdDateTime desc&$top=50');
  return (r && r.value) || [];
}

/** Newest first. `next` is the nextLink of the previous page, for older messages. */
async function chatMessages(g, chatId, { top = 50, next } = {}) {
  const r = await g.get(next || `/chats/${e(chatId)}/messages?$top=${top}`);
  return { messages: (r && r.value) || [], next: (r && r['@odata.nextLink']) || null };
}

const markChatRead = (g, chatId, meId, tenantId) => g.post(`/chats/${e(chatId)}/markChatReadForUser`, { user: { id: meId, tenantId } });
const sendChatMessage = (g, chatId, content) => g.post(`/chats/${e(chatId)}/messages`, html(content));

async function joinedTeams(g) { const r = await g.get('/me/joinedTeams'); return (r && r.value) || []; }
async function channels(g, teamId) { const r = await g.get(`/teams/${e(teamId)}/channels`); return (r && r.value) || []; }

/** Posts newest first, each with its replies. */
async function channelMessages(g, teamId, channelId, { top = 20, next } = {}) {
  const r = await g.get(next || `${chan(teamId, channelId)}/messages?$top=${top}&$expand=replies`);
  return { posts: (r && r.value) || [], next: (r && r['@odata.nextLink']) || null };
}

const postChannelMessage = (g, teamId, channelId, content) => g.post(`${chan(teamId, channelId)}/messages`, html(content));
const replyToPost = (g, teamId, channelId, postId, content) => g.post(`${chan(teamId, channelId)}/messages/${e(postId)}/replies`, html(content));

/** One post, or, with replyToId, one reply. Graph refuses $expand=replies here: a post's replies come from postReplies. */
function channelMessage(g, teamId, channelId, messageId, replyToId) {
  return replyToId
    ? g.get(`${chan(teamId, channelId)}/messages/${e(replyToId)}/replies/${e(messageId)}`)
    : g.get(`${chan(teamId, channelId)}/messages/${e(messageId)}`);
}

/** A post's replies, newest first. */
async function postReplies(g, teamId, channelId, postId, { top = 20 } = {}) {
  const r = await g.get(`${chan(teamId, channelId)}/messages/${e(postId)}/replies?$top=${top}`);
  return (r && r.value) || [];
}

async function searchMessages(g, queryString, size = 25) {
  const r = await g.post('/search/query', { requests: [{ entityTypes: ['chatMessage'], query: { queryString }, from: 0, size }] });
  const containers = ((r && r.value && r.value[0]) || {}).hitsContainers || [];
  return containers.flatMap((c) => c.hits || []);
}

module.exports = { me, listChats, chatMessages, markChatRead, sendChatMessage, joinedTeams, channels, channelMessages, postChannelMessage, replyToPost, channelMessage, postReplies, searchMessages };
