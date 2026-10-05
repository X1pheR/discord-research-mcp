'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OBSERVATION_VERSION = 1;
const LOCAL_SOURCE_TYPE = 'discord_local';
const SNOWFLAKE = /^[0-9]+$/;

function requireSnowflake(value, label) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!SNOWFLAKE.test(text) || text === '0') {
    throw new Error(label + ' must be a Discord snowflake');
  }
  return text;
}

// SDD-DLE-015: only explicit typed selection can authorize forward capture.
function validateSelection(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.sources) ||
      Object.keys(config).some(key => !['version', 'sources'].includes(key))) {
    throw new Error('invalid source selection');
  }
  const seen = new Set();
  return config.sources.map(source => {
    if (!source || Object.keys(source).some(key => !['guild_id', 'channel_id'].includes(key)) ||
        typeof source.guild_id !== 'string' || typeof source.channel_id !== 'string') {
      throw new Error('invalid source selection');
    }
    const guild_id = requireSnowflake(source.guild_id, 'selected guild');
    const channel_id = requireSnowflake(source.channel_id, 'selected channel');
    if (seen.has(channel_id)) throw new Error('duplicate source selection');
    seen.add(channel_id);
    return { guild_id, channel_id };
  });
}

// SDD-DLE-021: never serialize arbitrary provider exceptions or OAuth bodies.
function diagnosticError(error) {
  const status=Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
  return {reason:'provider_failure',status};
}

// SDD-DLE-017: an atomically published complete file is the existing importer handoff.
// Unpublished temporary files are ignored; acknowledged files are removed by the importer.
function publishPendingBatch(directory, observations) {
  if(!Array.isArray(observations)||!observations.length) throw new Error('observations are required');
  for(const observation of observations) normalizeSourceIdentity(observation);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  let sequence=BigInt(Date.now()) * 1000000n;
  for(const filename of fs.readdirSync(directory)) {
    const match=/^forward-([0-9]{20})\.jsonl$/.exec(filename);
    if(match && BigInt(match[1]) >= sequence) sequence=BigInt(match[1])+1n;
  }
  const file=path.join(directory,'forward-'+String(sequence).padStart(20,'0')+'.jsonl');
  writeObservationsAtomic(file,observations);
  return file;
}
function publishPending(directory, observation) {
  return publishPendingBatch(directory,[observation]);
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  )));
}

function normalizeChannel(channel, fallbackGuildId = null) {
  if (!channel || typeof channel !== 'object') throw new Error('channel is required');
  const out = jsonClone(channel);
  out.id = requireSnowflake(channel.id, 'channel.id');

  if (channel.guild_id !== null && channel.guild_id !== undefined && channel.guild_id !== '') {
    out.guild_id = requireSnowflake(channel.guild_id, 'channel.guild_id');
  } else if (fallbackGuildId) {
    out.guild_id = requireSnowflake(fallbackGuildId, 'fallback guild id');
  }

  for (const key of ['parent_id', 'owner_id', 'last_message_id']) {
    if (out[key] !== null && out[key] !== undefined && out[key] !== '') {
      out[key] = requireSnowflake(out[key], 'channel.' + key);
    }
  }

  delete out.messages;
  return out;
}

function normalizeEmbedMedia(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) return media;
  const out = jsonClone(media);
  if (
    !Object.prototype.hasOwnProperty.call(out, 'proxy_url') &&
    Object.prototype.hasOwnProperty.call(out, 'proxyURL')
  ) {
    out.proxy_url = out.proxyURL;
  }
  return out;
}

function normalizeEmbed(embed) {
  if (!embed || typeof embed !== 'object' || Array.isArray(embed)) {
    throw new Error('message.embeds[] must be an object');
  }
  const out = jsonClone(embed);
  if (
    !Object.prototype.hasOwnProperty.call(out, 'title') &&
    Object.prototype.hasOwnProperty.call(out, 'rawTitle')
  ) {
    out.title = out.rawTitle;
  }
  if (
    !Object.prototype.hasOwnProperty.call(out, 'description') &&
    Object.prototype.hasOwnProperty.call(out, 'rawDescription')
  ) {
    out.description = out.rawDescription;
  }
  if (
    Object.prototype.hasOwnProperty.call(out, 'color') &&
    typeof out.color !== 'number'
  ) {
    out.rpc_color = out.color;
    delete out.color;
  }
  for (const key of ['thumbnail', 'image', 'video']) {
    if (out[key]) out[key] = normalizeEmbedMedia(out[key]);
  }
  return out;
}

function normalizeMessage(message, channel) {
  if (!message || typeof message !== 'object') throw new Error('message is required');
  const out = jsonClone(message);
  out.id = requireSnowflake(message.id, 'message.id');

  const channelId = message.channel_id || (channel && channel.id);
  out.channel_id = requireSnowflake(channelId, 'message.channel_id');

  const guildId = message.guild_id || (channel && channel.guild_id);
  if (guildId) out.guild_id = requireSnowflake(guildId, 'message.guild_id');

  if (out.author && out.author.id !== null && out.author.id !== undefined) {
    out.author.id = String(out.author.id);
  }
  if (Array.isArray(out.mentions)) {
    out.mentions = out.mentions.map(mention => {
      if (typeof mention === 'string' || typeof mention === 'number') {
        return { id: requireSnowflake(mention, 'message.mentions[].id') };
      }
      if (!mention || typeof mention !== 'object' || Array.isArray(mention)) {
        throw new Error('message.mentions[] must be a Discord snowflake or user object');
      }
      const user = jsonClone(mention);
      user.id = requireSnowflake(user.id, 'message.mentions[].id');
      return user;
    });
  }
  if (Array.isArray(out.embeds)) {
    out.embeds = out.embeds.map(normalizeEmbed);
  }
  if (Array.isArray(out.attachments)) {
    for (const attachment of out.attachments) {
      if (attachment && attachment.id !== null && attachment.id !== undefined) {
        attachment.id = String(attachment.id);
      }
    }
  }
  if (out.message_reference) {
    for (const key of ['message_id', 'channel_id', 'guild_id']) {
      if (out.message_reference[key]) out.message_reference[key] = String(out.message_reference[key]);
    }
  }

  return out;
}

