'use strict';

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const Observations = require('./observations');

const MAX_SOCKET_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_SOURCES = 8;
const MAX_SEARCH_RESULTS = 20;
const MAX_LIST_RESULTS = 30;
const MAX_THREAD_SCAN = 30;
const SNOWFLAKE = /^[1-9][0-9]*$/;

function safeError(code) {
  const error = new Error(code);
  error.safeCode = code;
  return error;
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw safeError('invalid_request');
  return value;
}

function loadArchiveSources(selectionPath) {
  const config = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  const selected = Observations.validateSelection(config);
  const sources = [...new Set(selected.map(source => source.guild_id))];
  if (!sources.length || sources.length > MAX_ARCHIVE_SOURCES) throw safeError('invalid_archive_scope');
  for (const source of sources) {
    if (!SNOWFLAKE.test(source)) throw safeError('invalid_archive_scope');
  }
  return sources;
}

function parseToolResult(result) {
  if (result?.isError) throw safeError('archive_query_failed');
  const text = Array.isArray(result?.content)
    ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text
    : null;
  if (!text) throw safeError('invalid_archive_response');
  try {
    return JSON.parse(text);
  } catch {
    throw safeError('invalid_archive_response');
  }
}

function resolveRuntimeTarget(runtimeFile) {
  if (!path.isAbsolute(runtimeFile)) throw safeError('invalid_archive_backend');
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const address = String(runtime.address || '');
  if (!address.startsWith('127.0.0.1:')) throw safeError('invalid_archive_backend');
  const portText = address.slice('127.0.0.1:'.length);
  if (!/^[0-9]+$/.test(portText)) throw safeError('invalid_archive_backend');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw safeError('invalid_archive_backend');
  return { host: '127.0.0.1', port };
}

function requestJSON(target, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.host,
      port: target.port,
      method: 'GET',
      path: pathname,
      headers: { accept: 'application/json', host: target.host + ':' + target.port },
    }, res => {
      let raw = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_SOCKET_BYTES) {
          req.destroy();
          reject(safeError('archive_response_too_large'));
          return;
        }
        raw += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          reject(safeError('archive_query_failed'));
          return;
        }
        try { resolve(JSON.parse(raw)); } catch { reject(safeError('invalid_archive_response')); }
      });
    });
    req.setTimeout(30000, () => req.destroy(safeError('archive_unavailable')));
    req.on('error', () => reject(safeError('archive_unavailable')));
    req.end();
  });
}

function firstAuthor(value) {
  if (Array.isArray(value)) return value[0] || null;
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value) return { email: value, name: null };
  return null;
}

class RestArchiveClient {
  constructor(runtimeFile) {
    this.runtimeFile = runtimeFile;
    this.sourceMap = null;
  }

  target() {
    return resolveRuntimeTarget(this.runtimeFile);
  }

