'use strict';
const {Session}=require('./forward');
const O=require('./observations');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function cleanup(operation,ms){
 let timer;
 try{await Promise.race([operation(),new Promise(resolve=>{timer=setTimeout(resolve,ms);})]);}catch{}finally{clearTimeout(timer);}
}
async function wait(client,session,stopped){
 while(!stopped.value&&session.state.active.length&&Date.now()<client.sessionExpiresAt){session.report({});await pause(10000);}
}
async function run(options){
 const {sources,connect,emit,health,stopped}=options;
 O.validateSelection({version:1,sources});
 if(!sources.length){health({status:'disabled',selected:[],active:[],gap:true,reason:'empty_selection'});return;}
 let attempts=0;let previousGap=options.gapSince||null;let suspended=false;
 const report=value=>{if(suspended)return;if(!previousGap)previousGap=new Date().toISOString();health({...value,gap:true,gap_since:previousGap,coverage:value.coverage||'observed_forward_events_only'});};
 while(!stopped.value){
  let client,session;
  try{
   report({status:'connecting',selected:sources,active:[],reason:'restart_or_reconnect'});
   client=await connect();
   if(options.onClient)options.onClient(client);
   session=new Session(client,sources,emit,report,{forumState:options.forumState});
   await session.start();attempts=0;
   await (options.wait||wait)(client,session,stopped);
  }catch(error){
   const terminal=error.suspend||/^(token_state_|selected_identity_|oauth_response_invalid)/.test(error.message||'');
   report({status:terminal?'suspended':'degraded',selected:sources,active:[],reason:terminal?'credential_or_identity_rejected':'provider_unavailable'});
   if(terminal){suspended=true;stopped.value=true;return;}
  }finally{
   if(options.onClient)options.onClient(null);
   if(session)await cleanup(()=>session.stop(),options.cleanupTimeout||2000);
   if(client)await cleanup(()=>client.destroy(),options.cleanupTimeout||2000);
  }
  if(!stopped.value)await (options.pause||pause)(Math.min(60000,1000*2**Math.min(++attempts,6)));
 }
 report({status:'stopped',selected:sources,active:[],reason:'stopped'});
}
module.exports={run};
