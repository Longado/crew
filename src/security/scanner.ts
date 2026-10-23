import { startOwned, type OwnedProcess } from './process.ts';
import type { SecurityScanResult, SecurityFinding } from './types.ts';
export interface ScanOptions { scriptPath:string; pythonPath?:string; maxFiles?:number; maxFindings?:number; maxFileBytes?:number; maxOutputBytes?:number; maxLineBytes?:number; idleTimeoutMs?:number; overallTimeoutMs?:number }
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):0;
export function projectReport(raw:any, complete:boolean):SecurityScanResult {
 if(raw?.schema_version!==1 || !raw.coverage || !Array.isArray(raw.findings))throw Error('invalid');
 const findings:SecurityFinding[]=raw.findings.slice(0,1000).flatMap((f:any)=>{
  if(typeof f.path!=='string' || typeof f.rule!=='string')return [];
  return [{path:f.path.slice(0,4096),line:Number.isSafeInteger(f.line)?f.line:null,column:Number.isSafeInteger(f.column)?f.column:null,rule:f.rule.slice(0,128),rules:Array.isArray(f.rules)?f.rules.filter((r:unknown)=>typeof r==='string').slice(0,32).map((r:string)=>r.slice(0,128)):[f.rule.slice(0,128)],priority:['high','review','low'].includes(f.priority)?f.priority:'review'}];
 });
 const covered=complete && raw.coverage.status==='completed' && !raw.coverage.file_limit_reached && !raw.coverage.finding_limit_reached;
 return {scannedAt:new Date().toISOString(),checkedFiles:count(raw.coverage.files_scanned),complete:covered,findings,summary:{high:findings.filter(f=>f.priority==='high').length,review:findings.filter(f=>f.priority==='review').length,low:findings.filter(f=>f.priority==='low').length},coverageNotes:covered?['仅检查本地文件中的凭证与配置线索。']:['扫描范围尚未完整覆盖，当前结果仅供排查。']};
}
export async function choosePython(explicit?:string):Promise<string>{
 for(const path of explicit?[explicit]:['/opt/homebrew/bin/python3.13','/opt/homebrew/bin/python3.12','/opt/homebrew/bin/python3.11','/opt/homebrew/bin/python3','/usr/local/bin/python3.13','/usr/local/bin/python3','/usr/bin/python3']){
  let valid=false;const p=startOwned(path,['-I','-B','-c','import sys; print("READY" if sys.version_info >= (3,11) else "OLD")'],{timeoutMs:3000,maxBytes:256,maxLineBytes:256,onLine(line){valid=line==='READY';}});p.child.stdin!.end();const result=await p.done;if(result.valid&&result.code===0&&valid)return path;
 }throw Error('python unavailable');
}
export function launchScan(python:string,directory:string,options:ScanOptions,onReport:(result:SecurityScanResult)=>void,onProgress:(files:number,findings:number)=>void):{process:OwnedProcess;done:Promise<boolean>}{
 let started=false,completed=false;
 const process=startOwned(python,['-I','-B',options.scriptPath,directory,'--format','ndjson','--max-files',String(options.maxFiles??10000),'--max-findings',String(options.maxFindings??1000),'--max-file-bytes',String(options.maxFileBytes??1048576)],{timeoutMs:options.overallTimeoutMs??7200000,idleMs:options.idleTimeoutMs??120000,maxBytes:options.maxOutputBytes??67108864,maxLineBytes:options.maxLineBytes??4194304,onLine(line){
  const e=JSON.parse(line);if(e.protocol_version!==1 || completed)throw Error('invalid');
  if(e.event==='started'){if(started)throw Error('invalid');started=true;return;}if(!started)throw Error('invalid');
  if(e.event==='progress'){onProgress(count(e.files_scanned),count(e.findings_retained??e.findings_seen));return;}
  if(e.event==='results'||e.event==='completed'){onReport(projectReport(e.report,e.event==='completed'));completed=e.event==='completed';return;}throw Error('invalid');
 }});process.child.stdin!.end();return {process,done:process.done.then(r=>r.valid&&[0,1,2].includes(r.code ?? -1)&&started&&completed)};
}