  async get(pathname, params = {}) {
    const url = new URL('http://127.0.0.1' + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return requestJSON(this.target(), url.pathname + url.search);
  }

  async sources() {
    const payload = await this.get('/api/v1/sources/status', { source_type: 'discord_local' });
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    this.sourceMap = new Map(sources.map(item => [String(item.identifier || ''), Number(item.id)]));
    return sources;
  }

  async sourceId(identifier) {
    if (!this.sourceMap) await this.sources();
    const id = this.sourceMap.get(String(identifier));
    if (!Number.isInteger(id) || id < 1) throw safeError('archive_scope_unavailable');
    return id;
  }

  async detail(id) {
    return this.get('/api/v1/messages/' + encodeURIComponent(String(id)));
  }

  async call(name, args) {
    if (name === 'get_stats') {
      const sources = await this.sources();
      return {
        accounts: sources.map(item => ({
          ID: Number(item.id),
          SourceType: item.source_type,
          Identifier: String(item.identifier || ''),
          DisplayName: item.display_name || null,
        })),
      };
    }

    if (name === 'search_message_bodies') {
      const page = await this.get('/api/v1/search', {
        q: args.query,
        mode: 'fts',
        page: 1,
        page_size: Math.min(Number(args.limit || 50), 100),
        message_type: 'discord',
        account: args.account,
      });
      const data = Array.isArray(page?.messages) ? page.messages : [];
      return { data, has_more: Number(page?.total || 0) > data.length };
    }

    if (name === 'get_message') {
      const detail = await this.detail(args.id);
      const body = String(detail.body || '');
      const offset = Math.max(0, Number(args.offset || 0));
      const maxChars = Math.max(1, Number(args.max_chars || body.length || 1));
      const sliced = body.slice(offset, offset + maxChars);
      const author = firstAuthor(detail.from);
      return {
        ...detail,
        from: author ? [author] : [],
        body_text: sliced,
        body_length: body.length,
        body_returned: sliced.length,
        offset,
        has_more: offset + sliced.length < body.length,
      };
    }

    if (name === 'list_messages') {
      const sourceId = await this.sourceId(args.account);
      const page = await this.get('/api/v1/messages/filter', {
        source_id: sourceId,
        conversation_id: args.conversation_id,
        message_type: 'discord',
        limit: args.limit,
        offset: args.offset,
        sort: 'date',
        direction: 'asc',
      });
      return { data: page?.messages || [], has_more: Boolean(page?.has_more) };
    }

    if (name === 'search_in_message') {
      const detail = await this.detail(args.id);
      const body = String(detail.body || '');
      const needle = String(args.query || '').trim();
      if (!needle) return { data: [] };
      const lower = body.toLowerCase();
      const q = needle.toLowerCase();
      const matches = [];
      let pos = 0;
      while (matches.length < Math.max(1, Number(args.limit || 5))) {
        const at = lower.indexOf(q, pos);
        if (at < 0) break;
        const line = body.slice(0, at).split('\n').length;
        const left = Math.max(0, at - 120);
        const right = Math.min(body.length, at + needle.length + 180);
        matches.push({ char_offset: at, line, snippet: body.slice(left, right) });
        pos = at + Math.max(needle.length, 1);
      }
      return { data: matches };
    }

    throw safeError('archive_query_failed');
  }

  proxy(req, res) {
    let target;
    try { target = this.target(); } catch {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('msgvault unavailable');
      return;
    }
    const upstreamAuthority = target.host + ':' + target.port;
    const headers = { ...req.headers, host: upstreamAuthority };
    if (headers.origin) headers.origin = 'http://' + upstreamAuthority;
    if (headers.referer) {
      try {
        const referer = new URL(headers.referer);
        referer.protocol = 'http:';
        referer.host = upstreamAuthority;
        headers.referer = referer.toString();
      } catch {
        delete headers.referer;
      }
    }
    delete headers.forwarded;
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-port'];
    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    });
    req.pipe(upstream);
  }
}

function provenance(detail, mirrorCutoff = null) {
  const source = detail?.source_provenance;
  if (source?.kind === 'public_git_mirror') {
    return {
      acquisition: 'public_git_mirror',
      complete_history: false,
      mirror: {
        repository: source.repository || null,
        repository_url: source.repository_url || null,
        commit: source.commit || null,
        archive_paths: Array.isArray(source.archive_paths) ? source.archive_paths : [],
        author_identity: source.author_identity || null,
        lifecycle_authority: source.lifecycle_authority || null,
        cutoff: mirrorCutoff || null,
      },
    };
  }
  return {
    acquisition: 'local_rpc_observation',
    complete_history: false,
  };
}

function messageSummary(hit, detail, mirrorCutoff) {
  return {
    archive_id: hit.id,
    message_id: hit.source_message_id || detail?.source_message_id || null,
    archive_conversation_id: hit.conversation_id || detail?.conversation_id || null,
    channel_id: hit.source_conversation_id || detail?.source_conversation_id || null,
    sent_at: hit.sent_at || detail?.sent_at || null,
    author: {
      id: hit.from_email || detail?.from?.[0]?.email || null,
      display_name: hit.from_name || detail?.from?.[0]?.name || null,
    },
    snippet: hit.snippet || '',
    matches: Array.isArray(hit.matches) ? hit.matches : [],
    provenance: provenance(detail, mirrorCutoff),
  };
}

function messageDetail(detail, mirrorCutoff) {
  return {
    archive_id: detail.id,
    message_id: detail.source_message_id || null,
    archive_conversation_id: detail.conversation_id || null,
    channel_id: detail.source_conversation_id || null,
    sent_at: detail.sent_at || null,
    author: {
      id: detail.from?.[0]?.email || null,
      display_name: detail.from?.[0]?.name || null,
    },
    body: detail.body_text || detail.body_html || '',
    body_format: detail.body_text ? 'text' : (detail.body_html ? 'html' : 'text'),
    body_length: detail.body_length ?? null,
    body_returned: detail.body_returned ?? null,
    offset: detail.offset ?? 0,
    has_more: Boolean(detail.has_more),
    attachments: Array.isArray(detail.attachments)
      ? detail.attachments.map(item => ({
          id: item.id ?? null,
          filename: item.filename || null,
          mime_type: item.mime_type || item.MimeType || null,
          size: item.size ?? item.Size ?? null,
        }))
      : [],
    provenance: provenance(detail, mirrorCutoff),
  };
}

