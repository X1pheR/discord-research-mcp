'use strict';
const fs=require('node:fs');
function healthy(collector,archive,now=Date.now()){
 const fresh=state=>state&&Number.isFinite(Date.parse(state.updated_at))&&now-Date.parse(state.updated_at)<90000;
 const interactionFresh=!collector?.reconciliation_enabled ||
  (Number.isFinite(Date.parse(collector.last_interaction)) && now-Date.parse(collector.last_interaction)<300000);
 return Boolean(fresh(collector)&&fresh(archive)&&interactionFresh&&collector.status==='subscribed'&&archive.status==='ready'&&collector.selected?.length&&JSON.stringify(collector.selected)===JSON.stringify(collector.active));
}
function healthyFiles(collectorFile,archiveFile,now=Date.now()){
 try {
  const collector=JSON.parse(fs.readFileSync(collectorFile,'utf8'));
  const archive=JSON.parse(fs.readFileSync(archiveFile,'utf8'));
  return healthy(collector,archive,now);
 } catch {return false;}
}
module.exports={healthy,healthyFiles};
if(require.main===module){
 process.exitCode=healthyFiles(process.env.DISCORD_HEALTH_FILE,process.env.DISCORD_IMPORT_HEALTH_FILE)?0:1;
}
