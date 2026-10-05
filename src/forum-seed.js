'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const O=require('./observations');

const SNOWFLAKE=/^[1-9][0-9]*$/;
const THREAD_TYPES=new Set([10,11,12]);
const LINK_HOSTS=new Set(['discord.com','www.discord.com','ptb.discord.com','canary.discord.com','discordapp.com','www.discordapp.com']);

function snowflake(value,label){
  const text=value===null||value===undefined?'':String(value);
  if(!SNOWFLAKE.test(text)) throw new Error((label||'snowflake')+'_invalid');
  return text;
}
function privateDirectory(directory){
  if(!path.isAbsolute(directory)) throw new Error('forum_state_invalid');
  if(!fs.existsSync(directory)) fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const st=fs.lstatSync(directory);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid()||fs.realpathSync(directory)!==directory) throw new Error('forum_state_invalid');
  return directory;
}
function normalizeEntries(entries){
  if(!Array.isArray(entries)) throw new Error('forum_state_invalid');
  const byChannel=new Map();
  for(const raw of entries){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='channel_id,guild_id,parent_id') throw new Error('forum_state_invalid');
    const entry={guild_id:snowflake(raw.guild_id,'guild'),parent_id:snowflake(raw.parent_id,'parent'),channel_id:snowflake(raw.channel_id,'channel')};
    const prior=byChannel.get(entry.channel_id);
    if(prior&&(prior.guild_id!==entry.guild_id||prior.parent_id!==entry.parent_id)) throw new Error('forum_state_invalid');
    byChannel.set(entry.channel_id,entry);
  }
  return [...byChannel.values()].sort((a,b)=>a.guild_id.localeCompare(b.guild_id)||a.parent_id.localeCompare(b.parent_id)||a.channel_id.localeCompare(b.channel_id));
}
class ForumState{
  constructor(file){this.file=file;}
  directory(){if(!this.file||!path.isAbsolute(this.file)) throw new Error('forum_state_invalid');return privateDirectory(path.dirname(this.file));}
  read(){
    this.directory();let fd;
    try{fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}
    catch(e){if(e.code==='ENOENT')return [];throw new Error('forum_state_invalid');}
    try{
      const st=fs.fstatSync(fd);
      if(!st.isFile()||(st.mode&0o077)||st.uid!==process.getuid()||st.size>1024*1024) throw new Error('forum_state_invalid');
      const raw=JSON.parse(fs.readFileSync(fd,'utf8'));
      if(!raw||raw.version!==1||!Array.isArray(raw.threads)||Object.keys(raw).sort().join(',')!=='threads,version') throw new Error('forum_state_invalid');
      return normalizeEntries(raw.threads);
    }catch(e){if(e.message==='forum_state_invalid')throw e;throw new Error('forum_state_invalid');}
    finally{fs.closeSync(fd);}
  }
  persist(entries){
    const normalized=normalizeEntries(entries),dir=this.directory();
    const temp=path.join(dir,'.threads-'+crypto.randomUUID()+'.tmp');
    let fd;
    try{
      fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      fs.writeFileSync(fd,JSON.stringify({version:1,threads:normalized})+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temp,this.file);
      const d=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
    }catch{throw new Error('forum_state_persistence_failed');}
    finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{};try{fs.unlinkSync(temp);}catch{}}
    return normalized;
  }
  merge(entries){return this.persist([...this.read(),...entries]);}
}
function parseThreadRefs(text,guildId){
  const guild=snowflake(guildId,'guild'),out=[],seen=new Set();
  for(const raw of String(text||'').split(/\r?\n/)){
    const value=raw.trim();if(!value||value.startsWith('#'))continue;
    let id;
    if(SNOWFLAKE.test(value)) id=value;
    else{
      let url;try{url=new URL(value);}catch{throw new Error('thread_link_invalid');}
      if(url.protocol!=='https:'||!LINK_HOSTS.has(url.hostname)) throw new Error('thread_link_invalid');
      const p=url.pathname.split('/').filter(Boolean);
      if(p.length<3||p[0]!=='channels'||!SNOWFLAKE.test(p[1])||!SNOWFLAKE.test(p[2])) throw new Error('thread_link_invalid');
      if(p[1]!==guild) throw new Error('thread_link_guild_mismatch');
      id=p[2];
    }
    if(!seen.has(id)){seen.add(id);out.push(id);}
  }
  if(!out.length) throw new Error('thread_seed_empty');
  return out;
}
function validateThread(channel,id,guildId,parentId){
  if(!channel||String(channel.id||'')!==id||String(channel.guild_id||'')!==guildId||String(channel.parent_id||'')!==parentId||!THREAD_TYPES.has(Number(channel.type))) throw new Error('forum_thread_identity_mismatch');
  return O.normalizeChannel(channel,guildId);
}
async function seedForumThreads({client,inputFile,guildId,parentId,sources,state,observationDir}){
  const guild=snowflake(guildId,'guild'),parent=snowflake(parentId,'parent');
  if(!Array.isArray(sources)||!sources.some(s=>String(s.guild_id)===guild&&String(s.channel_id)===parent)) throw new Error('forum_not_selected');
  const refs=parseThreadRefs(fs.readFileSync(inputFile,'utf8'),guild);
  const prepared=[];
  for(const id of refs){
    const channel=await client.getChannel(id);
    const normalized=validateThread(channel,id,guild,parent);
    const source=O.deriveSourceIdentity(normalized,client.user);
    prepared.push({entry:{guild_id:guild,parent_id:parent,channel_id:id},observations:O.snapshotObservations(channel,source,guild)});
  }
  let messages=0;
  for(const item of prepared){O.publishPendingBatch(observationDir,item.observations);messages+=Math.max(0,item.observations.length-1);}
  state.merge(prepared.map(x=>x.entry));
  return {thread_count:prepared.length,message_count:messages,state_count:state.read().length};
}
module.exports={ForumState,parseThreadRefs,seedForumThreads,validateThread};
