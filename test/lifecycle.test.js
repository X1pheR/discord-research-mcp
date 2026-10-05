'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/observations');
test('SDD-DLE-015 validates exact selection and rejects malformed scope', () => {
  assert.equal(typeof O.validateSelection, 'function', 'typed source selection is missing');
  assert.deepEqual(O.validateSelection({version:1,sources:[{guild_id:'700',channel_id:'800'}]}), [{guild_id:'700',channel_id:'800'}]);
  for (const config of [{}, {version:2,sources:[]}, {version:1,sources:[{guild_id:'700',channel_id:800}]}, {version:1,sources:[{guild_id:'700',channel_id:'800',token:'private'}]}, {version:1,sources:[{guild_id:'700',channel_id:'800'},{guild_id:'700',channel_id:'800'}]}]) assert.throws(() => O.validateSelection(config));
  assert.deepEqual(O.validateSelection({version:1,sources:[]}), []);
});
const {EventEmitter} = require('node:events');
let Forward;
try { Forward = require('../src/forward'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
class Provider extends EventEmitter {
  constructor() {super(); this.reads=[]; this.user={id:'999'};}
  async getGuilds() {this.reads.push('guilds'); return [{id:'700'}];}
  async getChannels(guild) {this.reads.push('channels:'+guild); return [{id:'800',type:0,name:'synthetic'},{id:'801',type:0}];}
  async getChannel(channel) {this.reads.push('content:'+channel); return {id:channel,guild_id:'700',type:0,messages:[{id:'902',channel_id:channel,guild_id:'700',content:'resolved',timestamp:'2026-01-01T00:00:00Z',author:{id:'990'},type:0}]};}
  async subscribe(event,args) {this.reads.push('subscribe:'+event+':'+(args?.channel_id||'global')); return {unsubscribe:async()=>{}};}
}
test('SDD-DLE-015/016 selected forward capture does not bootstrap history', async () => {
  assert.equal(typeof Forward?.Session, 'function', 'forward-only session is missing');
  const p=new Provider(); const observations=[]; const states=[];
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}], o=>observations.push(o), status=>states.push(status));
  await s.start();
  assert.equal(p.reads.filter(x=>x.startsWith('content:')).length,0);
  assert.equal(observations.length,0,'discovery must not produce archive evidence');
  p.emit('MESSAGE_CREATE',{channel_id:'801',message:{id:'901',content:'unselected'}});
  p.emit('MESSAGE_CREATE',{channel_id:'800',message:{id:'900',channel_id:'800',guild_id:'700',content:'selected',timestamp:'2026-01-01T00:00:00Z',author:{id:'990'},type:0}});
  await s.drain();
  assert.equal(observations.length,1); assert.equal(observations[0].message.content,'selected');
  assert.equal(states.at(-1).active[0].channel_id,'800');
  await s.stop();
});
test('SDD-DLE-006/016 partial event archives only the resolved target', async () => {
  const p=new Provider(); const observations=[]; const states=[];
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}],o=>observations.push(o),v=>states.push(v));
  await s.start(); p.emit('MESSAGE_UPDATE',{channel_id:'800',message:{id:'902'}}); await s.drain();
  assert.equal(observations.length,1); assert.equal(observations[0].message.content,'resolved');
  assert.deepEqual(p.reads.filter(x=>x.startsWith('content:')),['content:800']);
  p.emit('MESSAGE_UPDATE',{channel_id:'800',message:{id:'903'}}); await s.drain();
  assert.equal(observations.length,1); assert.equal(states.at(-1).reason,'complete_message_unavailable');
  await s.stop();
});
test('SDD-DLE-018/021 provider failure and mismatched events expose content-free gaps', async () => {
  const p=new Provider(); const observations=[]; const states=[];
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}],o=>observations.push(o),v=>states.push(v));
  await s.start();
  p.emit('MESSAGE_CREATE',{channel_id:'800',message:{id:'900',channel_id:'801',guild_id:'701',content:'PRIVATE_CANARY',timestamp:'2026-01-01T00:00:00Z',author:{id:'990'},type:0}}); await s.drain();
  assert.equal(observations.length,0); assert.equal(states.at(-1).reason,'event_identity_mismatch');
  p.emit('disconnected'); assert.equal(states.at(-1).status,'degraded'); assert.equal(states.at(-1).active.length,0);
  assert.equal(JSON.stringify(states).includes('PRIVATE_CANARY'),false);
  await s.stop();
});
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
test('SDD-DLE-021 diagnostic errors suppress private provider payloads', () => {
  assert.equal(typeof O.diagnosticError,'function','safe diagnostics are missing');
  const diagnostic=O.diagnosticError({message:'PRIVATE_CANARY',data:{access_token:'SECRET_CANARY'},code:'SECRET_CANARY'});
  assert.equal(JSON.stringify(diagnostic).includes('CANARY'),false);
  assert.equal(diagnostic.reason,'provider_failure');
});
test('SDD-DLE-017 private handoff survives restart and incomplete unpublished state', () => {
  assert.equal(typeof O.publishPending,'function','durable pending handoff is missing');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forward-handoff-'));
  try {
    const source={source_type:'discord_local',source_identifier:'700'};
    const first=O.publishPending(directory,O.deleteObservation('900',source));
    fs.writeFileSync(path.join(directory,'.interrupted.tmp'),'partial private input',{mode:0o600});
    const second=O.publishPending(directory,O.deleteObservation('901',source));
    const pending=fs.readdirSync(directory).filter(f=>f.endsWith('.jsonl')).sort();
    assert.equal(pending.length,2); assert.equal(pending[0],path.basename(first)); assert.equal(pending[1],path.basename(second));
    for(const f of pending) {assert.equal(fs.statSync(path.join(directory,f)).mode & 0o777,0o600); assert.equal(JSON.parse(fs.readFileSync(path.join(directory,f),'utf8')).kind,'delete');}
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('SDD-DLE-027 selected forum parent derives only bound child threads', async () => {
  class ForumProvider extends Provider {
    async getChannels(guild) {
      this.reads.push('channels:'+guild);
      return [
        {id:'800',guild_id:'700',type:15,name:'forum'},
        {id:'810',guild_id:'700',parent_id:'800',type:11,name:'child'},
        {id:'811',guild_id:'700',parent_id:'999',type:11,name:'other-child'},
        {id:'812',guild_id:'700',parent_id:'800',type:0,name:'not-thread'},
      ];
    }
  }
  const p=new ForumProvider(); const observations=[]; const states=[];
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}],o=>observations.push(o),v=>states.push(v));
  await s.start();
  for (const event of ['MESSAGE_CREATE','MESSAGE_UPDATE','MESSAGE_DELETE']) {
    assert.ok(p.reads.includes('subscribe:'+event+':800'));
    assert.ok(p.reads.includes('subscribe:'+event+':810'));
    assert.equal(p.reads.includes('subscribe:'+event+':811'),false);
    assert.equal(p.reads.includes('subscribe:'+event+':812'),false);
  }
  assert.equal(observations.length,0,'forum discovery must not archive content');
  assert.deepEqual(states.at(-1).derived,[{guild_id:'700',channel_id:'810',parent_id:'800'}]);
  await s.stop();
});

