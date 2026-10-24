import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=()=>readFileSync(new URL('../web/security.js',import.meta.url),'utf8').replace('export function mountSecurity','function mountSecurity');
test('security view escapes metadata, never offers a web secret field and static demo makes no requests',async()=>{
 let html='',calls=0; const root={get innerHTML(){return html},set innerHTML(v){html=v},onclick:null};
 const ctx:any={setTimeout,clearTimeout,console}; vm.createContext(ctx);vm.runInContext(source()+';this.mount=mountSecurity;',ctx);
 ctx.mount(root,{api:async()=>{calls++;return {status:'available',testOnly:true,nativeAvailable:true,credentials:[{id:'a',name:'<script>x</script>',usageInstructions:'<img>',environmentVariables:['ARK_API_KEY'],canProbe:true}]}}});
 await new Promise(r=>setImmediate(r)); assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<input|<script>|type="password"/);assert.match(html,/仅使用假 Key/);
 calls=0;ctx.mount(root,{staticDemo:true,api:async()=>{calls++}});assert.equal(calls,0);assert.match(html,/只读演示/);
});
function harness(projectId?:string){
 let html='',writes=0,timer:Function|undefined,cleared=false,handler:any;
 const requests:any[]=[]; let op:any={id:'public-op',kind:'local_input',projectId,state:'waiting_input'};let catalogReads=0, delayed:Promise<any>|undefined;
 const root:any={get innerHTML(){return html},set innerHTML(v:string){html=v;writes++},set onclick(fn:any){handler=fn},querySelector:()=>({value:'directory-0'})};
 const ctx:any={setTimeout(fn:Function){timer=fn;return 1},clearTimeout(){timer=undefined;cleared=true},console};vm.createContext(ctx);vm.runInContext(source()+';this.mount=mountSecurity;',ctx);
 const api=async(path:string,opts?:any)=>{requests.push({path,...opts});if(path.endsWith('/credentials')){catalogReads++;return {status:'available',testOnly:true,nativeAvailable:true,scanAvailable:true,credentials:[{id:'cred',name:'fake',usageInstructions:'offline',environmentVariables:[],canProbe:true}]}}if(path.includes('/projects/'))return {directories:[{id:'directory-0',label:'<bad-directory>'}],latestScan:op.result?.scan?op:undefined};if(opts?.method==='POST'){if(path.endsWith('/cancel'))op={...op,state:'cancelled'};return op;}return delayed || op;};
 const unmount=ctx.mount(root,{projectId,projectName:'<unsafe>',api});
 const flush=()=>new Promise(r=>setImmediate(r));
 return {flush,unmount,requests,html:()=>html,writes:()=>writes,reads:()=>catalogReads,cleared:()=>cleared,setOp:(value:any)=>{op=value},delay:(value:Promise<any>)=>{delayed=value},tick:async()=>{const fn=timer;timer=undefined;await fn?.()},click:async(action:string)=>handler({target:{closest:()=>({dataset:{security:action,id:'cred'},disabled:false})}})};
}
test('native input and offline probe poll states, refresh saved catalog and never send secrets or approvals',async()=>{
 const f=harness();await f.flush();await f.click('input');assert.match(f.html(),/请在本地凭证管家输入/);
 assert.deepEqual(JSON.parse(JSON.stringify(f.requests.find(r=>r.path.endsWith('/inputs')).body)),{provider:'ark'});
 f.setOp({id:'public-op',state:'completed',result:{credential:{id:'cred',name:'fake'}}});await f.tick();assert.match(f.html(),/凭证已保存/);assert.equal(f.reads(),2);
 f.setOp({id:'probe',state:'waiting_approval'});await f.click('probe');assert.match(f.html(),/请在本地凭证管家确认/);
 f.setOp({id:'probe',state:'completed',result:{present:true}});await f.tick();assert.match(f.html(),/可在本次授权中取用/);
 assert.equal(f.requests.some(r=>r.path.includes('/approve')),false);assert.doesNotMatch(JSON.stringify(f.requests),/secret|apiKey|password/);f.unmount();
});
test('project scan uses opaque registered ID, partial results show positions, cancellation and unmount stop polling',async()=>{
 const f=harness('project');await f.flush();assert.match(f.html(),/本次启动后尚未扫描/);assert.match(f.html(),/&lt;bad-directory&gt;/);assert.match(f.html(),/&lt;unsafe&gt;/);
 f.setOp({id:'scan',projectId:'project',state:'running'});await f.click('scan');assert.deepEqual(JSON.parse(JSON.stringify(f.requests.find(r=>r.path.endsWith('/scans')).body)),{projectId:'project',directoryId:'directory-0'});
 await f.click('cancel');assert.match(f.html(),/已取消/);
 f.setOp({id:'scan',projectId:'project',state:'running'});await f.click('scan');
 f.setOp({id:'scan',projectId:'project',state:'completed',result:{scan:{scannedAt:'2026-10-20',checkedFiles:2,complete:false,summary:{high:1,review:0,low:0},coverageNotes:['<partial>'],findings:[{path:'<file>',line:7,column:3,priority:'high',rules:['rule']}]}}});await f.tick();assert.match(f.html(),/扫描范围不完整/);assert.match(f.html(),/&lt;file&gt;:7:3/);assert.match(f.html(),/&lt;partial&gt;/);
 f.setOp({id:'late',projectId:'project',state:'running'});await f.click('scan');let resolve:any;f.delay(new Promise(r=>{resolve=r}));const pending=f.tick();f.unmount();const before=f.writes();resolve({id:'late',state:'completed'});await pending;assert.equal(f.writes(),before);assert.equal(f.cleared(),true);
});
test('global security route precedes zero-project welcome and uses route scope',()=>{
 const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');assert.ok(app.indexOf("if (r.page === 'security')")<app.indexOf("else if (!app.projects.length"));assert.match(app,/projectId:r.pid/);assert.match(app,/href="#\/security"/);assert.match(app,/unmountSecurity\?\.\(\)/);
});
test('late poll cannot overwrite a completed cancellation or restart polling',async()=>{
 const f=harness();await f.flush();await f.click('input');let resolve:any;f.delay(new Promise(r=>{resolve=r}));const poll=f.tick();await f.click('cancel');const writes=f.writes();resolve({id:'public-op',state:'waiting_input'});await poll;assert.match(f.html(),/已取消/);assert.equal(f.writes(),writes);const calls=f.requests.length;await f.tick();assert.equal(f.requests.length,calls);f.unmount();
});
test('late poll cannot overwrite a newer operation',async()=>{
 const f=harness();await f.flush();await f.click('input');let resolve:any;f.delay(new Promise(r=>{resolve=r}));const poll=f.tick();await f.click('cancel');f.setOp({id:'new-op',state:'waiting_approval'});await f.click('probe');const writes=f.writes();resolve({id:'public-op',state:'completed',result:{credential:{id:'old',name:'old'}}});await poll;assert.match(f.html(),/请在本地凭证管家确认/);assert.doesNotMatch(f.html(),/凭证已保存/);assert.equal(f.writes(),writes);f.unmount();
});
test('direct global and project security startup skips legacy conversation read and immediately loads',async()=>{
 const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');const startup=app.slice(app.indexOf('const initialPage = parseHash().page;'));
 const parser=app.slice(app.indexOf('function parseHash()'),app.indexOf('async function load()'));
 for(const hash of ['#/security','#/p/project/security','#/p/project/workspace','#/p/project/overview']){let reads=0,loads=0;const legacy=hash.endsWith('/overview');vm.runInNewContext(parser+startup,{location:{hash},STATIC:false,Promise,api:()=>{reads++;return new Promise(()=>{})},load:async()=>{loads++},$:()=>({}),esc:(s:any)=>s});await new Promise(r=>setImmediate(r));assert.equal(reads,legacy?1:0);assert.equal(loads,legacy?0:1);}
});

test('real local catalog is separate from fake native flow and cannot offer native actions',async()=>{let html='';const root:any={set innerHTML(v:string){html=v},onclick:null};const ctx:any={setTimeout,clearTimeout};vm.createContext(ctx);vm.runInContext(source()+';this.mount=mountSecurity;',ctx);const unmount=ctx.mount(root,{api:async()=>({status:'available',testOnly:true,nativeAvailable:false,localStore:{status:'available',count:1},credentials:[{id:'local:id',name:'Ark',storage:'macos-keychain',usageInstructions:'已集中保存；授权使用尚未接入。',environmentVariables:['ARK_API_KEY'],canProbe:false}]})});await new Promise(r=>setImmediate(r));assert.match(html,/本地凭证库：由 macOS 钥匙串保存/);assert.doesNotMatch(html,/原生录入与检测仍为隔离测试/);assert.doesNotMatch(html,/data-security="input"/);assert.doesNotMatch(html,/data-security="probe"/);assert.match(html,/本地钥匙串 · 已保存，待接入授权使用/);unmount();});
