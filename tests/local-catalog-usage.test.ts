import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSecurityService} from '../src/security/adapter.ts';
import {runUsage} from '../src/security/local-catalog.ts';
const id='11111111-2222-4333-8444-555555555555';
const v2={id,name:'Synthetic run key',provider:'synthetic',category:'api_key',environmentVariables:['SYNTHETIC_API_KEY'],sources:[],usageInstructions:runUsage,canProbe:false,status:'run_with_approval'};
const counts={approved:2,denied:1,timeout:0,unavailable:0,lastAt:'2026-10-21T01:00:00Z',lastResult:'denied',lastInitiator:'Codex · Terminal'};
async function fixture(){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'crew-local-usage-')));await chmod(dir,0o700);
 const path=join(dir,'catalog.json'),summary=join(dir,'usage-summary.json');
 const save=async(file:string,value:unknown)=>{await writeFile(file,JSON.stringify(value),{mode:0o600});await chmod(file,0o600);};
 await save(path,{schemaVersion:1,storage:'macos-keychain',credentials:[v2],updatedAt:new Date().toISOString()});
 const list=async()=>{const s=createSecurityService({localCatalogPath:path,nativeEnabled:false});try{return await s.listCredentials();}finally{await s.close();}};
 return {path,summary,save,list,clean:()=>rm(dir,{recursive:true,force:true})};
}
const summaryDoc=(entry:unknown=counts)=>({schemaVersion:1,updatedAt:'2026-10-21T01:00:00Z',credentials:{[id]:entry}});
test('v2 entries are runnable and carry their use counts, never values or sources',async()=>{
 const f=await fixture();
 try{
  await f.save(f.summary,summaryDoc());
  const c=await f.list();
  assert.deepEqual(c.localStore,{status:'available',count:1});
  assert.deepEqual(c.credentials,[{id:'local:'+id,name:v2.name,environmentVariables:['SYNTHETIC_API_KEY'],usageInstructions:runUsage,storage:'macos-keychain',canProbe:false,runnable:true,usage:counts}]);
  assert.doesNotMatch(JSON.stringify(c),/provider|category|sources/);
 }finally{await f.clean();}
});
test('no summary means no usage; a bad summary flags usage unavailable but keeps the catalog',async()=>{
 const f=await fixture();
 try{
  let c=await f.list();
  assert.deepEqual(c.localStore,{status:'available',count:1});assert.equal(c.credentials[0]?.usage,undefined);assert.equal(c.credentials[0]?.runnable,true);
  for(const bad of [summaryDoc({...counts,value:'SYNTHETIC_SECRET'}),summaryDoc({...counts,approved:-1}),summaryDoc({...counts,lastResult:'SYNTHETIC_SECRET'}),{...summaryDoc(),extra:'SYNTHETIC_SECRET'}]){
   await f.save(f.summary,bad);c=await f.list();
   assert.deepEqual(c.localStore,{status:'available',count:1,usage:'unavailable'});assert.equal(c.credentials[0]?.usage,undefined);assert.doesNotMatch(JSON.stringify(c),/SYNTHETIC_SECRET/);
  }
  await f.save(f.summary,summaryDoc());await chmod(f.summary,0o644);
  assert.equal((await f.list()).localStore?.usage,'unavailable');
 }finally{await f.clean();}
});
test('v2 status must pair with the run instructions',async()=>{
 const f=await fixture();
 try{
  await f.save(f.path,{schemaVersion:1,storage:'macos-keychain',credentials:[{...v2,usageInstructions:'已集中保存；授权使用尚未接入。'}],updatedAt:new Date().toISOString()});
  assert.equal((await f.list()).localStore?.status,'unavailable');
 }finally{await f.clean();}
});