test('SDD-DLE-027 CHANNEL_CREATE performs one identity read and admits only selected forum children', async () => {
  class ForumProvider extends Provider {
    async getChannels(guild) {this.reads.push('channels:'+guild);return [{id:'800',guild_id:'700',type:15,name:'forum'}];}
    async getChannel(channel) {
      this.reads.push('content:'+channel);
      if (channel==='813') return {id:'813',guild_id:'700',parent_id:'800',type:11,name:'new-child',messages:[]};
      if (channel==='814') return {id:'814',guild_id:'700',parent_id:'999',type:11,name:'other-child',messages:[]};
      return super.getChannel(channel);
    }
  }
  const p=new ForumProvider(); const states=[];
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}],()=>{},v=>states.push(v));
  await s.start();
  p.emit('CHANNEL_CREATE',{id:'813',name:'new-child',type:11});
  await s.drain();
  assert.deepEqual(p.reads.filter(x=>x==='content:813'),['content:813']);
  assert.ok(p.reads.includes('subscribe:MESSAGE_CREATE:813'));
  assert.ok(states.at(-1).derived.some(x=>x.channel_id==='813'&&x.parent_id==='800'));
  p.emit('CHANNEL_CREATE',{id:'814',name:'other-child',type:11});
  await s.drain();
  assert.deepEqual(p.reads.filter(x=>x==='content:814'),['content:814']);
  assert.equal(p.reads.includes('subscribe:MESSAGE_CREATE:814'),false);
  await s.stop();
});

