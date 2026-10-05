'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let S;
try {S=require('../src/forum-seed');} catch(e) {if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('SDD-DLE-029 parses explicit Discord thread links and raw ids',()=>{
  assert.equal(typeof S?.parseThreadRefs,'function','forum seed parser missing');
  assert.deepEqual(S.parseThreadRefs('810\nhttps://discord.com/channels/700/811\nhttps://canary.discord.com/channels/700/812/999\n','700'),['810','811','812']);
  assert.throws(()=>S.parseThreadRefs('https://discord.com/channels/701/811\n','700'),/guild/);
  assert.throws(()=>S.parseThreadRefs('https://example.com/channels/700/811\n','700'),/link/);
});
test('SDD-DLE-029 durable forum state is private atomic and duplicate-free',()=>{
  assert.equal(typeof S?.ForumState,'function','forum state missing');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forum-state-'));fs.chmodSync(root,0o700);
  try{
    const file=path.join(root,'threads.json'),state=new S.ForumState(file);
    assert.deepEqual(state.read(),[]);
    state.merge([{guild_id:'700',parent_id:'800',channel_id:'810'},{guild_id:'700',parent_id:'800',channel_id:'810'}]);
    assert.deepEqual(state.read(),[{guild_id:'700',parent_id:'800',channel_id:'810'}]);
    assert.equal(fs.statSync(file).mode&0o777,0o600);
    const raw=fs.readFileSync(file,'utf8');assert.equal(raw.includes('content'),false);
    fs.chmodSync(file,0o644);assert.throws(()=>state.read(),/forum_state_invalid/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('SDD-DLE-029 seed validates exact parent, publishes bounded snapshot and persists identity',async()=>{
  assert.equal(typeof S?.seedForumThreads,'function','forum seed operation missing');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forum-seed-'));fs.chmodSync(root,0o700);
  try{
    const input=path.join(root,'input.txt');fs.writeFileSync(input,'https://discord.com/channels/700/810\n810\n');
    const stateDir=path.join(root,'state');fs.mkdirSync(stateDir,{mode:0o700});
    const obs=path.join(root,'obs');fs.mkdirSync(obs,{mode:0o700});
    const reads=[];
    const client={user:{id:'999'},getChannel:async id=>{reads.push(id);return {id,guild_id:'700',parent_id:'800',type:11,name:'post',messages:[{id:'900',channel_id:id,guild_id:'700',content:'hello',timestamp:'2026-01-01T00:00:00Z',author:{id:'990'},type:0}]};}};
    const out=await S.seedForumThreads({client,inputFile:input,guildId:'700',parentId:'800',sources:[{guild_id:'700',channel_id:'800'}],state:new S.ForumState(path.join(stateDir,'threads.json')),observationDir:obs});
    assert.deepEqual(reads,['810']);assert.equal(out.thread_count,1);assert.equal(out.message_count,1);
    const files=fs.readdirSync(obs).filter(x=>x.endsWith('.jsonl'));assert.equal(files.length,1);
    const rows=fs.readFileSync(path.join(obs,files[0]),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].channel.parent_id,'800');assert.equal(rows[1].message.content,'hello');
    assert.deepEqual(new S.ForumState(path.join(stateDir,'threads.json')).read(),[{guild_id:'700',parent_id:'800',channel_id:'810'}]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('SDD-DLE-029 seed fails closed on wrong parent before publishing',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forum-seed-bad-'));fs.chmodSync(root,0o700);
  try{
    const input=path.join(root,'input.txt');fs.writeFileSync(input,'810\n');
    const stateDir=path.join(root,'state');fs.mkdirSync(stateDir,{mode:0o700});
    const obs=path.join(root,'obs');fs.mkdirSync(obs,{mode:0o700});
    const client={user:{id:'999'},getChannel:async id=>({id,guild_id:'700',parent_id:'999',type:11,messages:[]})};
    await assert.rejects(S.seedForumThreads({client,inputFile:input,guildId:'700',parentId:'800',sources:[{guild_id:'700',channel_id:'800'}],state:new S.ForumState(path.join(stateDir,'threads.json')),observationDir:obs}),/forum_thread_identity_mismatch/);
    assert.equal(fs.readdirSync(obs).length,0);assert.equal(fs.existsSync(path.join(stateDir,'threads.json')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