class ArchiveAdapter {
  constructor({ nativeClient, sourceIdentifiers, mirrorCutoff = null }) {
    this.native = nativeClient;
    this.sources = [...sourceIdentifiers];
    this.mirrorCutoff = mirrorCutoff || null;
    this.allowedSourceIds = null;
  }

  async ensureScope() {
    if (this.allowedSourceIds) return this.allowedSourceIds;
    const stats = await this.native.call('get_stats', {});
    const ids = new Set();
    for (const account of stats?.accounts || []) {
      const sourceType = account.SourceType ?? account.source_type;
      const identifier = String(account.Identifier ?? account.identifier ?? '');
      const id = account.ID ?? account.id;
      if (sourceType === 'discord_local' && this.sources.includes(identifier) && Number.isInteger(id)) ids.add(id);
    }
    if (ids.size !== this.sources.length) throw safeError('archive_scope_unavailable');
    this.allowedSourceIds = ids;
    return ids;
  }

  async detailForHit(hit) {
    const allowed = await this.ensureScope();
    const detail = await this.native.call('get_message', { id: hit.id, max_chars: 1 });
    if (detail?.message_type !== 'discord' || !allowed.has(detail?.source_id)) {
      throw safeError('archive_scope_mismatch');
    }
    return detail;
  }

  async searchMessages({ query, limit = 10, offset = 0 }) {
    if (typeof query !== 'string' || !query.trim()) throw safeError('invalid_request');
    limit = boundedInteger(limit, 10, 1, MAX_SEARCH_RESULTS);
    offset = boundedInteger(offset, 0, 0, 100000);

    const perSource = [];
    for (const source of this.sources) {
      const page = await this.native.call('search_message_bodies', {
        query: query.trim(),
        account: source,
        limit: 50,
        offset: 0,
      });
      for (const hit of page?.data || []) {
        if (hit?.message_type === 'discord') perSource.push(hit);
      }
    }
    perSource.sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || '')) || Number(b.id) - Number(a.id));
    const selected = perSource.slice(offset, offset + limit);
    const data = [];
    for (const hit of selected) {
      const detail = await this.detailForHit(hit);
      data.push(messageSummary(hit, detail, this.mirrorCutoff));
    }
    return {
      data,
      returned: data.length,
      offset,
      has_more: perSource.length > offset + data.length,
      archive_sources: this.sources.length,
      complete_history: false,
    };
  }

  async getMessage({ archive_id, offset = 0, max_chars = 2000 }) {
    archive_id = boundedInteger(archive_id, null, 1, Number.MAX_SAFE_INTEGER);
    offset = boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    max_chars = boundedInteger(max_chars, 2000, 1, 4000);
    const allowed = await this.ensureScope();
    const detail = await this.native.call('get_message', { id: archive_id, offset, max_chars });
    if (detail?.message_type !== 'discord' || !allowed.has(detail?.source_id)) {
      throw safeError('archive_scope_mismatch');
    }
    return messageDetail(detail, this.mirrorCutoff);
  }

  async listMessages({ archive_conversation_id, limit = 20, offset = 0 }) {
    archive_conversation_id = boundedInteger(archive_conversation_id, null, 1, Number.MAX_SAFE_INTEGER);
    limit = boundedInteger(limit, 20, 1, MAX_LIST_RESULTS);
    offset = boundedInteger(offset, 0, 0, 100000);

    const merged = [];
    let upstreamHasMore = false;
    for (const source of this.sources) {
      const page = await this.native.call('list_messages', {
        account: source,
        conversation_id: archive_conversation_id,
        limit,
        offset,
      });
      upstreamHasMore ||= Boolean(page?.has_more);
      for (const hit of page?.data || []) {
        if (hit?.message_type === 'discord') merged.push(hit);
      }
    }
    merged.sort((a, b) => String(a.sent_at || '').localeCompare(String(b.sent_at || '')) || Number(a.id) - Number(b.id));
    const data = [];
    for (const hit of merged.slice(0, limit)) {
      const detail = await this.detailForHit(hit);
      data.push(messageSummary(hit, detail, this.mirrorCutoff));
    }
    return {
      archive_conversation_id,
      data,
      returned: data.length,
      offset,
      has_more: upstreamHasMore || merged.length > limit,
      complete_history: false,
    };
  }

  async searchThread({ archive_conversation_id, query, limit = 10, offset = 0 }) {
    archive_conversation_id = boundedInteger(archive_conversation_id, null, 1, Number.MAX_SAFE_INTEGER);
    if (typeof query !== 'string' || !query.trim()) throw safeError('invalid_request');
    limit = boundedInteger(limit, 10, 1, MAX_SEARCH_RESULTS);
    offset = boundedInteger(offset, 0, 0, 100000);

    const messages = await this.listMessages({
      archive_conversation_id,
      limit: MAX_THREAD_SCAN,
      offset: 0,
    });
    const hits = [];
    for (const item of messages.data) {
      const matchPage = await this.native.call('search_in_message', {
        id: item.archive_id,
        query: query.trim(),
        limit: 5,
        offset: 0,
      });
      const matches = Array.isArray(matchPage?.data) ? matchPage.data : (Array.isArray(matchPage) ? matchPage : []);
      if (matches.length) hits.push({ ...item, matches });
      if (hits.length >= offset + limit) break;
    }
    return {
      archive_conversation_id,
      data: hits.slice(offset, offset + limit),
      returned: Math.max(0, Math.min(limit, hits.length - offset)),
      offset,
      scanned_messages: messages.data.length,
      scan_limit: MAX_THREAD_SCAN,
      has_more: messages.has_more || hits.length > offset + limit,
      complete_history: false,
    };
  }

  async dispatch(request) {
    if (!request || typeof request !== 'object') throw safeError('invalid_request');
    const keys = Object.keys(request);
    if (!keys.includes('op') || keys.some(key => !['op', 'args'].includes(key))) throw safeError('invalid_request');
    const args = request.args && typeof request.args === 'object' ? request.args : {};
    switch (request.op) {
      case 'search_messages': return this.searchMessages(args);
      case 'get_message': return this.getMessage(args);
      case 'list_messages': return this.listMessages(args);
      case 'search_thread': return this.searchThread(args);
      default: throw safeError('invalid_request');
    }
  }
}

