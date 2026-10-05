'use strict';

const fs = require('node:fs');
const path = require('node:path');
const RPC = require('discord-rpc');
const Observations = require('./observations');
const {TokenState} = require('./token-state');
const Refresh = require('./refresh');

const MESSAGE_EVENTS = ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE'];

function env(name, required = false) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function scopes() {
  return (env('DISCORD_SCOPES') || 'rpc,identify,guilds,messages.read')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function phase(name, extra = {}) {
  console.error(JSON.stringify({ type: 'phase', phase: name, ...extra }));
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toArray(value, nestedKey) {
  if (!value) return [];
  if (nestedKey && value[nestedKey]) return toArray(value[nestedKey]);
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (typeof value.values === 'function') {
    try { return [...value.values()]; } catch {}
  }
  if (typeof value === 'object') return Object.values(value);
  return [];
}

function emitResult(value) {
  const json = JSON.stringify(value, null, 2);
  const resultFile = env('DISCORD_RESULT_FILE');
  if (resultFile) {
    fs.writeFileSync(resultFile, json + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  console.log(json);
}

function timestampMs(message) {
  const value = message && (message.timestamp || message.edited_timestamp);
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function snapshotSummary(channel) {
  const messages = Array.isArray(channel.messages) ? channel.messages : [];
  const times = messages.map(timestampMs).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    channel_id: String(channel.id),
    channel_name: channel.name || null,
    channel_type: channel.type,
    snapshot_message_count: messages.length,
    oldest_timestamp: times.length ? new Date(times[0]).toISOString() : null,
    newest_timestamp: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    message_content_emitted: false,
  };
}

async function connect() {
  const clientId = env('DISCORD_CLIENT_ID', true);
  const client = new RPC.Client({ transport: 'ipc' });
  client.on('error', error => {
    console.error(JSON.stringify({type:'rpc_error',...Observations.diagnosticError(error)}));
  });
  phase('rpc_connect_start');
  try {await withTimeout(client.connect(clientId), 15000, 'RPC_CONNECT');}
  catch(error) {await closeClient(client);throw error;}
  phase('rpc_connect_ok');
  return { client, clientId };
}

async function authorize(client, clientId) {
  const requestedScopes = scopes();

  // Discord RPC AUTHORIZE explicitly does not accept redirect_uri. The returned
  // authorization code is later exchanged at /oauth2/token using a registered
  // redirect URI as part of the standard OAuth2 token exchange.
  phase('authorize_start');
  const result = await withTimeout(client.request('AUTHORIZE', {
    scopes: requestedScopes,
    client_id: clientId,
  }), 300000, 'RPC_AUTHORIZE');
  phase('authorize_ok');

  if (!result || !result.code) throw new Error('AUTHORIZE returned no code');
  return {
    code: result.code,
    redirectUri: env('DISCORD_REDIRECT_URI', true),
    requestedScopes,
  };
}

function readSecretFile(name) {
  const file = env(name, true);
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`${name} file is empty`);
  return value;
}

function persistRefreshToken(body) {
  const out = env('DISCORD_REFRESH_TOKEN_HANDOFF_FILE');
  if (!out || !body || !body.refresh_token) return;
  fs.writeFileSync(out, body.refresh_token, { encoding: 'utf8', mode: 0o600 });
}

async function oauthToken(form) {
  phase('oauth_token_start');
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    const error = new Error(`token exchange failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  persistRefreshToken(body);
  phase('oauth_token_ok', { status: response.status });
  return body;
}

async function exchangeAndAuthenticate(client, clientId, auth) {
  const clientSecret = readSecretFile('DISCORD_CLIENT_SECRET_FILE');
  const body = await oauthToken(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: auth.code,
    grant_type: 'authorization_code',
    redirect_uri: auth.redirectUri,
  }));

  phase('rpc_authenticate_start');
  await withTimeout(client.authenticate(body.access_token), 15000, 'RPC_AUTHENTICATE');
  phase('rpc_authenticate_ok');
  return client;
}

async function refreshAndAuthenticate(client, clientId) {
  const clientSecret = readSecretFile('DISCORD_CLIENT_SECRET_FILE');
  if (env('DISCORD_TOKEN_STATE_FILE')) {
    const state=new TokenState(env('DISCORD_TOKEN_STATE_FILE'),env('DISCORD_REFRESH_TOKEN_FILE',true),clientId);
    client.sessionExpiresAt=await withTimeout(Refresh.refresh(client,clientId,clientSecret,state),45000,'REFRESH_AUTHENTICATE');
    return client;
  }
  const refreshToken = readSecretFile('DISCORD_REFRESH_TOKEN_FILE');
  const body = await oauthToken(new URLSearchParams({
    client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type:'refresh_token',
  }));
  await withTimeout(client.authenticate(body.access_token),15000,'RPC_AUTHENTICATE');
  return client;
}

async function authenticatedClient(unattended=false) {
  const { client, clientId } = await connect();
  if (unattended) {
    if (!env('DISCORD_TOKEN_STATE_FILE')) throw new Error('token_state_required');
    try {await refreshAndAuthenticate(client,clientId);return client;} catch(error) {await closeClient(client);throw error;}
  }
  if (env('DISCORD_REFRESH_TOKEN_FILE') && fs.existsSync(env('DISCORD_REFRESH_TOKEN_FILE'))) {
    phase('auth_mode', { mode: 'refresh' });
    await refreshAndAuthenticate(client, clientId);
    return client;
  }

  phase('auth_mode', { mode: 'authorize' });
  const auth = await authorize(client, clientId);
  await exchangeAndAuthenticate(client, clientId, auth);
  return client;
}

async function closeClient(client) {
  try {
    await Promise.race([
      client.destroy(),
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);
  } catch {}
}

async function main() {
  const command = process.argv[2] || 'help';

  if (command === 'help') {
    console.log('commands: forward | mcp | archive-bridge | seed-forum-threads --guild-id ID --parent-id ID --input-file FILE | socket | authorize | guilds | channels --guild-id ID | channel --channel-id ID | observe-channel --channel-id ID --output FILE [--guild-id ID] | watch --channel-id ID [--seconds 60] | watch-observations --channel-id ID --output FILE [--guild-id ID] [--seconds 60]');
    return;
  }

  if (command === 'socket') {
    const runtime = env('XDG_RUNTIME_DIR') || '/tmp';
    const candidates = Array.from({ length: 10 }, (_, i) => path.join(runtime, `discord-ipc-${i}`));
    const found = candidates.find(p => {
      try { return fs.statSync(p).isSocket(); } catch { return false; }
    });
    if (!found) throw new Error(`No Discord IPC socket found below ${runtime}`);
    console.log(JSON.stringify({ socket_found: true, socket_path: found }));
    return;
  }

  if (command === 'authorize') {
    const { client, clientId } = await connect();
    try {
      const auth = await authorize(client, clientId);
      console.log(JSON.stringify({
        type: 'authorize_complete',
        authorization_code_received: true,
        redirect_uri_for_later_exchange: auth.redirectUri,
        scopes: auth.requestedScopes,
        authorization_code_emitted: false,
        token_exchange_performed: false,
      }));
    } finally {
      await closeClient(client);
    }
    return;
  }

  if (command === 'seed-forum-threads') {
    const guildId=arg('--guild-id');
    const parentId=arg('--parent-id');
    const inputFile=arg('--input-file');
    if(!guildId||!parentId||!inputFile) throw new Error('forum_seed_args_required');
    const sources=Observations.validateSelection(JSON.parse(fs.readFileSync(env('DISCORD_SELECTION_FILE',true),'utf8')));
    const controlSocket=env('DISCORD_CONTROL_SOCKET',true);
    if(fs.existsSync(controlSocket)) throw new Error('collector_must_be_stopped');
    const {ForumState,seedForumThreads}=require('./forum-seed');
    const client=await authenticatedClient(true);
    try{
      const result=await seedForumThreads({
        client,inputFile,guildId,parentId,sources,
        state:new ForumState(env('DISCORD_FORUM_THREAD_STATE_FILE',true)),
        observationDir:env('DISCORD_OBSERVATION_DIR',true),
      });
      emitResult({type:'forum_thread_seed_complete',guild_id:String(guildId),parent_id:String(parentId),...result,message_content_emitted:false});
    }finally{await closeClient(client);}
    return;
  }

  if (command === 'forward') {
    const selection=JSON.parse(fs.readFileSync(env('DISCORD_SELECTION_FILE',true),'utf8'));
    const sources=Observations.validateSelection(selection);
    const healthFile=env('DISCORD_HEALTH_FILE',true);
    // Persisted suspension is operator-reset only, never a restart bypass.
    if (fs.existsSync(healthFile) && JSON.parse(fs.readFileSync(healthFile,'utf8')).status==='suspended') {
      throw new Error('acquisition_suspended');
    }
    const stopped={value:false};
    const previous=fs.existsSync(healthFile)?JSON.parse(fs.readFileSync(healthFile,'utf8')):{};
    process.on('SIGTERM',()=>{stopped.value=true;});
    process.on('SIGINT',()=>{stopped.value=true;});
    const {run}=require('./supervisor');
    const {startControlServer}=require('./control');
    const {ForumState}=require('./forum-seed');
    const forumState=new ForumState(env('DISCORD_FORUM_THREAD_STATE_FILE',true));
    let activeClient=null;
    const control=await startControlServer({
      socketPath:env('DISCORD_CONTROL_SOCKET',true),
      getClient:()=>activeClient,
    });
    try {
      await run({
        sources,stopped,gapSince:previous.gap_since,forumState,
        connect:async()=>{
          const client=await authenticatedClient(true);
          for(const method of ['getGuilds','getChannels','getChannel','subscribe']) {
            const original=client[method].bind(client);
            client[method]=(...args)=>withTimeout(original(...args),15000,'RPC_READ');
          }
          const originalDestroy=client.destroy.bind(client);
          client.destroy=()=>withTimeout(originalDestroy(),2000,'RPC_CLOSE');
          return client;
        },
        emit:observation=>Observations.publishPending(env('DISCORD_OBSERVATION_DIR',true),observation),
        health:status=>Observations.writeObservationsAtomic(healthFile,[{...status,updated_at:new Date().toISOString()}]),
        onClient:client=>{activeClient=client;},
      });
    } finally {
      activeClient=null;
      await control.close();
    }
    // Remain stopped on permanent rejection even with a container restart policy.
    return;
  }

  if (command === 'archive-bridge') {
    const {startArchiveBridge}=require('./archive');
    const bridge=await startArchiveBridge({
      socketPath:env('DISCORD_ARCHIVE_SOCKET',true),
      mcpUrl:env('DISCORD_ARCHIVE_MCP_URL',true),
      selectionPath:env('DISCORD_SELECTION_FILE',true),
      mirrorCutoff:env('DISCORD_MIRROR_CUTOFF')||null,
    });
    const stop=async()=>{await bridge.close();process.exit(0);};
    process.once('SIGTERM',stop);
    process.once('SIGINT',stop);
    await new Promise(()=>{});
    return;
  }

  if (command === 'mcp') {
    const {runMcpServer}=require('./mcp');
    const allowed=(env('DISCORD_MCP_ALLOWED_HOSTS')||'').split(',').map(value=>value.trim()).filter(Boolean);
    await runMcpServer({
      controlSocketPath:env('DISCORD_CONTROL_SOCKET',true),
      archiveSocketPath:env('DISCORD_ARCHIVE_SOCKET',true),
      host:env('DISCORD_MCP_HOST')||'0.0.0.0',
      port:Number(env('DISCORD_MCP_PORT')||3021),
      allowedHosts:allowed.length?allowed:undefined,
    });
    return;
  }

  const client = await authenticatedClient();
  try {
    if (command === 'guilds') {
      phase('get_guilds_start');
      const raw = await withTimeout(client.getGuilds(), 15000, 'GET_GUILDS');
      phase('get_guilds_ok');
      const guilds = toArray(raw, 'guilds').map(g => ({ id: String(g.id), name: g.name || null }));
      emitResult({ type: 'guilds', guild_count: guilds.length, guilds });
      return;
    }

    if (command === 'channels') {
      const guildId = arg('--guild-id');
      if (!guildId) throw new Error('--guild-id is required');
      phase('get_channels_start');
      const raw = await withTimeout(client.getChannels(guildId), 15000, 'GET_CHANNELS');
      phase('get_channels_ok');
      const channels = toArray(raw, 'channels').map(c => ({
        id: String(c.id),
        name: c.name || null,
        type: c.type,
        parent_id: c.parent_id ? String(c.parent_id) : null,
      }));
      emitResult({ type: 'channels', guild_id: guildId, channel_count: channels.length, channels });
      return;
    }

    if (command === 'channel') {
      const channelId = arg('--channel-id');
      if (!channelId) throw new Error('--channel-id is required');
      phase('get_channel_start');
      const channel = await withTimeout(client.getChannel(channelId), 15000, 'GET_CHANNEL');
      phase('get_channel_ok');
      emitResult({ type: 'channel_snapshot', ...snapshotSummary(channel) });
      return;
    }

    if (command === 'observe-channel') {
      const channelId = arg('--channel-id');
      const outputName = arg('--output');
      const guildId = arg('--guild-id');
      if (!channelId) throw new Error('--channel-id is required');
      if (!outputName) throw new Error('--output is required');

      phase('get_channel_start');
      const channel = await withTimeout(client.getChannel(channelId), 15000, 'GET_CHANNEL');
      phase('get_channel_ok');

      const outputFile = Observations.resolveObservationPath(outputName);
      const sourceIdentity = Observations.deriveSourceIdentity(channel, client.user, guildId);
      const observations = Observations.snapshotObservations(channel, sourceIdentity, guildId);
      Observations.writeObservationsAtomic(outputFile, observations);

      emitResult({
        type: 'observation_snapshot_written',
        channel_id: String(channelId),
        source_type: sourceIdentity.source_type,
        source_identifier: sourceIdentity.source_identifier,
        source_scope: sourceIdentity.source_scope,
        output_file: path.basename(outputFile),
        observation_count: observations.length,
        message_count: Math.max(observations.length - 1, 0),
        message_content_emitted_to_stdout: false,
      });
      return;
    }

    if (command === 'watch-observations') {
      const channelId = arg('--channel-id');
      const outputName = arg('--output');
      const guildId = arg('--guild-id');
      if (!channelId) throw new Error('--channel-id is required');
      if (!outputName) throw new Error('--output is required');

      const seconds = Math.min(Math.max(Number(arg('--seconds', '60')), 1), 300);
      const outputFile = Observations.resolveObservationPath(outputName);

      phase('get_channel_start');
      let cachedChannel = await withTimeout(client.getChannel(channelId), 15000, 'GET_CHANNEL');
      phase('get_channel_ok');

      const sourceIdentity = Observations.deriveSourceIdentity(cachedChannel, client.user, guildId);
      const initial = Observations.snapshotObservations(cachedChannel, sourceIdentity, guildId);
      Observations.writeObservationsAtomic(outputFile, initial);

      let appended = 0;
      let skipped = 0;
      let eventChain = Promise.resolve();
      const subscriptions = [];

      for (const event of MESSAGE_EVENTS) {
        client.on(event, data => {
          eventChain = eventChain.then(async () => {
            const messageId = Observations.eventMessageId(data);
            if (!messageId) {
              skipped++;
              phase('observation_event_skipped', { event, reason: 'missing_message_id' });
              return;
            }

            if (event === 'MESSAGE_DELETE') {
              Observations.appendObservation(outputFile, Observations.deleteObservation(messageId, sourceIdentity));
              appended++;
              phase('observation_event_appended', { event, message_id: messageId });
              return;
            }

            let message = Observations.eventMessage(data);
            let observationChannel = cachedChannel;
            if (!Observations.completeEventMessage(data)) {
              phase('observation_refetch_start', { event, message_id: messageId });
              const refreshed = await withTimeout(
                client.getChannel(channelId),
                15000,
                'GET_CHANNEL_EVENT_REFETCH',
              );
              phase('observation_refetch_ok', { event, message_id: messageId });
              const refreshedSource = Observations.deriveSourceIdentity(
                refreshed,
                client.user,
                guildId,
              );
              if (
                refreshedSource.source_type !== sourceIdentity.source_type ||
                refreshedSource.source_identifier !== sourceIdentity.source_identifier
              ) {
                throw new Error('Discord observation source identity changed during watch');
              }
              cachedChannel = refreshed;
              observationChannel = refreshed;
              message = Observations.findMessage(refreshed, messageId);
            }

            if (!message) {
              skipped++;
              phase('observation_event_skipped', {
                event,
                message_id: messageId,
                reason: 'complete_message_unavailable',
              });
              return;
            }

            Observations.appendObservation(
              outputFile,
              Observations.messageObservation(
                observationChannel,
                message,
                sourceIdentity,
                guildId,
              ),
            );
            appended++;
            phase('observation_event_appended', { event, message_id: messageId });
          }).catch(error => {
            skipped++;
            console.error(JSON.stringify({
              type: 'observation_event_error',
              event,
              message_id: Observations.eventMessageId(data),
              reason: 'event_processing_failed',
            }));
          });
        });

        phase('subscribe_start', { event });
        subscriptions.push(await withTimeout(
          client.subscribe(event, { channel_id: String(channelId) }),
          15000,
          'SUBSCRIBE_' + event,
        ));
        phase('subscribe_ok', { event });
      }

      console.log(JSON.stringify({
        type: 'observation_watch_started',
        channel_id: String(channelId),
        source_type: sourceIdentity.source_type,
        source_identifier: sourceIdentity.source_identifier,
        source_scope: sourceIdentity.source_scope,
        output_file: path.basename(outputFile),
        seconds,
        events: MESSAGE_EVENTS,
        initial_observations: initial.length,
        message_content_emitted_to_stdout: false,
      }));

      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      for (const subscription of subscriptions.reverse()) {
        try { await withTimeout(subscription.unsubscribe(), 15000, 'UNSUBSCRIBE'); } catch {}
      }
      await eventChain;

      emitResult({
        type: 'observation_watch_completed',
        channel_id: String(channelId),
        source_type: sourceIdentity.source_type,
        source_identifier: sourceIdentity.source_identifier,
        source_scope: sourceIdentity.source_scope,
        output_file: path.basename(outputFile),
        seconds,
        initial_observations: initial.length,
        appended_observations: appended,
        skipped_events: skipped,
        message_content_emitted_to_stdout: false,
      });
      return;
    }

    if (command === 'watch') {
      const channelId = arg('--channel-id');
      if (!channelId) throw new Error('--channel-id is required');
      const seconds = Math.min(Math.max(Number(arg('--seconds', '60')), 1), 300);
      const subscriptions = [];

      for (const event of MESSAGE_EVENTS) {
        client.on(event, data => {
          const message = data && (data.message || data);
          console.log(JSON.stringify({
            type: 'message_event',
            event,
            channel_id: String((data && data.channel_id) || channelId),
            message_id: message && message.id ? String(message.id) : null,
            timestamp: message && message.timestamp ? message.timestamp : null,
            content_emitted: false,
          }));
        });
        phase('subscribe_start', { event });
        subscriptions.push(await withTimeout(
          client.subscribe(event, { channel_id: String(channelId) }),
          15000,
          `SUBSCRIBE_${event}`,
        ));
        phase('subscribe_ok', { event });
      }

      console.log(JSON.stringify({ type: 'watch_started', channel_id: channelId, seconds, events: MESSAGE_EVENTS }));
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      for (const subscription of subscriptions.reverse()) {
        try { await withTimeout(subscription.unsubscribe(), 15000, 'UNSUBSCRIBE'); } catch {}
      }
      console.log(JSON.stringify({ type: 'watch_completed', channel_id: channelId, seconds }));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    await closeClient(client);
  }
}

main().catch(error => {
  console.error(JSON.stringify({type:'fatal',...Observations.diagnosticError(error)}));
  process.exitCode=1;
});
