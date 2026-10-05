'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
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

function validateArchiveURL(value) {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.pathname !== '/mcp') {
    throw safeError('invalid_archive_backend');
  }
  return url;
}

class NativeArchiveClient {
  constructor(url) {
    this.url = validateArchiveURL(url);
    this.client = null;
    this.transport = null;
  }

  async connect() {
    if (this.client) return this.client;
    const client = new Client({ name: 'discord-research-archive-bridge', version: '0.5.0' });
    const transport = new StreamableHTTPClientTransport(this.url);
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    return client;
  }

  async reset() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    try { await client?.close(); } catch {}
  }

  async call(name, args) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const client = await this.connect();
        return parseToolResult(await client.callTool({ name, arguments: args }));
      } catch (error) {
        await this.reset();
        if (attempt === 1) throw safeError(error?.safeCode || 'archive_unavailable');
      }
    }
    throw safeError('archive_unavailable');
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

async function startArchiveBridge({ socketPath, mcpUrl, selectionPath, mirrorCutoff = null }) {
  if (!path.isAbsolute(socketPath)) throw new Error('archive_socket_must_be_absolute');
  const sources = loadArchiveSources(selectionPath);
  const adapter = new ArchiveAdapter({
    nativeClient: new NativeArchiveClient(mcpUrl),
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

  return {
    close: () => new Promise(done => server.close(() => {
      try { fs.unlinkSync(socketPath); } catch {}
      done();
    })),
  };
}

module.exports = {
  ArchiveAdapter,
  NativeArchiveClient,
  loadArchiveSources,
  messageDetail,
  messageSummary,
  provenance,
  requestArchive,
  startArchiveBridge,
  validateArchiveURL,
};
