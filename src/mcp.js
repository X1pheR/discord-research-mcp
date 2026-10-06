'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');
const z = require('zod/v4');
const { requestArchive } = require('./archive');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function requestControl(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let bytes = 0;
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(20000);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE_BYTES) {
        socket.destroy();
        reject(new Error('response_too_large'));
        return;
      }
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      socket.end();
      try { resolve(JSON.parse(line)); } catch { reject(new Error('invalid_control_response')); }
    });
    socket.on('timeout', () => socket.destroy(new Error('provider_unavailable')));
    socket.on('error', () => reject(new Error('provider_unavailable')));
  });
}

function toolResult(response, fallbackError) {
  if (!response?.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: response?.error || fallbackError }) }],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(response.result) }],
    structuredContent: response.result,
  };
}

function buildServer({ controlSocketPath, archiveSocketPath }) {
  const server = new McpServer({ name: 'discord-research-mcp', version: '0.5.3' });

  server.registerTool('read_channel', {
    description: 'Read one explicit account-visible Discord channel through the authorized local Discord RPC session. Returns one bounded current client snapshot; never persists, subscribes, downloads attachment binaries, or claims full history.',
    inputSchema: {
      channel_id: z.string().regex(/^[1-9][0-9]*$/).describe('Exact Discord channel snowflake to read.'),
    },
  }, async ({ channel_id }) => {
    const response = await requestControl(controlSocketPath, { op: 'read_channel', channel_id });
    if (response?.ok && response.result) {
      response.result = {
        ...response.result,
        provenance: { acquisition: 'live_rpc', complete_history: false },
      };
    }
    return toolResult(response, 'provider_unavailable');
  });

  server.registerTool('search_messages', {
    description: 'Search locally archived Discord message bodies within the configured Discord research sources. Archive-only: a miss never contacts Discord.',
    inputSchema: {
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(20).optional(),
      offset: z.number().int().min(0).max(100000).optional(),
    },
  }, async args => toolResult(
    await requestArchive(archiveSocketPath, { op: 'search_messages', args }),
    'archive_unavailable',
  ));

  server.registerTool('get_message', {
    description: 'Read bounded body context for one Discord archive result by archive_id. Returns explicit acquisition provenance and never contacts Discord.',
    inputSchema: {
      archive_id: z.number().int().positive(),
      offset: z.number().int().min(0).optional(),
      max_chars: z.number().int().min(1).max(4000).optional(),
    },
  }, async args => toolResult(
    await requestArchive(archiveSocketPath, { op: 'get_message', args }),
    'archive_unavailable',
  ));

  server.registerTool('list_messages', {
    description: 'List a bounded page of messages in one archived Discord conversation/thread. Archive-only and incomplete-history semantics are explicit.',
    inputSchema: {
      archive_conversation_id: z.number().int().positive(),
      limit: z.number().int().min(1).max(30).optional(),
      offset: z.number().int().min(0).max(100000).optional(),
    },
  }, async args => toolResult(
    await requestArchive(archiveSocketPath, { op: 'list_messages', args }),
    'archive_unavailable',
  ));

  server.registerTool('search_thread', {
    description: 'Search within one archived Discord conversation/thread using bounded local message scans. Archive-only; no provider fallback.',
    inputSchema: {
      archive_conversation_id: z.number().int().positive(),
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(20).optional(),
      offset: z.number().int().min(0).max(100000).optional(),
    },
  }, async args => toolResult(
    await requestArchive(archiveSocketPath, { op: 'search_thread', args }),
    'archive_unavailable',
  ));

  return server;
}

async function runMcpServer({ controlSocketPath, archiveSocketPath, host, port, allowedHosts }) {
  const app = createMcpExpressApp({ host, allowedHosts });
  app.get('/healthz', (_req, res) => {
    const live = fs.existsSync(controlSocketPath);
    const archive = fs.existsSync(archiveSocketPath);
    res.status(live && archive ? 200 : 503).json({
      status: live && archive ? 'ok' : 'unavailable',
      live_rpc: live,
      archive,
    });
  });
  app.post('/mcp', async (req, res) => {
    const server = buildServer({ controlSocketPath, archiveSocketPath });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    } finally {
      res.on('close', () => { transport.close(); server.close(); });
    }
  });
  app.get('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));

  const listener = await new Promise((resolve, reject) => {
    const value = app.listen(port, host, error => error ? reject(error) : resolve(value));
  });
  return new Promise(resolve => {
    const stop = () => listener.close(() => resolve());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

module.exports = { requestControl, buildServer, runMcpServer };
