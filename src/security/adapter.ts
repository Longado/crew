import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { securityConfig } from '../config.ts';
import { readLocalCatalog } from './local-catalog.ts';
import { Helper } from './helper.ts';
import { choosePython, launchScan, type ScanOptions } from './scanner.ts';
import type { OwnedProcess } from './process.ts';
import type { SecurityService, SecurityOperation, CredentialCatalog, CredentialSummary, SecurityState } from './types.ts';
export interface SecurityServiceOptions extends Partial<ScanOptions> { helperPath?:string; localCatalogPath?:string|false; nativeEnabled?:boolean; debugRunDirectory?:string; helperTimeoutMs?:number; helperMaxOutputBytes?:number; retentionMs?:number; maxOperations?:number }
type Entry={public:SecurityOperation; correlation?:{request_id:string;capability:string}; tickets?:Array<{request_id:string;capability:string}>; run?:Record<string,unknown>; process?:OwnedProcess; task?:Promise<void>; serial:Promise<unknown>};
let scanLease: Entry | undefined;
const hasNativeOwnership=(e:Entry)=>Boolean(e.correlation || e.tickets?.length);
const evictable=(e:Entry)=>terminal(e.public.state)&&!hasNativeOwnership(e);
const terminal=(s:SecurityState)=>['completed','cancelled','expired','failed'].includes(s);
const clean=(s:unknown,max=4096)=>typeof s==='string'?s.slice(0,max):'';
const safeVariable=(s:unknown):s is string=>typeof s==='string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(s) && !/^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|CDPATH|TMPDIR|TMP|TEMP|PWD|OLDPWD|USER|LOGNAME|TERM|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|LANG|LC_.*|DYLD_.*|LD_.*|PYTHON.*|NODE_.*|RUBY.*|PERL.*|ZDOTDIR|GIT_.*|ASKKEY_.*)$/i.test(s);
function catalogItem(raw:any):CredentialSummary|undefined{
 if(typeof raw.credentialID!=='string'||typeof raw.name!=='string'||!raw.credentialID||!raw.name||raw.credentialID.length>256||raw.name.length>256||/[\x00-\x1f\x7f]/.test(raw.name))return;
 let variables:unknown[]=[raw.environmentVariable];let supported=raw.payloadKind==='text';
 if(Array.isArray(raw.components)&&raw.components.length){variables=raw.components.map((c:any)=>c.delivery?.environmentVariable?._0);supported=raw.components.every((c:any)=>c.payloadKind==='text'&&c.delivery?.environmentVariable);}
 const environmentVariables=variables.filter(safeVariable);supported=Boolean(supported)&&environmentVariables.length===variables.length&&new Set(environmentVariables).size===environmentVariables.length&&!raw.expired;
 return {id:clean(raw.credentialID,256),name:clean(raw.name,256),usageInstructions:clean(raw.usageInstructions),environmentVariables,canProbe:supported};
}
export function createSecurityService(options:SecurityServiceOptions={}):SecurityService {
 options={...securityConfig(),...options};
 const helper=options.nativeEnabled!==false&&options.helperPath?new Helper(options.helperPath,options.debugRunDirectory??join(homedir(),'.local-sensitive','askkey-local-scan'),options.helperTimeoutMs,options.helperMaxOutputBytes):undefined;
 const entries=new Map<string,Entry>();let closed=false;
 const copy=(e:Entry)=>structuredClone(e.public);
 const touch=(e:Entry,state:SecurityState)=>{e.public.state=state;e.public.updatedAt=new Date().toISOString();};
 const fail=(e:Entry)=>{touch(e,'failed');e.public.error={code:'unavailable',message:'本地操作不可用，请检查已配置组件的状态。'};};
 const ensure=()=>{if(closed)throw Error('security service closed');};
 const prune=()=>{const now=Date.now();for(const [id,e]of entries)if(evictable(e)&&now-Date.parse(e.public.updatedAt)>(options.retentionMs??1800000))entries.delete(id);if(entries.size>=(options.maxOperations??128)){for(const [id,e]of entries){if(evictable(e)){entries.delete(id);break;}}}if(entries.size>=(options.maxOperations??128))throw Error('security operation limit');};
 const create=(kind:SecurityOperation['kind'],projectId?:string)=>{ensure();prune();const now=new Date().toISOString();const e:Entry={public:{id:randomUUID(),kind,...(projectId===undefined?{}:{projectId}),state:kind==='local_input'?'waiting_input':'running',createdAt:now,updatedAt:now},serial:Promise.resolve()};entries.set(e.public.id,e);return e;};
 const scoped=(id:string,p?:string)=>{const e=entries.get(id);return e?.public.projectId===p?e:undefined;};
 const serial=async(e:Entry,work:()=>Promise<void>)=>{const pending=e.serial.then(work,work);e.serial=pending.catch(()=>{});await pending;};
 const correlation=(raw:any)=>{if(typeof raw.request_id!=='string'||typeof raw.capability!=='string'||raw.request_id.length>256||raw.capability.length>256)throw Error('invalid');return {request_id:raw.request_id,capability:raw.capability};};
 const inputState=(e:Entry,r:any)=>{if(['saved','cancelled','expired'].includes(r.state))e.correlation=undefined;if(r.state==='saved'&&typeof r.credential_id==='string'&&typeof r.credential_name==='string'){touch(e,'completed');e.public.result={credential:{id:clean(r.credential_id,256),name:clean(r.credential_name,256)}};}else if(r.state==='cancelled'||r.state==='expired'){touch(e,r.state);}else if(['pending','presented','waiting','waiting_input'].includes(r.state)){touch(e,'waiting_input');}else throw Error('invalid');};
 const runResult=(e:Entry,r:any)=>{
  if(r.exited && [0,10].includes(r.exited._0)){e.public.result={present:r.exited._0===0};e.tickets=undefined;touch(e,'completed');return;}
  const approval=r.approvalRequired;if(!approval||approval.operationID!==e.public.id||!Array.isArray(approval.tickets)||!approval.tickets.length||approval.tickets.length>32)throw Error('invalid');
  e.tickets=approval.tickets.map((t:any)=>correlation({request_id:t.requestID,capability:t.capability}));touch(e,'waiting_approval');
 };
 const statusState=(r:any):string=>r?.success?._0?.requestStatus?._0;
 const refresh=async(e:Entry,cancel=false)=>{if(terminal(e.public.state)&&!(cancel&&hasNativeOwnership(e)))return;
  try{
   if(e.public.kind==='local_input'&&e.correlation){inputState(e,await helper!.call(cancel?'cancel_credential_input':'credential_input_status',e.correlation));return;}
   if(e.public.kind==='env_presence'&&e.tickets){
    const states=await Promise.all(e.tickets.map(async t=>statusState(await helper!.call(cancel?'request_cancel':'request_status',t))));
    if(states.some(s=>s==='denied'||s==='cancelled'||s==='expired')){if(states.every(s=>['denied','cancelled','expired','completed','consumed'].includes(s)))e.tickets=undefined;else{const cleanup=await Promise.allSettled(e.tickets.map(t=>helper!.call('request_cancel',t)));if(cleanup.every(r=>r.status==='fulfilled'&&['denied','cancelled','expired','completed','consumed'].includes(statusState(r.value))))e.tickets=undefined;}touch(e,states.includes('expired')?'expired':'cancelled');return;}
    if(cancel){if(states.every(s=>s==='completed'||s==='consumed')){e.tickets=undefined;fail(e);}else {if(states.every(s=>['denied','cancelled','expired','completed','consumed'].includes(s)))e.tickets=undefined;touch(e,'cancelled');}return;}
    if(states.every(s=>s==='approved'))runResult(e,await helper!.call('run',e.run!));
    else if(states.some(s=>!['pending','approved'].includes(s)))throw Error('invalid');return;
   }
   if(cancel&&e.public.kind==='project_scan'){e.process?.stop();await e.task;if(!terminal(e.public.state))touch(e,'cancelled');}
  }catch{fail(e);}
 };
 const service:SecurityService={
  async listCredentials():Promise<CredentialCatalog>{
   if(closed)return {status:'unavailable',testOnly:true,nativeAvailable:false,scanAvailable:false,localStore:{status:'unavailable',count:0},credentials:[],message:'本地凭证库当前不可用。'};
   const local=await readLocalCatalog(options.localCatalogPath??join(homedir(),'.local-sensitive','housekeeper-vault','catalog.json'));
   let nativeAvailable=false;let native:CredentialSummary[]=[];
   if(helper)try{const r=await helper!.call('list_credentials',{});if(!Array.isArray(r.credentials)||r.credentials.length>10000)throw Error('invalid');native=r.credentials.map(catalogItem).filter(Boolean).filter((c:CredentialSummary)=>!c.id.startsWith('local:'));nativeAvailable=true;}catch{}
   const available=nativeAvailable||local.status==='available';
   return {status:available?'available':'unavailable',testOnly:true,nativeAvailable,scanAvailable:Boolean(options.scriptPath),localStore:{status:local.status,count:local.credentials.length,...(local.usage?{usage:local.usage}:{})},credentials:[...local.credentials,...native],...(local.recentUsage?{recentUsage:local.recentUsage}:{}),...(!available?{message:'本地凭证库当前不可用。'}:local.status==='unavailable'?{message:'本地凭证目录暂不可读取。'}:{})};
  },
  async requestInput(input){ensure();if(input.provider!=='ark')throw Error('unsupported provider');const e=create('local_input',input.projectId);await serial(e,async()=>{try{if(!helper)throw Error('unavailable');const r=await helper!.call('request_credential_input',{operation_id:e.public.id,suggested_name:'Ark',service_label:'Volcengine Ark',caller:'Crew',purpose:'local setup',environment_variable:'ARK_API_KEY'});e.correlation=correlation(r);inputState(e,r);}catch{fail(e);}});return copy(e);},
  async probe(input){ensure();const e=create('env_presence',input.projectId);await serial(e,async()=>{try{if(!helper||input.credentialId.startsWith('local:'))throw Error('unsupported');const catalog=await service.listCredentials();const credential=catalog.credentials.find(c=>c.id===input.credentialId);if(!credential?.canProbe)throw Error('unsupported');
   // The only executable payload is an offline presence predicate. Never print values.
   const code=credential.environmentVariables.map(v=>`test -n "\${${v}-}"`).join(' && ')+'; if [ "$?" -eq 0 ]; then exit 0; else exit 10; fi';
   e.run={operation_id:e.public.id,credentials:[credential.name],command:['/bin/sh','-c',code],caller_name:'Crew',caller_purpose:'offline environment presence only'};runResult(e,await helper!.call('run',e.run));}catch{fail(e);}});return copy(e);},
  async startScan(input){ensure();if(!options.scriptPath){const e=create('project_scan',input.projectId);fail(e);return copy(e);}if(scanLease)throw Error('security scan busy');const e=create('project_scan',input.projectId);scanLease=e;let cancelled=false;
   e.task=(async()=>{try{const python=await choosePython(options.pythonPath);if(closed||cancelled){touch(e,'cancelled');return;}const launched=launchScan(python,input.directory,{...options,scriptPath:options.scriptPath!},report=>{e.public.result={scan:report};e.public.progress={checkedFiles:report.checkedFiles,findings:report.findings.length};e.public.updatedAt=new Date().toISOString();},(files,findings)=>{e.public.progress={checkedFiles:files,findings};e.public.updatedAt=new Date().toISOString();});e.process=launched.process;const okay=await launched.done;if(cancelled||closed)touch(e,'cancelled');else if(okay)touch(e,'completed');else fail(e);
   }catch{if(cancelled||closed)touch(e,'cancelled');else fail(e);}finally{if(e.public.state!=='completed'&&e.public.result?.scan){e.public.result.scan.complete=false;e.public.result.scan.coverageNotes=['扫描范围尚未完整覆盖，当前结果仅供排查。'];}if(scanLease===e)scanLease=undefined;}})();
   const originalTask=e.task;const stop=()=>{cancelled=true;e.process?.stop();};(e as Entry&{cancelScan?:()=>void}).cancelScan=stop;void originalTask;return copy(e);},
  async getOperation(id,p){const e=scoped(id,p);if(!e)return;await serial(e,()=>refresh(e));return copy(e);},
  async cancelOperation(id,p){const e=scoped(id,p);if(!e)return;await serial(e,async()=>{if(terminal(e.public.state)&&!hasNativeOwnership(e))return;if(e.public.kind==='project_scan'){(e as Entry&{cancelScan?:()=>void}).cancelScan?.();await e.task;}else await refresh(e,true);});return copy(e);},
  latestScan(p){const all=[...entries.values()].filter(e=>e.public.projectId===p&&e.public.kind==='project_scan');const e=all.at(-1);return e?copy(e):undefined;},
  async close(){closed=true;await Promise.all([...entries.values()].map(e=>serial(e,async()=>{if(terminal(e.public.state)&&!hasNativeOwnership(e))return;if(e.public.kind==='project_scan'){(e as Entry&{cancelScan?:()=>void}).cancelScan?.();await e.task;}else await refresh(e,true);})));if(![...entries.values()].some(hasNativeOwnership)){await helper?.close();entries.clear();}}
 };return service;
}
