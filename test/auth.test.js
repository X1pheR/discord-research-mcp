'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
let A;try{A=require('../src/refresh');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('SDD-DLE-024 refresh persists replacement before authentication and rejection never falls back',async()=>{
 assert.equal(typeof A?.refresh,'function','restart-safe refresh flow is missing');
 const events=[];const state={read:()=>{events.push('read');return 'LATEST_CANARY';},persist:t=>{assert.equal(t,'REPLACEMENT_CANARY');events.push('persist');}};
 const client={authenticate:async t=>{assert.equal(t,'ACCESS_CANARY');events.push('authenticate');}};
 let requests=0;
 const fetcher=async(_url,options)=>{requests++;assert.equal(options.body.get('refresh_token'),'LATEST_CANARY');return {ok:true,status:200,json:async()=>({access_token:'ACCESS_CANARY',refresh_token:'REPLACEMENT_CANARY',expires_in:3600})};};
 const expiry=await A.refresh(client,'100','CLIENT_CANARY',state,fetcher);
 assert.deepEqual(events,['read','persist','authenticate']);assert.ok(expiry>Date.now());
 events.length=0;requests=0;
 await assert.rejects(A.refresh(client,'100','CLIENT_CANARY',state,async()=>{requests++;return {ok:false,status:401,json:async()=>({error:'PRIVATE_CANARY'})};}),e=>e.message==='authentication_rejected'&&e.suspend===true);
 assert.equal(requests,1);assert.deepEqual(events,['read']);
 state.persist=()=>{throw new Error('token_state_persistence_failed');};events.length=0;
 await assert.rejects(A.refresh(client,'100','CLIENT_CANARY',state,fetcher),/token_state_persistence_failed/);
 assert.equal(events.includes('authenticate'),false);
});
