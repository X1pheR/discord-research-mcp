'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function fail(){throw new Error('token_state_invalid');}
function token(value){if(typeof value!=='string'||!value.trim()||value.length>8192||/[\r\n\0]/.test(value))fail();return value;}
class TokenState{
 constructor(file,bootstrap,clientId=null){this.file=file;this.bootstrap=bootstrap;this.clientId=clientId;}
 directory(){
  if(!this.file||!path.isAbsolute(this.file))fail();
  const dir=path.dirname(this.file),s=fs.lstatSync(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid()||fs.realpathSync(dir)!==dir)fail();
  return dir;
 }
 read(){
  this.directory();
  let fd;
  try{fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}
  catch(e){if(e.code==='ENOENT')return token(fs.readFileSync(this.bootstrap,'utf8').trim());fail();}
  try{
   const s=fs.fstatSync(fd);
   if(!s.isFile()||(s.mode&0o077)||s.uid!==process.getuid()||s.size>16384)fail();
   const value=JSON.parse(fs.readFileSync(fd,'utf8'));
   if(value.version!==1||value.client_id!==this.clientId||!Number.isFinite(Date.parse(value.rotated_at)))fail();
   return token(value.refresh_token);
  }catch{fail();}finally{fs.closeSync(fd);}
 }
 persist(value){
  token(value);const dir=this.directory();
  const temp=path.join(dir,'.rotation-'+crypto.randomUUID()+'.tmp');
  let fd;
  try{
   fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   fs.writeFileSync(fd,JSON.stringify({version:1,client_id:this.clientId,rotated_at:new Date().toISOString(),refresh_token:value})+'\n');
   fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   fs.renameSync(temp,this.file);
   const directory=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
   try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  }catch{throw new Error('token_state_persistence_failed');}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
 }
}
module.exports={TokenState};
