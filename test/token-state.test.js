'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let T;try{T=require('../src/token-state');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('SDD-DLE-024 bootstrap then durable rotation and restart use newest private token',()=>{
 assert.equal(typeof T?.TokenState,'function','application-owned rotation state is missing');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-token-'));
 try{
  const bootstrap=path.join(root,'bootstrap');fs.writeFileSync(bootstrap,'BOOTSTRAP_CANARY',{mode:0o600});
  const dir=path.join(root,'state');fs.mkdirSync(dir,{mode:0o700});
  const file=path.join(dir,'refresh.json');let state=new T.TokenState(file,bootstrap);
  assert.equal(state.read(),'BOOTSTRAP_CANARY');
  state.persist('ROTATED_SECRET_CANARY');
  state=new T.TokenState(file,bootstrap);assert.equal(state.read(),'ROTATED_SECRET_CANARY');
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  fs.writeFileSync(path.join(dir,'.interrupted.tmp'),'PARTIAL_SECRET_CANARY',{mode:0o600});
  assert.equal(state.read(),'ROTATED_SECRET_CANARY');
  fs.writeFileSync(file,'{broken',{mode:0o600});assert.throws(()=>state.read(),/^Error: token_state_invalid$/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('SDD-DLE-024 insecure and symlink state fail closed without bootstrap downgrade',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-token-'));
 try{
  const bootstrap=path.join(root,'bootstrap');fs.writeFileSync(bootstrap,'BOOTSTRAP_CANARY',{mode:0o600});
  const dir=path.join(root,'state');fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'refresh.json');
  const state=new T.TokenState(file,bootstrap,'100');
  state.persist('LATEST_CANARY');fs.chmodSync(file,0o644);assert.throws(()=>state.read(),/token_state_invalid/);
  fs.unlinkSync(file);fs.symlinkSync(bootstrap,file);assert.throws(()=>state.read(),/token_state_invalid/);
  assert.throws(()=>state.persist(''),/token_state_invalid/);
  fs.unlinkSync(file);fs.chmodSync(dir,0o755);assert.throws(()=>state.read(),/token_state_invalid/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('SDD-DLE-024 passive isolated token recovery preserves latest private state without provider access',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-token-restore-'));
 try{
  const bootstrap=path.join(root,'bootstrap');fs.writeFileSync(bootstrap,'OLD_CANARY',{mode:0o600});
  const live=path.join(root,'live'),restored=path.join(root,'restored');fs.mkdirSync(live,{mode:0o700});fs.mkdirSync(restored,{mode:0o700});
  const file=path.join(live,'refresh.json');new T.TokenState(file,bootstrap,'100').persist('LATEST_CANARY');
  const target=path.join(restored,'refresh.json');fs.copyFileSync(file,target);fs.chmodSync(target,0o600);
  assert.equal(new T.TokenState(target,bootstrap,'100').read(),'LATEST_CANARY');
  assert.deepEqual(fs.readFileSync(target),fs.readFileSync(file));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
