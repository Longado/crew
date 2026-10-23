import { startOwned, minimalEnvironment, type OwnedProcess } from './process.ts';
export type HelperTool = 'list_credentials' | 'request_credential_input' | 'credential_input_status' | 'cancel_credential_input' | 'run' | 'request_status' | 'request_cancel';
export class Helper {
 private owned = new Set<OwnedProcess>(); private closed=false;
 private path:string; private debugDirectory:string; private timeoutMs:number; private maxBytes:number;
 constructor(path:string, debugDirectory:string, timeoutMs=15000, maxBytes=1024*1024){this.path=path;this.debugDirectory=debugDirectory;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;}
 async call(name:HelperTool,args:Record<string,unknown>):Promise<any>{
  if(this.closed || this.owned.size>=8)throw Error('unavailable');
  let answer:any;let received=false;
  const proc=startOwned(this.path,['mcp'],{env:{...minimalEnvironment(),ASKKEY_DEBUG_RUN_DIRECTORY:this.debugDirectory},timeoutMs:this.timeoutMs,maxBytes:this.maxBytes,maxLineBytes:this.maxBytes,onLine(line){
   const frame=JSON.parse(line);if(frame.id!==2)return;if(received)throw Error('duplicate');received=true;
   if(frame.error || frame.result?.isError)throw Error('unavailable');
   const text=frame.result?.content?.find((v:any)=>v.type==='text' && typeof v.text==='string')?.text;
   if(!text)throw Error('unavailable');answer=JSON.parse(text);
  }});
  this.owned.add(proc);
  proc.child.stdin!.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'Crew',version:'test'}}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})+'\n');
  try {const result=await proc.done;if(!result.valid || result.code!==0 || !received)throw Error('unavailable');return answer;}finally{this.owned.delete(proc);}
 }
 async close(){this.closed=true;const owned=[...this.owned];owned.forEach(p=>p.stop());await Promise.all(owned.map(p=>p.done));}
}
