'use strict';
// Microsoft Graph over fetch: a token from the Auth (auth.js) on every request, one refresh and retry on a 401, a timeout on every
// request, and errors that say what happened (GraphError with the status and Retry-After, GraphTimeout, Offline).
const { Offline } = require('./tokenStore');

const BASE = 'https://graph.microsoft.com/v1.0';

class GraphError extends Error {
  constructor(status, code, message, retryAfterMs) { super(message || `Graph error ${status}`); this.name = 'GraphError'; this.status = status; this.code = code || null; this.retryAfterMs = retryAfterMs; }
}
class GraphTimeout extends Error { constructor() { super('Teams did not answer in time'); this.name = 'GraphTimeout'; } }

function createGraph({ tokens, fetch, timeoutMs = 30000 }) {
  async function once(method, url, body, token) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) throw new GraphTimeout();
      throw new Offline();
    } finally { clearTimeout(timer); }
  }

  async function request(method, pathOrUrl, body) {
    const url = /^https:\/\//.test(pathOrUrl) ? pathOrUrl : BASE + pathOrUrl;
    let res = await once(method, url, body, await tokens.accessToken());
    if (res.status === 401) res = await once(method, url, body, await tokens.refresh());
    if (res.status === 204 || res.status === 202) return null;
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
    if (!res.ok) {
      const ra = res.headers.get('retry-after');
      const err = (data && data.error) || {};
      throw new GraphError(res.status, err.code, err.message, ra && !isNaN(Number(ra)) ? Number(ra) * 1000 : null);
    }
    return data;
  }

  async function getAll(path, max) {
    const out = [];
    let next = path;
    while (next && out.length < max) {
      const page = await request('GET', next);
      out.push(...((page && page.value) || []));
      next = page && page['@odata.nextLink'];
    }
    return out.slice(0, max);
  }

  return { get: (p) => request('GET', p), post: (p, body) => request('POST', p, body === undefined ? {} : body), getAll };
}

module.exports = { createGraph, GraphError, GraphTimeout, BASE };
