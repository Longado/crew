import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {dirname,join,parse,resolve} from 'node:path';
import type {CredentialSummary,CredentialUsage,RecentCredentialUsage,CredentialDecision} from './types.ts';
export const localUsage='已集中保存；授权使用尚未接入。';
// Must match the signed vault's Metadata.usageInstructions contract.
export const runUsage='逐次授权取用：hk run <名称或变量名> -- <命令>；每次需要 Touch ID 或登录密码。';
export type LocalCatalogResult={status:'available'|'unavailable'|'absent';credentials:CredentialSummary[];usage?:'unavailable';recentUsage?:RecentCredentialUsage};
const record=(x:unknown):x is Record<string,unknown>=>Boolean(x)&&typeof x==='object'&&!Array.isArray(x);
const fields=(x:Record<string,unknown>,keys:string[])=>Object.keys(x).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(x,k));
const label=(x:unknown,max:number):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(x);
const variable=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(x)&&!/^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|CDPATH|TMPDIR|TMP|TEMP|PWD|OLDPWD|USER|LOGNAME|TERM|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|LANG|LC_.*|DYLD_.*|LD_.*|PYTHON.*|NODE_.*|RUBY.*|PERL.*|ZDOTDIR|GIT_.*|ASKKEY_.*)$/i.test(x);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const results=['approved','denied','timeout','unavailable'];
// One owner-only JSON file: 0600, in a 0700 directory, no symlink anywhere on the path, opened without following links.
async function readPrivateBytes(path:string,tail=false):Promise<{bytes:Buffer;truncated:boolean}>{
 let handle;
 try{
  const absolute=resolve(path);const stat=await lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600||(!tail&&stat.size>1048576))throw Error('invalid');
  const parent=await lstat(dirname(absolute));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o777)!==0o700)throw Error('invalid');
  // Reject symlink ancestors too: metadata must stay inside the declared local tree.
  let ancestor=dirname(dirname(absolute));while(true){const a=await lstat(ancestor);if(!a.isDirectory()||a.isSymbolicLink())throw Error('invalid');if(ancestor===parse(ancestor).root)break;ancestor=dirname(ancestor);}
  handle=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=await handle.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino||(!tail&&opened.size>1048576)||opened.uid!==process.getuid?.()||(opened.mode&0o777)!==0o600)throw Error('invalid');
  const start=tail?Math.max(0,opened.size-1048576):0;
  const bytes=Buffer.alloc(tail?Math.min(opened.size,1048576):1048577);let total=0;
  while(total<bytes.length){const {bytesRead}=await handle.read(bytes,total,bytes.length-total,start+total);if(!bytesRead)break;total+=bytesRead;}
  if(total>1048576)throw Error('invalid');return {bytes:bytes.subarray(0,total),truncated:start>0};
 }finally{await handle?.close();}
}
async function readPrivateJson(path:string):Promise<unknown>{
 const {bytes}=await readPrivateBytes(path);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
const optional=(r:Record<string,unknown>,k:string,valid:(x:unknown)=>boolean)=>!Object.hasOwn(r,k)||valid(r[k]);
function timestamp(x:unknown):x is string{
 if(!label(x,64)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(x)||!Number.isFinite(Date.parse(x)))return false;
 const year=Number(x.slice(0,4)),month=Number(x.slice(5,7)),day=Number(x.slice(8,10));
 const leap=year%4===0&&(year%100!==0||year%400===0);
 const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 return month>=1&&month<=12&&day>=1&&day<=days[month-1]&&Number(x.slice(11,13))<24;
}
const text=(x:unknown,max:number)=>x===''||label(x,max);
function validUsageEvent(r:Record<string,unknown>):boolean{
 return optional(r,'runId',x=>label(x,128))&&optional(r,'time',timestamp)
  &&optional(r,'credentialId',x=>typeof x==='string'&&uuid.test(x))
  &&optional(r,'credentialName',x=>text(x,256))&&optional(r,'result',x=>typeof x==='string'&&results.includes(x))
  &&optional(r,'command',x=>text(x,32768))&&optional(r,'cwd',x=>text(x,4096))&&optional(r,'initiator',x=>text(x,128))
  &&optional(r,'chain',x=>text(x,8192)||Array.isArray(x)&&x.length<=128&&x.every(v=>text(v,4096)))
  &&optional(r,'parentHadVariable',x=>typeof x==='boolean')
  &&optional(r,'exitCode',x=>Number.isSafeInteger(x)&&(x as number)>=-2147483648&&(x as number)<=2147483647)
  &&optional(r,'seconds',x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);
}
async function readRecentUsage(path:string):Promise<RecentCredentialUsage>{
 const out:RecentCredentialUsage={status:'available',decisions:[],lastDecisionAt:{},skippedLines:0,truncated:false};
 try{
  const {bytes,truncated}=await readPrivateBytes(path,true);out.truncated=truncated;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  // Parse byte-delimited lines separately: malformed UTF-8 must not become display text.
  let start=0;
  for(let end=0;end<=bytes.length;end++){
   if(end<bytes.length&&bytes[end]!==10)continue;
   const line=bytes.subarray(start,end);start=end+1;if(!line.length)continue;
   try{
    const r:unknown=JSON.parse(decoder.decode(line));
    if(!record(r)||!label(r.event,128))throw Error('invalid');
    if(r.event!=='decision'&&r.event!=='exit')continue;
    if(!validUsageEvent(r))throw Error('invalid');
    if(r.event==='exit')continue;
    if(!timestamp(r.time)||typeof r.credentialId!=='string'||!uuid.test(r.credentialId)||typeof r.result!=='string'||!results.includes(r.result))throw Error('invalid');
    const d:CredentialDecision={time:r.time,credentialId:r.credentialId.toLowerCase(),credentialName:(r.credentialName as string|undefined)??'',initiator:(r.initiator as string|undefined)??'',result:r.result as CredentialDecision['result'],command:(r.command as string|undefined)??'',cwd:(r.cwd as string|undefined)??''};
    const previous=out.lastDecisionAt[d.credentialId];if(!previous||Date.parse(d.time)>Date.parse(previous))out.lastDecisionAt[d.credentialId]=d.time;
    out.decisions.unshift(d);out.decisions.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));if(out.decisions.length>20)out.decisions.pop();
   }catch{out.skippedLines++;}
  }
 }catch(error){out.status=(error as NodeJS.ErrnoException).code==='ENOENT'?'absent':'unavailable';}
 return out;
}
// usage-summary.json is written by `housekeeper-vault run`: counts and the last decision per credential, never values.
function usageEntries(raw:unknown):Map<string,CredentialUsage>{
 if(!record(raw)||!fields(raw,['schemaVersion','updatedAt','credentials'])||raw.schemaVersion!==1||!label(raw.updatedAt,64)||!record(raw.credentials)||Object.keys(raw.credentials).length>1000)throw Error('invalid');
 const entries=new Map<string,CredentialUsage>();
 for(const [id,u] of Object.entries(raw.credentials)){
  if(!uuid.test(id)||!record(u)||!fields(u,[...results,'lastAt','lastResult','lastInitiator'])||!results.every(k=>Number.isSafeInteger(u[k])&&(u[k] as number)>=0)||!(u.lastAt===''||label(u.lastAt,64)&&Number.isFinite(Date.parse(u.lastAt)))||!(u.lastResult===''||results.includes(u.lastResult as string))||!(u.lastInitiator===''||label(u.lastInitiator,128)))throw Error('invalid');
  entries.set(id,{approved:u.approved as number,denied:u.denied as number,timeout:u.timeout as number,unavailable:u.unavailable as number,lastAt:u.lastAt as string,lastResult:u.lastResult as string,lastInitiator:u.lastInitiator as string});
 }
 return entries;
}
export async function readLocalCatalog(path:string|false):Promise<LocalCatalogResult>{
 const empty=(status:LocalCatalogResult['status']):LocalCatalogResult=>({status,credentials:[]});
 if(path===false)return empty('absent');
 try{
  const raw=await readPrivateJson(path);
  if(!record(raw)||!fields(raw,['schemaVersion','storage','credentials','updatedAt'])||raw.schemaVersion!==1||raw.storage!=='macos-keychain'||!label(raw.updatedAt,64)||!Number.isFinite(Date.parse(raw.updatedAt))||!Array.isArray(raw.credentials)||raw.credentials.length>1000)throw Error('invalid');
  let usage:Map<string,CredentialUsage>|undefined,usageStatus:'unavailable'|undefined;
  try{usage=usageEntries(await readPrivateJson(join(dirname(resolve(path)),'usage-summary.json')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')usageStatus='unavailable';}
  const seen=new Set<string>();const credentials:CredentialSummary[]=raw.credentials.map(c=>{
   // v1 entries are stored only; v2 entries (signed vault) can be handed to one command per approval.
   const paired=record(c)&&(c.status==='stored_unconnected'&&c.usageInstructions===localUsage||c.status==='run_with_approval'&&c.usageInstructions===runUsage);
   if(!record(c)||!paired||!fields(c,['id','name','provider','category','environmentVariables','sources','usageInstructions','canProbe','status'])||typeof c.id!=='string'||!uuid.test(c.id)||seen.has(c.id)||!label(c.name,256)||!label(c.provider,128)||!label(c.category,128)||c.canProbe!==false||!Array.isArray(c.environmentVariables)||c.environmentVariables.length>32||!c.environmentVariables.every(variable)||new Set(c.environmentVariables).size!==c.environmentVariables.length||!Array.isArray(c.sources)||c.sources.length>1000||!c.sources.every(s=>record(s)&&fields(s,['path','field'])&&label(s.path,4096)&&label(s.field,512)))throw Error('invalid');
   seen.add(c.id);const runnable=c.status==='run_with_approval',used=runnable?usage?.get(c.id):undefined;
   return {id:'local:'+c.id,name:c.name,environmentVariables:c.environmentVariables,usageInstructions:runnable?runUsage:localUsage,storage:'macos-keychain',canProbe:false,...(runnable?{runnable:true as const}:{}),...(used?{usage:used}:{})};
  });const recentUsage=await readRecentUsage(join(dirname(resolve(path)),'usage.jsonl'));return {status:'available',credentials,recentUsage,...(usageStatus?{usage:usageStatus}:{})};
 }catch(error){return empty((error as NodeJS.ErrnoException).code==='ENOENT'?'absent':'unavailable');}
}