function requestArchive(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let bytes = 0;
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(30000);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_SOCKET_BYTES) {
        socket.destroy();
        reject(safeError('archive_response_too_large'));
        return;
      }
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      socket.end();
      try { resolve(JSON.parse(line)); } catch { reject(safeError('invalid_archive_response')); }
    });
    socket.on('timeout', () => socket.destroy(safeError('archive_unavailable')));
    socket.on('error', () => reject(safeError('archive_unavailable')));
  });
}

async function startArchiveBridge({ socketPath, runtimeFile, webSocketPath = null, selectionPath, mirrorCutoff = null }) {
  if (!path.isAbsolute(socketPath)) throw new Error('archive_socket_must_be_absolute');
  const sources = loadArchiveSources(selectionPath);
  const adapter = new ArchiveAdapter({
    nativeClient: new RestArchiveClient(runtimeFile),
    sourceIdentifiers: sources,
    mirrorCutoff,
  });

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const server = net.createServer(socket => {
    let bytes = 0;
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) {
        socket.end(JSON.stringify({ ok: false, error: 'invalid_request' }) + '\n');
        return;
      }
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = '';
      (async () => {
        try {
          const result = await adapter.dispatch(JSON.parse(line));
          socket.end(JSON.stringify({ ok: true, result }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, error: error.safeCode || 'archive_query_failed' }) + '\n');
        }
      })();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o660);
      server.removeListener('error', reject);
      resolve();
    });
  });

  let webServer = null;
  if (webSocketPath) {
    if (!path.isAbsolute(webSocketPath)) throw new Error('archive_web_socket_must_be_absolute');
    fs.mkdirSync(path.dirname(webSocketPath), { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(webSocketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    webServer = http.createServer((req, res) => adapter.native.proxy(req, res));
    webServer.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      webServer.once('error', reject);
      webServer.listen(webSocketPath, () => {
        fs.chmodSync(webSocketPath, 0o660);
        webServer.removeListener('error', reject);
        resolve();
      });
    });
  }

  return {
    close: () => Promise.all([
      new Promise(done => server.close(() => {
        try { fs.unlinkSync(socketPath); } catch {}
        done();
      })),
      webServer ? new Promise(done => webServer.close(() => {
        try { fs.unlinkSync(webSocketPath); } catch {}
        done();
      })) : Promise.resolve(),
    ]),
  };
}

module.exports = {
  ArchiveAdapter,
  RestArchiveClient,
  loadArchiveSources,
  messageDetail,
  messageSummary,
  provenance,
  requestArchive,
  startArchiveBridge,
  resolveRuntimeTarget,
};
