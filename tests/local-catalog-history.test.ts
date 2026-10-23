import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,realpath,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSecurityService} from '../src/security/adapter.ts';
import {Helper} from '../src/security/helper.ts';
import {readLocalCatalog,runUsage} from '../src/security/local-catalog.ts';
const id='11111111-2222-4333-8444-555555555555';
const decision=(n=0,extra:Record<string,unknown>={})=>({event:'decision',runId:'run-'+n,time:new Date(Date.UTC(2026,9,21,0,n)).toISOString(),credentialId:id,credentialName:'Synthetic key',result:'denied',command:'echo <redacted>',cwd:'/synthetic',initiator:'test',chain:['private parent'],parentHadVariable:true,...extra});
async function fixture(){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'crew-history-')));await chmod(dir,0o700);
 const path=join(dir,'catalog.json'),log=join(dir,'usage.jsonl');
 await writeFile(path,JSON.stringify({schemaVersion:1,storage:'macos-keychain',updatedAt:'2026-10-21T00:00:00Z',credentials:[{id,name:'Synthetic key',provider:'synthetic',category:'api_key',environmentVariables:['SYNTHETIC_KEY'],sources:[],usageInstructions:runUsage,canProbe:false,status:'run_with_approval'}]}),{mode:0o600});
 const save=async(lines:unknown[])=>writeFile(log,lines.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\n')+'\n',{mode:0o600});
 const read=async()=>(await readLocalCatalog(path) as any).recentUsage;
 return {dir,path,log,save,read,clean:()=>rm(dir,{recursive:true,force:true})};
}
test('last 20 decisions are ordered across keys; exit and future events do not enter the list',async()=>{
 const f=await fixture();try{
 await f.save([...Array.from({length:25},(_,i)=>decision(24-i,{credentialId:i%2?id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'})),{event:'exit',runId:'run-24',time:'2026-10-21T01:00:00Z',exitCode:0,seconds:1},{event:'future',arbitrary:{nested:true}}]);
 const h=await f.read();assert.equal(h.decisions.length,20);assert.equal(h.decisions[0].time,decision(24).time);assert.equal(h.decisions[19].time,decision(5).time);assert.equal(h.skippedLines,0);
 assert.equal(Object.keys(h.lastDecisionAt).length,2);assert.doesNotMatch(JSON.stringify(h),/chain|parentHadVariable|private parent|runId/);
 }finally{await f.clean();}
});
test('bad lines and invalid fields are counted while valid optional and future fields remain safe',async()=>{
 const f=await fixture();try{
 const invalid=[null,[],{...decision(),event:1},...Object.entries({runId:42,time:'not-time',credentialId:'bad',credentialName:[],result:'other',command:'bad\u0000',cwd:3,initiator:'x'.repeat(129),chain:42,parentHadVariable:'yes',exitCode:1.5,seconds:-1}).map(([k,v])=>decision(0,{[k]:v}))];
 await f.save(['{broken',...invalid,decision(1,{newField:'NOT_PUBLIC'}),{event:'decision',time:decision().time,credentialId:id,result:'approved'}]);
 const h=await f.read();assert.equal(h.skippedLines,invalid.length+1);assert.equal(h.decisions.length,2);assert.doesNotMatch(JSON.stringify(h),/NOT_PUBLIC/);
 await writeFile(f.log,Buffer.concat([Buffer.from(JSON.stringify(decision()).slice(0,-1)),Buffer.from([0xff]),Buffer.from('}\n'+JSON.stringify(decision(1))+'\n')]));
 assert.equal((await f.read()).skippedLines,1);
 }finally{await f.clean();}
});
test('history reads only the final MiB and reports a cut or incomplete line',async()=>{
 const f=await fixture();try{
 await writeFile(f.log,JSON.stringify(decision(50))+'\n'+ 'x'.repeat(1048576)+'\n'+JSON.stringify(decision(1))+'\n'+ '{partial',{mode:0o600});
 const h=await f.read();assert.equal(h.truncated,true);assert.equal(h.decisions.length,1);assert.equal(h.decisions[0].time,decision(1).time);assert.equal(h.skippedLines,2);
 }finally{await f.clean();}
});
test('absent, insecure, directory, file symlink and ancestor symlink are handled without exposing content',async()=>{
 const f=await fixture();try{
 assert.equal((await f.read()).status,'absent');await f.save([decision()]);await chmod(f.log,0o644);assert.equal((await f.read()).status,'unavailable');
 await chmod(f.log,0o600);await chmod(f.dir,0o755);assert.equal((await readLocalCatalog(f.path)).status,'unavailable');await chmod(f.dir,0o700);
 const target=join(f.dir,'target');await writeFile(target,JSON.stringify(decision())+'\n',{mode:0o600});await rm(f.log);await symlink(target,f.log);assert.equal((await f.read()).status,'unavailable');await rm(f.log);await mkdir(f.log);assert.equal((await f.read()).status,'unavailable');
 const alias=join(f.dir,'alias');await symlink(f.dir,alias);assert.equal((await readLocalCatalog(join(alias,'catalog.json'))).status,'unavailable');
 }finally{await f.clean();}
});
test('normal catalog listing projects history and preserves enabled native listing',async()=>{
 const f=await fixture();const original=Helper.prototype.call;const calls:unknown[]=[];
 Helper.prototype.call=async(name,args)=>{calls.push([name,args]);return {credentials:[]};};
 const s=createSecurityService({localCatalogPath:f.path,nativeEnabled:true,helperPath:'/synthetic/helper'});
 try{await f.save([decision()]);const c=await s.listCredentials();assert.equal(c.recentUsage?.decisions.length,1);assert.equal(c.recentUsage?.decisions[0]?.time,decision().time);assert.deepEqual(calls,[['list_credentials',{}]]);assert.equal(c.nativeAvailable,true);}
 finally{await s.close();Helper.prototype.call=original;await f.clean();}
});

test('credentials request handler returns history alongside normal native listing',async()=>{
 const {openDb}=await import('../src/db.ts');const {serve}=await import('../src/server.ts');
 const http=await import('node:http');
 const f=await fixture();const db=openDb(':memory:');const original=Helper.prototype.call;const calls:unknown[]=[];
 Helper.prototype.call=async(name,args)=>{calls.push([name,args]);return {credentials:[]};};
 const service=createSecurityService({localCatalogPath:f.path,nativeEnabled:true,helperPath:'/synthetic/helper'});
 const inert={close:async()=>{}};
 // Exercise the real HTTP handler without opening a listener in the sandbox.
 const listen=http.Server.prototype.listen;
 http.Server.prototype.listen=function(){return this;};
 let server:import('node:http').Server;
 try{server=serve(db,0,inert as any,inert as any,service);}finally{http.Server.prototype.listen=listen;}
 try{
 await f.save([decision()]);
 let status=0,headers:any;
 const body=await new Promise<any>((resolve,reject)=>{
  const response={writeHead:(code:number,h:any)=>{status=code;headers=h;},end:(text:string)=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}}};
  server.emit('request',{method:'GET',url:'/api/security/credentials',headers:{host:'127.0.0.1:4198','x-corpus':'1'},socket:{remoteAddress:'127.0.0.1'}},response);
 });
 assert.equal(status,200);assert.equal(headers['cache-control'],'no-store');
 assert.equal(body.recentUsage.decisions.length,1);assert.equal(body.recentUsage.decisions[0].time,decision().time);assert.deepEqual(calls,[['list_credentials',{}]]);assert.equal(body.nativeAvailable,true);assert.doesNotMatch(JSON.stringify(body),/"chain"|"parentHadVariable"/);
 }finally{await service.close();db.raw.close();Helper.prototype.call=original;await f.clean();}
});

test('same-time decisions retain the latest appended 20, and impossible calendar dates are skipped',async()=>{
 const f=await fixture();try{
 await f.save([...Array.from({length:25},(_,i)=>decision(0,{command:'command-'+i})),decision(0,{time:'2026-02-30T00:00:00Z'})]);
 const h=await f.read();assert.equal(h.decisions[0].command,'command-24');assert.equal(h.decisions.at(-1).command,'command-5');assert.equal(h.skippedLines,1);
 }finally{await f.clean();}
});
