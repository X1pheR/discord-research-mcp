'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ArchiveAdapter, loadArchiveSources, provenance, resolveRuntimeTarget } = require('../src/archive');

class FakeNative {
  constructor() { this.calls = []; }
  async call(name, args) {
    this.calls.push({ name, args });
    if (name === 'get_stats') {
      return { accounts: [
        { ID: 1, SourceType: 'discord_local', Identifier: '700', DisplayName: 'Synthetic Guild' },
        { ID: 9, SourceType: 'gmail', Identifier: 'user@example.com', DisplayName: 'Mail' },
      ] };
    }
    if (name === 'search_message_bodies') {
      assert.equal(args.account, '700');
      return { data: [
        { id: 11, source_id: 1, source_message_id: '901', conversation_id: 41, source_conversation_id: '801', sent_at: '2026-01-02T00:00:00Z', message_type: 'discord', snippet: 'direct', matches: [] },
        { id: 12, source_id: 1, source_message_id: '902', conversation_id: 42, source_conversation_id: '802', sent_at: '2026-01-01T00:00:00Z', message_type: 'discord', snippet: 'mirror', matches: [] },
      ], has_more: false };
    }
    if (name === 'get_message') {
      if (args.id === 99) return { id: 99, source_id: 9, message_type: 'discord', source_message_id: '999' };
      const mirror = args.id === 12;
      return {
        id: args.id,
        source_id: 1,
        message_type: 'discord',
        source_message_id: mirror ? '902' : '901',
        conversation_id: mirror ? 42 : 41,
        source_conversation_id: mirror ? '802' : '801',
        sent_at: mirror ? '2026-01-01T00:00:00Z' : '2026-01-02T00:00:00Z',
        from: [{ email: '990', name: 'Test User' }],
        body_text: 'test body',
        body_length: 9,
        body_returned: args.max_chars === 1 ? 1 : 9,
        has_more: args.max_chars === 1,
        source_provenance: mirror ? {
          kind: 'public_git_mirror',
          repository: 'example/public-archive',
          repository_url: 'https://example.invalid/archive',
          commit: '0123456789abcdef',
          archive_paths: ['threads/802.json'],
          author_identity: 'display_name_only',
          lifecycle_authority: 'append_only_snapshot_no_edit_delete_authority',
        } : undefined,
        attachments: [],
      };
    }
    if (name === 'list_messages') {
      assert.equal(args.account, '700');
      return { data: [
        { id: 11, source_id: 1, source_message_id: '901', conversation_id: 41, source_conversation_id: '801', sent_at: '2026-01-02T00:00:00Z', message_type: 'discord', snippet: 'direct' },
      ], has_more: false };
    }
    if (name === 'search_in_message') {
      return { data: args.id === 11 ? [{ snippet: 'test body', char_offset: 0, line: 1 }] : [] };
    }
    throw new Error('unexpected call ' + name);
  }
}

test('archive selection derives only unique configured guild identifiers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-research-'));
  const file = path.join(dir, 'selection.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, sources: [
    { guild_id: '700', channel_id: '800' },
    { guild_id: '700', channel_id: '801' },
  ] }));
  assert.deepEqual(loadArchiveSources(file), ['700']);
});

test('archive backend resolves only a loopback daemon runtime record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-research-runtime-'));
  const good = path.join(dir, 'daemon.json');
  fs.writeFileSync(good, JSON.stringify({ address: '127.0.0.1:3032' }));
  assert.deepEqual(resolveRuntimeTarget(good), { host: '127.0.0.1', port: 3032 });
  fs.writeFileSync(good, JSON.stringify({ address: '192.0.2.10:3032' }));
  assert.throws(() => resolveRuntimeTarget(good), /invalid_archive_backend/);
  assert.throws(() => resolveRuntimeTarget('relative.json'), /invalid_archive_backend/);
});

test('provenance distinguishes public mirror from direct local RPC observation', () => {
  assert.deepEqual(provenance({}, '2026-01-01'), {
    acquisition: 'local_rpc_observation',
    complete_history: false,
  });
  const value = provenance({ source_provenance: {
    kind: 'public_git_mirror',
    repository: 'example/public-archive',
    commit: '0123456789abcdef',
  } }, '2026-01-01');
  assert.equal(value.acquisition, 'public_git_mirror');
  assert.equal(value.complete_history, false);
  assert.equal(value.mirror.repository, 'example/public-archive');
  assert.equal(value.mirror.commit, '0123456789abcdef');
  assert.equal(value.mirror.cutoff, '2026-01-01');
});

test('search is archive-only, source-scoped and returns explicit provenance', async () => {
  const native = new FakeNative();
  const adapter = new ArchiveAdapter({ nativeClient: native, sourceIdentifiers: ['700'], mirrorCutoff: '2026-01-01' });
  const out = await adapter.searchMessages({ query: 'test', limit: 10 });
  assert.equal(out.returned, 2);
  assert.equal(out.data[0].provenance.acquisition, 'local_rpc_observation');
  assert.equal(out.data[1].provenance.acquisition, 'public_git_mirror');
  assert.equal(out.data[1].provenance.mirror.cutoff, '2026-01-01');
  assert.ok(native.calls.every(call => !String(call.name).includes('discord')));
});

test('direct get_message cannot escape configured archive source scope', async () => {
  const adapter = new ArchiveAdapter({ nativeClient: new FakeNative(), sourceIdentifiers: ['700'] });
  await assert.rejects(adapter.getMessage({ archive_id: 99 }), /archive_scope_mismatch/);
});

test('thread search is bounded and local', async () => {
  const native = new FakeNative();
  const adapter = new ArchiveAdapter({ nativeClient: native, sourceIdentifiers: ['700'] });
  const out = await adapter.searchThread({ archive_conversation_id: 41, query: 'test', limit: 5 });
  assert.equal(out.returned, 1);
  assert.equal(out.scanned_messages, 1);
  assert.equal(out.data[0].archive_id, 11);
  assert.ok(native.calls.some(call => call.name === 'search_in_message'));
});
