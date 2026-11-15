'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
let H;try{H=require('../src/health');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('SDD-DLE-018 acquisition health requires fresh subscription and healthy importer',()=>{
 assert.equal(typeof H?.healthy,'function','acquisition health contract is missing');
 const now=Date.now();const fresh={updated_at:new Date(now).toISOString()};
 const collector={...fresh,status:'subscribed',selected:[{guild_id:'700',channel_id:'800'}],active:[{guild_id:'700',channel_id:'800'}],gap:true};
 const archive={...fresh,status:'ready'};
 assert.equal(H.healthy(collector,archive,now),true);
 assert.equal(H.healthy({...collector,status:'degraded'},archive,now),false);
 assert.equal(H.healthy(collector,{...archive,status:'degraded'},now),false);
 assert.equal(H.healthy(collector,archive,now+120000),false);
 assert.equal(H.healthy({...collector,active:[]},archive,now),false);
 assert.equal(H.healthy({...collector,coverage:'partial_selected_sources',source_coverage:[{guild_id:'700',channel_id:'800',channel_type:15,coverage:'unsupported_forum_children',complete:false}]},archive,now),true);
 assert.equal(H.healthy({...collector,reconciliation_enabled:true,last_interaction:new Date(now).toISOString()},archive,now),true);
 assert.equal(H.healthy({...collector,reconciliation_enabled:true,last_interaction:new Date(now-360000).toISOString()},archive,now),false);
});
test('acquisition monitor fails closed on missing or stale state files',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'discord-health-'));
 const collectorFile=path.join(dir,'acquisition.json'),archiveFile=path.join(dir,'import.json');
 const now=Date.now(),updated_at=new Date(now).toISOString();
 try {
  assert.equal(H.healthyFiles(collectorFile,archiveFile,now),false);
  fs.writeFileSync(collectorFile,JSON.stringify({status:'subscribed',updated_at,last_interaction:updated_at,reconciliation_enabled:true,selected:[{guild_id:'700',channel_id:'800'}],active:[{guild_id:'700',channel_id:'800'}]}));
  fs.writeFileSync(archiveFile,JSON.stringify({status:'ready',updated_at}));
  assert.equal(H.healthyFiles(collectorFile,archiveFile,now),true);
  assert.equal(H.healthyFiles(collectorFile,archiveFile,now+360000),false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
