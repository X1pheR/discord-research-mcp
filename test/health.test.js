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
});
