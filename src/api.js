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
const sendChatMessage = (g, chatId, content, mentions) => g.post(`/chats/${e(chatId)}/messages`, mentions && mentions.length ? Object.assign(html(content), { mentions }) : html(content));

async function joinedTeams(g) { const r = await g.get('/me/joinedTeams'); return (r && r.value) || []; }
async function channels(g, teamId) { const r = await g.get(`/teams/${e(teamId)}/channels`); return (r && r.value) || []; }

/** Posts newest first, each with its replies. */
async function channelMessages(g, teamId, channelId, { top = 20, next } = {}) {
  const r = await g.get(next || `${chan(teamId, channelId)}/messages?$top=${top}&$expand=replies`);
  return { posts: (r && r.value) || [], next: (r && r['@odata.nextLink']) || null };
}

const postChannelMessage = (g, teamId, channelId, content) => g.post(`${chan(teamId, channelId)}/messages`, html(content));
const replyToPost = (g, teamId, channelId, postId, content) => g.post(`${chan(teamId, channelId)}/messages/${e(postId)}/replies`, html(content));

/** Set or remove a reaction on a chat message, channel post, or channel reply. */
function react(g, target, reactionType, on) {
  const base = target.kind === 'chat' ? `/chats/${e(target.chatId)}/messages/${e(target.id)}`
    : `${chan(target.teamId, target.channelId)}/messages/${e(target.postId || target.id)}` + (target.postId ? `/replies/${e(target.id)}` : '');
  return g.post(`${base}/${on ? 'setReaction' : 'unsetReaction'}`, { reactionType });
}

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

/** People in the directory whose name or mail starts with `text` (User.ReadBasic.All). */
async function findPeople(g, text, top = 8) {
  const q = String(text).replace(/'/g, "''");
  const filter = `startswith(displayName,'${q}') or startswith(givenName,'${q}') or startswith(surname,'${q}') or startswith(mail,'${q}')`;
  const r = await g.get(`/users?$filter=${e(filter)}&$select=id,displayName,mail&$top=${top}`);
  return (r && r.value) || [];
}

/** Opens a 1:1 with someone (Chat.Create). Graph hands back the existing 1:1 if there is one. */
function startChat(g, meId, userId) {
  const member = (id) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${id}')` });
  return g.post('/chats', { chatType: 'oneOnOne', members: [member(meId), member(userId)] });
}

module.exports = { findPeople, startChat, me, listChats, chatMessages, markChatRead, sendChatMessage, joinedTeams, channels, channelMessages, postChannelMessage, replyToPost, channelMessage, postReplies, searchMessages, react };
