'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const observations = require('../src/observations');

function fixtureChannel() {
  return {
    id: '300',
    guild_id: '200',
    type: 0,
    name: 'general',
    messages: [
      {
        id: '501',
        channel_id: '300',
        guild_id: '200',
        content: 'hello',
        type: 0,
        timestamp: '2026-09-21T20:00:00.000Z',
        author: { id: '601', username: 'alice' },
        attachments: [],
      },
    ],
  };
}

function fixtureSource(channel = fixtureChannel()) {
  return observations.deriveSourceIdentity(channel, { id: '999' });
}

test('snapshot emits container followed by complete messages', () => {
  const channel = fixtureChannel();
  const result = observations.snapshotObservations(channel, fixtureSource(channel));
  assert.equal(result.length, 2);
  assert.equal(result[0].version, 1);
  assert.equal(result[0].kind, 'container');
  assert.equal(result[0].channel.id, '300');
  assert.equal(result[0].channel.messages, undefined);
  assert.equal(result[1].kind, 'message');
  assert.equal(result[1].message.content, 'hello');
  assert.equal(result[1].message.channel_id, '300');
});

test('DM/group-compatible channel without guild id stays valid', () => {
  const channel = { id: '400', type: 1, name: 'Alice' };
  const result = observations.containerObservation(channel, fixtureSource(channel));
  assert.equal(result.channel.id, '400');
  assert.equal(result.channel.guild_id, undefined);
});

test('explicit delete is the only deletion observation', () => {
  const source = fixtureSource();
  assert.deepEqual(observations.deleteObservation('501', source), {
    version: 1,
    kind: 'delete',
    source_type: 'discord_local',
    source_identifier: '200',
    message_id: '501',
  });
  assert.throws(() => observations.deleteObservation('not-an-id', source), /snowflake/);
});

test('event completeness and snapshot lookup are conservative', () => {
  const complete = fixtureChannel().messages[0];
  assert.equal(observations.completeEventMessage(complete), true);
  assert.equal(observations.completeEventMessage({ id: '501' }), false);
  assert.equal(observations.findMessage(fixtureChannel(), '501').content, 'hello');
  assert.equal(observations.findMessage(fixtureChannel(), '999'), null);
});

test('observation path rejects traversal', () => {
  assert.equal(
    observations.resolveObservationPath('events.jsonl', '/tmp/observations'),
    '/tmp/observations/events.jsonl',
  );
  assert.throws(
    () => observations.resolveObservationPath('../events.jsonl', '/tmp/observations'),
    /filename/,
  );
});

test('atomic snapshot and append keep JSONL valid with owner-only file mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-observation-test-'));
  const file = path.join(dir, 'events.jsonl');

  try {
    const channel = fixtureChannel();
    const source = fixtureSource(channel);
    observations.writeObservationsAtomic(file, observations.snapshotObservations(channel, source));
    observations.appendObservation(file, observations.deleteObservation('501', source));

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(line => line.kind), ['container', 'message', 'delete']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SDD-DLE-002/003 derives guild source from guild snowflake', () => {
  assert.deepEqual(
    observations.deriveSourceIdentity(
      { id: '800', guild_id: '700', type: 0, name: 'guild channel' },
      { id: '999' },
    ),
    {
      source_type: 'discord_local',
      source_identifier: '700',
      source_scope: 'guild',
    },
  );
});

test('SDD-DLE-002/003 derives DM source from authenticated Discord user snowflake', () => {
  assert.deepEqual(
    observations.deriveSourceIdentity(
      { id: '801', type: 1, name: 'DM' },
      { id: '999' },
    ),
    {
      source_type: 'discord_local',
      source_identifier: 'account:999',
      source_scope: 'account',
    },
  );
});

test('SDD-DLE-002/003 derives group-DM source from authenticated account', () => {
  assert.equal(
    observations.deriveSourceIdentity(
      { id: '802', type: 3, name: 'Group DM' },
      { id: '999' },
    ).source_identifier,
    'account:999',
  );
});

test('SDD-DLE-003 fails closed for account-scoped channel without authenticated user id', () => {
  assert.throws(
    () => observations.deriveSourceIdentity({ id: '801', type: 1 }, null),
    /authenticated Discord user id/,
  );
});

test('SDD-DLE-003 fails closed for non-DM container without guild identity', () => {
  assert.throws(
    () => observations.deriveSourceIdentity({ id: '803', type: 0 }, { id: '999' }),
    /cannot derive Discord local source/,
  );
});

test('SDD-DLE-003/004 embeds derived source identity in every snapshot observation', () => {
  const channel = fixtureChannel();
  const source = observations.deriveSourceIdentity(channel, { id: '999' });
  const result = observations.snapshotObservations(channel, source);

  assert.ok(result.length > 1);
  for (const item of result) {
    assert.equal(item.source_type, 'discord_local');
    assert.equal(item.source_identifier, '200');
  }
});

test('SDD-DLE-003/004 explicit delete is source-bound', () => {
  const source = {
    source_type: 'discord_local',
    source_identifier: 'account:999',
    source_scope: 'account',
  };
  assert.deepEqual(observations.deleteObservation('501', source), {
    version: 1,
    kind: 'delete',
    source_type: 'discord_local',
    source_identifier: 'account:999',
    message_id: '501',
  });
});

test('SDD-DLE-006 normalizes RPC mention snowflake strings to canonical user objects', () => {
  const channel = fixtureChannel();
  const source = fixtureSource(channel);
  const message = {
    ...channel.messages[0],
    mentions: ['777', { id: '778', username: 'known' }],
  };
  const observation = observations.messageObservation(channel, message, source);
  assert.deepEqual(observation.message.mentions[0], { id: '777' });
  assert.equal(observation.message.mentions[1].id, '778');
});

test('SDD-DLE-006 projects RPC embed text and media aliases into canonical Discord fields', () => {
  const channel = fixtureChannel();
  const source = fixtureSource(channel);
  const message = {
    ...channel.messages[0],
    embeds: [{
      type: 'rich',
      rawTitle: 'title text',
      rawDescription: 'description text',
      thumbnail: { url: 'https://example.test/x', proxyURL: 'https://proxy.test/x', width: 10, height: 20 },
    }],
  };
  const observation = observations.messageObservation(channel, message, source);
  const embed = observation.message.embeds[0];
  assert.equal(embed.title, 'title text');
  assert.equal(embed.description, 'description text');
  assert.equal(embed.rawTitle, 'title text');
  assert.equal(embed.rawDescription, 'description text');
  assert.equal(embed.thumbnail.proxy_url, 'https://proxy.test/x');
  assert.equal(embed.thumbnail.proxyURL, 'https://proxy.test/x');
});

test('SDD-DLE-006 preserves non-numeric RPC embed color outside canonical color', () => {
  const channel = fixtureChannel();
  const source = fixtureSource(channel);
  const message = {
    ...channel.messages[0],
    embeds: [{
      type: 'rich',
      color: 'hsla(0, calc(var(--saturation-factor, 1) * 100%), 50%, 1)',
    }],
  };
  const observation = observations.messageObservation(channel, message, source);
  const embed = observation.message.embeds[0];
  assert.equal(embed.color, undefined);
  assert.equal(
    embed.rpc_color,
    'hsla(0, calc(var(--saturation-factor, 1) * 100%), 50%, 1)',
  );
});
