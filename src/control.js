'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const MAX_REQUEST_BYTES = 4096;
const SNOWFLAKE = /^[1-9][0-9]*$/;

function safeError(code) {
  const error = new Error(code);
  error.safeCode = code;
  return error;
}

function requireChannelId(value) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw safeError('invalid_channel_id');
  return value;
}

function authorView(author) {
  if (!author || typeof author !== 'object') return null;
  return {
    id: author.id ? String(author.id) : null,
    username: author.username || null,
    global_name: author.global_name || author.globalName || null,
    bot: Boolean(author.bot),
  };
}

function attachmentView(attachment) {
  return {
    id: attachment?.id ? String(attachment.id) : null,
    filename: attachment?.filename || null,
    size: Number.isFinite(attachment?.size) ? attachment.size : null,
    content_type: attachment?.content_type || attachment?.contentType || null,
  };
}

function embedView(embed) {
  return {
    type: embed?.type || null,
    title: embed?.title || embed?.rawTitle || null,
    description: embed?.description || embed?.rawDescription || null,
    url: embed?.url || null,
  };
}

function messageView(message) {
  return {
    id: message?.id ? String(message.id) : null,
    channel_id: message?.channel_id ? String(message.channel_id) : null,
    guild_id: message?.guild_id ? String(message.guild_id) : null,
    author: authorView(message?.author),
    content: typeof message?.content === 'string' ? message.content : '',
    timestamp: message?.timestamp || null,
    edited_timestamp: message?.edited_timestamp || null,
    type: Number.isFinite(message?.type) ? message.type : null,
    message_reference: message?.message_reference ? {
      message_id: message.message_reference.message_id ? String(message.message_reference.message_id) : null,
      channel_id: message.message_reference.channel_id ? String(message.message_reference.channel_id) : null,
      guild_id: message.message_reference.guild_id ? String(message.message_reference.guild_id) : null,
    } : null,
    attachments: Array.isArray(message?.attachments) ? message.attachments.map(attachmentView) : [],
    embeds: Array.isArray(message?.embeds) ? message.embeds.map(embedView) : [],
  };
}

function snapshot(channel, requestedChannelId) {
  const requested = requireChannelId(requestedChannelId);
  if (!channel || String(channel.id || '') !== requested) throw safeError('provider_identity_mismatch');
  const messages = Array.isArray(channel.messages) ? channel.messages.map(messageView) : [];
  if (messages.some(message => message.channel_id && message.channel_id !== requested)) {
    throw safeError('provider_identity_mismatch');
  }
  return {
    coverage: 'bounded_current_client_snapshot',
    complete_history: false,
    provider_operation: 'GET_CHANNEL',
    channel: {
      id: requested,
      guild_id: channel.guild_id ? String(channel.guild_id) : null,
      name: channel.name || null,
      type: Number.isFinite(channel.type) ? channel.type : null,
      topic: channel.topic || null,
    },
    message_count: messages.length,
    messages,
  };
}

async function readChannel(getClient, channelId) {
  const requested = requireChannelId(channelId);
  const client = getClient();
  if (!client) throw safeError('provider_unavailable');
  let channel;
  try {
    channel = await client.getChannel(requested);
  } catch {
    throw safeError('provider_unavailable');
  }
  return snapshot(channel, requested);
}

function startControlServer({ socketPath, getClient }) {
  if (!path.isAbsolute(socketPath)) throw new Error('control_socket_must_be_absolute');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const server = net.createServer(socket => {
    let bytes = 0;
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
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
          const request = JSON.parse(line);
          if (!request || request.op !== 'read_channel' || Object.keys(request).some(key => !['op', 'channel_id'].includes(key))) {
            throw safeError('invalid_request');
          }
          const result = await readChannel(getClient, request.channel_id);
          socket.end(JSON.stringify({ ok: true, result }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, error: error.safeCode || 'internal_error' }) + '\n');
        }
      })();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o660);
      server.removeListener('error', reject);
      resolve({
        close: () => new Promise(done => server.close(() => {
          try { fs.unlinkSync(socketPath); } catch {}
          done();
        })),
      });
    });
  });
}

module.exports = { messageView, snapshot, readChannel, startControlServer };