function deriveSourceIdentity(channel, authenticatedUser, fallbackGuildId = null) {
  const normalized = normalizeChannel(channel, fallbackGuildId);
  if (normalized.guild_id) {
    return {
      source_type: LOCAL_SOURCE_TYPE,
      source_identifier: normalized.guild_id,
      source_scope: 'guild',
    };
  }

  const channelType = Number(normalized.type);
  if (channelType === 1 || channelType === 3) {
    const userId = requireSnowflake(
      authenticatedUser && authenticatedUser.id,
      'authenticated Discord user id',
    );
    return {
      source_type: LOCAL_SOURCE_TYPE,
      source_identifier: 'account:' + userId,
      source_scope: 'account',
    };
  }

  throw new Error(
    'cannot derive Discord local source: non-DM container has no guild identity',
  );
}

function normalizeSourceIdentity(sourceIdentity) {
  if (!sourceIdentity || sourceIdentity.source_type !== LOCAL_SOURCE_TYPE) {
    throw new Error('source identity must use source_type=' + LOCAL_SOURCE_TYPE);
  }

  const identifier = String(sourceIdentity.source_identifier || '');
  if (identifier.startsWith('account:')) {
    requireSnowflake(identifier.slice('account:'.length), 'account source identifier');
  } else {
    requireSnowflake(identifier, 'guild source identifier');
  }

  return {
    source_type: LOCAL_SOURCE_TYPE,
    source_identifier: identifier,
  };
}

function bindSource(observation, sourceIdentity) {
  const source = normalizeSourceIdentity(sourceIdentity);
  return {
    ...observation,
    source_type: source.source_type,
    source_identifier: source.source_identifier,
  };
}

function containerObservation(channel, sourceIdentity, fallbackGuildId = null) {
  return bindSource({
    version: OBSERVATION_VERSION,
    kind: 'container',
    channel: normalizeChannel(channel, fallbackGuildId),
  }, sourceIdentity);
}

function messageObservation(channel, message, sourceIdentity, fallbackGuildId = null) {
  const normalizedChannel = normalizeChannel(channel, fallbackGuildId);
  return bindSource({
    version: OBSERVATION_VERSION,
    kind: 'message',
    channel: normalizedChannel,
    message: normalizeMessage(message, normalizedChannel),
  }, sourceIdentity);
}

function deleteObservation(messageId, sourceIdentity) {
  return bindSource({
    version: OBSERVATION_VERSION,
    kind: 'delete',
    message_id: requireSnowflake(messageId, 'message_id'),
  }, sourceIdentity);
}

function snapshotObservations(channel, sourceIdentity, fallbackGuildId = null) {
  const normalized = normalizeChannel(channel, fallbackGuildId);
  const messages = Array.isArray(channel && channel.messages) ? channel.messages : [];
  return [
    containerObservation(normalized, sourceIdentity),
    ...messages.map(message => messageObservation(
      normalized,
      message,
      sourceIdentity,
    )),
  ];
}

function completeEventMessage(data) {
  const message = data && (data.message || data);
  return Boolean(
    message &&
    message.id &&
    message.timestamp &&
    message.author &&
    message.author.id &&
    Object.prototype.hasOwnProperty.call(message, 'content') &&
    message.type !== undefined
  );
}

function eventMessage(data) {
  return data && (data.message || data);
}

function eventMessageId(data) {
  const message = eventMessage(data);
  return message && message.id ? String(message.id) : null;
}

function findMessage(channel, messageId) {
  if (!channel || !Array.isArray(channel.messages) || !messageId) return null;
  return channel.messages.find(message => String(message.id) === String(messageId)) || null;
}

function observationDirectory() {
  return process.env.DISCORD_OBSERVATION_DIR || '/observations';
}

function resolveObservationPath(filename, directory = observationDirectory()) {
  if (!filename) throw new Error('--output is required');
  if (path.basename(filename) !== filename || filename === '.' || filename === '..') {
    throw new Error('--output must be a filename without directory separators');
  }
  return path.join(directory, filename);
}

function encodeObservation(observation) {
  return JSON.stringify(observation) + '\n';
}

function writeObservationsAtomic(file, observations) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temp = path.join(
    directory,
    '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now(),
  );
  const payload = observations.map(encodeObservation).join('');

  try {
    fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    const fd=fs.openSync(temp,'r');
    try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(temp, file);
    const dirfd=fs.openSync(directory,'r');
    try {fs.fsyncSync(dirfd);} finally {fs.closeSync(dirfd);}
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function appendObservation(file, observation) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, encodeObservation(observation), null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

module.exports = {
  diagnosticError,
  publishPending,
  publishPendingBatch,
  validateSelection,
  OBSERVATION_VERSION,
  LOCAL_SOURCE_TYPE,
  appendObservation,
  deriveSourceIdentity,
  completeEventMessage,
  containerObservation,
  deleteObservation,
  eventMessage,
  eventMessageId,
  findMessage,
  messageObservation,
  normalizeChannel,
  normalizeSourceIdentity,
  normalizeMessage,
  resolveObservationPath,
  snapshotObservations,
  writeObservationsAtomic,
};
