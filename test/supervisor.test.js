'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
let S;try{S=require('../src/supervisor');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('SDD-DLE-017/018 reconnect repeats identity validation without historical acquisition and auth rejection suspends',async()=>{
 assert.equal(typeof S?.run,'function','unattended lifecycle supervisor is missing');
 const {EventEmitter}=require('node:events');const states=[];let connections=0,reads=0;const stopped={value:false};
 function provider(){const p=new EventEmitter();p.user={id:'999'};p.sessionExpiresAt=Date.now()+10000;
 p.getGuilds=async()=>{reads++;return [{id:'700'}];};p.getChannels=async()=>[{id:'800',type:0}];
 p.subscribe=async()=>({unsubscribe:async()=>{}});p.destroy=async()=>{};
 return p;}
 await S.run({sources:[{guild_id:'700',channel_id:'800'}],connect:async()=>{connections++;if(connections===3){const e=new Error('PRIVATE_CANARY');e.suspend=true;throw e;}return provider();},emit:()=>{},health:v=>states.push(v),stopped,pause:async()=>{},wait:async()=>{}});
 assert.equal(connections,3);assert.equal(reads,2);assert.equal(states.at(-1).status,'suspended');
 assert.equal(JSON.stringify(states).includes('CANARY'),false);assert.equal(states.at(-1).gap,true);
});
test('SDD-DLE-018 identity rejection remains suspended after cleanup',async()=>{
 const {EventEmitter}=require('node:events');const p=new EventEmitter();p.getGuilds=async()=>[];p.destroy=async()=>{};
 const states=[];
 await S.run({sources:[{guild_id:'700',channel_id:'800'}],connect:async()=>p,emit:()=>{},health:v=>states.push(v),stopped:{value:false}});
 assert.equal(states.at(-1).status,'suspended');
});

test('SDD-DLE-017 stalled unsubscribe cannot block shutdown', {timeout:200}, async()=>{
 const {EventEmitter}=require('node:events');const p=new EventEmitter();let destroyed=false;
 p.getGuilds=async()=>[{id:'700'}];p.getChannels=async()=>[{id:'800',type:0}];
 p.subscribe=async()=>({unsubscribe:()=>new Promise(()=>{})});p.destroy=async()=>{destroyed=true;};
 const stopped={value:false};
 await S.run({sources:[{guild_id:'700',channel_id:'800'}],connect:async()=>p,emit:()=>{},health:()=>{},stopped,cleanupTimeout:20,wait:async()=>{stopped.value=true;}});
 assert.equal(destroyed,true);
});
