'use strict';
const fs=require('node:fs');
function healthy(collector,archive,now=Date.now()){
 const fresh=state=>state&&Number.isFinite(Date.parse(state.updated_at))&&now-Date.parse(state.updated_at)<90000;
 return Boolean(fresh(collector)&&fresh(archive)&&collector.status==='subscribed'&&archive.status==='ready'&&collector.selected?.length&&JSON.stringify(collector.selected)===JSON.stringify(collector.active));
}
module.exports={healthy};
if(require.main===module){
 try{
  const c=JSON.parse(fs.readFileSync(process.env.DISCORD_HEALTH_FILE,'utf8'));
  const a=JSON.parse(fs.readFileSync(process.env.DISCORD_IMPORT_HEALTH_FILE,'utf8'));
  process.exitCode=healthy(c,a)?0:1;
 }catch{process.exitCode=1;}
}
