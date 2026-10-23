import { spawn, type ChildProcess } from 'node:child_process';
export const minimalEnvironment = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' });
export interface OwnedProcess { child: ChildProcess; done: Promise<{ code: number | null; valid: boolean }>; stop(): void }
export function startOwned(executable: string, args: string[], options: { env?: Record<string,string>; timeoutMs: number; idleMs?: number; maxBytes: number; maxLineBytes: number; onLine(line:string):void }): OwnedProcess {
 const child = spawn(executable,args,{env:options.env ?? minimalEnvironment(),stdio:['pipe','pipe','ignore'],detached:true});
 let valid=true, ended=false, bytes=0, buffer=Buffer.alloc(0); let killTimer: ReturnType<typeof setTimeout> | undefined;
 const stop=()=>{ valid=false; if(ended)return; try { if(child.pid)process.kill(-child.pid,'SIGTERM'); }catch{}; killTimer ??= setTimeout(()=>{try {if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},200); };
 let idle:ReturnType<typeof setTimeout> | undefined;
 const resetIdle=()=>{if(idle)clearTimeout(idle); if(options.idleMs)idle=setTimeout(stop,options.idleMs);};
 const overall=setTimeout(stop,options.timeoutMs); resetIdle();
 const done=new Promise<{code:number|null;valid:boolean}>(resolve=>{
  child.on('error',()=>{valid=false;});
  child.stdout!.on('data',(data:Buffer)=>{resetIdle();bytes+=data.length;if(bytes>options.maxBytes){stop();return;}buffer=Buffer.concat([buffer,data]);
   let at:number;while((at=buffer.indexOf(10))>=0){const line=buffer.subarray(0,at);buffer=buffer.subarray(at+1);if(line.length>options.maxLineBytes){stop();return;}try{options.onLine(line.toString('utf8'));}catch{stop();return;}}
   if(buffer.length>options.maxLineBytes)stop();
  });
  child.on('close',code=>{
   clearTimeout(overall);if(idle)clearTimeout(idle);if(buffer.length)valid=false;
   // A leader can exit while descendants retain its owned process group. Keep
   // the kill escalation and caller's lease until the entire group is absent.
   const confirm=()=>{
    let absent=!child.pid;
    if(child.pid){try{process.kill(-child.pid,0);}catch(error){absent=(error as NodeJS.ErrnoException).code==='ESRCH';}}
    if(absent){ended=true;if(killTimer)clearTimeout(killTimer);resolve({code,valid});return;}
    stop();setTimeout(confirm,25);
   };confirm();
  });
 });
 child.stdin!.on('error',()=>{});
 return {child,done,stop};
}