test('SDD-DLE-029 persisted child is revalidated and subscribed after restart', async () => {
  class ForumProvider extends Provider {
    async getChannels(guild){this.reads.push('channels:'+guild);return [{id:'800',guild_id:'700',type:15,name:'forum'}];}
    async getChannel(channel){this.reads.push('content:'+channel);return {id:channel,guild_id:'700',parent_id:'800',type:11,name:'seeded',messages:[]};}
  }
  const state={read:()=>[{guild_id:'700',parent_id:'800',channel_id:'810'}],merge:entries=>entries};
  const p=new ForumProvider(),states=[];
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}],()=>{},v=>states.push(v),{forumState:state});
  await s.start();
  assert.deepEqual(p.reads.filter(x=>x==='content:810'),['content:810']);
  assert.ok(p.reads.includes('subscribe:MESSAGE_CREATE:810'));
  assert.ok(states.at(-1).derived.some(x=>x.channel_id==='810'&&x.parent_id==='800'));
  await s.stop();
});

test('SDD-DLE-029 CHANNEL_CREATE persists derived identity before subscribing', async () => {
  class ForumProvider extends Provider {
    async getChannels(guild){this.reads.push('channels:'+guild);return [{id:'800',guild_id:'700',type:15,name:'forum'}];}
    async getChannel(channel){this.reads.push('content:'+channel);return {id:channel,guild_id:'700',parent_id:'800',type:11,name:'new',messages:[]};}
  }
  const merged=[];const state={read:()=>[],merge:entries=>{merged.push(...entries);return entries;}};
  const p=new ForumProvider();
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}],()=>{},()=>{}, {forumState:state});
  await s.start();p.emit('CHANNEL_CREATE',{id:'813',type:11});await s.drain();
  assert.deepEqual(merged,[{guild_id:'700',parent_id:'800',channel_id:'813'}]);
  assert.ok(p.reads.includes('subscribe:MESSAGE_CREATE:813'));
  await s.stop();
});


test('SDD-DLE-029 failed persisted child revalidation remains degraded', async () => {
  class ForumProvider extends Provider {
    async getChannels(guild){this.reads.push('channels:'+guild);return [{id:'800',guild_id:'700',type:15,name:'forum'}];}
    async getChannel(channel){this.reads.push('content:'+channel);throw new Error('unavailable');}
  }
  const state={read:()=>[{guild_id:'700',parent_id:'800',channel_id:'810'}],merge:entries=>entries};
  const p=new ForumProvider(),states=[];
  const s=new Forward.Session(p,[{guild_id:'700',channel_id:'800'}],()=>{},v=>states.push(v),{forumState:state});
  await s.start();
  assert.equal(states.at(-1).status,'degraded');
  assert.equal(states.at(-1).reason,'forum_state_revalidation_failed');
  assert.equal(p.reads.includes('subscribe:MESSAGE_CREATE:810'),false);
  await s.stop();
});


test('SDD-DLE-030 source coverage exposes unsupported forum children without degrading transport health', async () => {
  class MixedProvider extends Provider {
    async getChannels(guild) {
      this.reads.push('channels:'+guild);
      return [
        {id:'800',guild_id:'700',type:15,name:'forum'},
        {id:'801',guild_id:'700',type:0,name:'text'},
      ];
    }
  }
  const p=new MixedProvider(),states=[];
  const s=new Forward.Session(
    p,
    [{guild_id:'700',channel_id:'800'},{guild_id:'700',channel_id:'801'}],
    ()=>{},
    v=>states.push(v),
  );
  await s.start();
  const last=states.at(-1);
  assert.equal(last.status,'subscribed');
  assert.equal(last.coverage,'partial_selected_sources');
  assert.deepEqual(last.source_coverage,[
    {guild_id:'700',channel_id:'800',channel_type:15,coverage:'unsupported_forum_children',complete:false},
    {guild_id:'700',channel_id:'801',channel_type:0,coverage:'observed_forward_events_only',complete:false},
  ]);
  await s.stop();
});
