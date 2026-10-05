'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/control');

test('SDD-DLE-025 read channel performs one provider read and returns bounded snapshot', async () => {
  let reads = 0;
  const client = { getChannel: async id => {
    reads += 1;
    return { id, guild_id: '700', name: 'research', type: 0, messages: [
      { id: '900', channel_id: id, guild_id: '700', content: 'hello', timestamp: '2026-01-01T00:00:00Z', author: { id: '990', username: 'u' }, attachments: [{ id: '1', filename: 'a.txt', size: 3, url: 'https://secret.invalid' }] },
    ] };
  }};
  const out = await C.readChannel(() => client, '800');
  assert.equal(reads, 1);
  assert.equal(out.channel.id, '800');
  assert.equal(out.coverage, 'bounded_current_client_snapshot');
  assert.equal(out.complete_history, false);
  assert.equal(out.messages[0].content, 'hello');
  assert.equal(out.messages[0].attachments[0].filename, 'a.txt');
  assert.equal('url' in out.messages[0].attachments[0], false);
});

test('SDD-DLE-025 unavailable and identity mismatch fail closed', async () => {
  await assert.rejects(C.readChannel(() => null, '800'), /provider_unavailable/);
  await assert.rejects(C.readChannel(() => ({ getChannel: async () => ({ id: '801', messages: [] }) }), '800'), /provider_identity_mismatch/);
  await assert.rejects(C.readChannel(() => ({ getChannel: async () => { throw new Error('private provider body'); } }), '800'), error => error.message === 'provider_unavailable');
});
