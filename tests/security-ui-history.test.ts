import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../web/security.js',import.meta.url),'utf8').replace('export function mountSecurity','function mountSecurity');
const id='local:test';
const key={id,name:'Synthetic',storage:'macos-keychain',usageInstructions:'instructions',environmentVariables:['TEST_KEY'],canProbe:true};
const catalog={status:'available',nativeAvailable:true,localStore:{status:'available',count:1},credentials:[key]};
async function mount(data:any){let html='';const calls:any[]=[];const root:any={set innerHTML(v:string){html=v},onclick:null};const ctx:any={setTimeout,clearTimeout};vm.createContext(ctx);vm.runInContext(source+';this.mount=mountSecurity;',ctx);const stop=ctx.mount(root,{projectId:'synthetic',api:async(...args:any[])=>{calls.push(args);return args[0].includes('/projects/')?{directories:[]}:data;}});await new Promise(r=>setImmediate(r));return {html:()=>html,root,calls,stop};}
test('recent use escapes all displayed strings, highlights refusals, and displays partial-record warning',async()=>{
 const bad='<img src=x onerror="x">&\'';
 const decisions=['approved','denied','timeout','unavailable'].map(result=>({time:'2026-10-21T00:00:00Z',credentialId:'test',credentialName:bad,initiator:bad,result,command:bad,cwd:bad}));
 const m=await mount({...catalog,recentUsage:{status:'available',decisions,skippedLines:2,lastDecisionAt:{},truncated:false}});try{
 const h=m.html();assert.match(h,/最近使用/);assert.match(h,/部分使用记录无法读取/);assert.match(h,/&lt;img src=x onerror=&quot;x&quot;&gt;&amp;&#39;/);assert.doesNotMatch(h,/<img/);assert.equal((h.match(/class="usage-refused"/g)||[]).length,3);
 assert.match(h,/已拒绝/);assert.match(h,/超时/);assert.match(h,/无法确认/);
 }finally{m.stop();}
});
test('stale and never-used labels use latest summary or history, and avoid false never-used on incomplete history',async()=>{
 const ago=(days:number)=>new Date(Date.now()-days*86400000).toISOString();
 for(const [extra,pattern,absent] of [
 [{usage:{approved:1,denied:0,timeout:0,unavailable:0,lastAt:ago(31),lastResult:'approved',lastInitiator:'test'}},/已闲置 31 天/,/从未使用/],
 [{},/从未使用/,/已闲置/],
 [{usage:{lastAt:ago(30.5),approved:1,denied:0,timeout:0,unavailable:0}},/已闲置 30 天/,/从未使用/],
 [{usage:{lastAt:ago(29),approved:1,denied:0,timeout:0,unavailable:0}},/Synthetic/,/已闲置|从未使用/],
 ] as const){const m=await mount({...catalog,credentials:[{...key,...extra}],recentUsage:{status:'absent',decisions:[],lastDecisionAt:{},skippedLines:0,truncated:false}});try{assert.match(m.html(),pattern);assert.doesNotMatch(m.html(),absent);}finally{m.stop();}}
 for(const state of [{status:'unavailable'},{status:'available',truncated:true},{status:'available',skippedLines:1}]){const m=await mount({...catalog,recentUsage:{decisions:[],lastDecisionAt:{},skippedLines:0,...state}});try{assert.doesNotMatch(m.html(),/从未使用/);}finally{m.stop();}}
 const m=await mount({...catalog,credentials:[{...key,usage:{lastAt:ago(40),approved:1,denied:0,timeout:0,unavailable:0}}],recentUsage:{status:'available',decisions:[],lastDecisionAt:{test:ago(1)},skippedLines:0}});try{assert.doesNotMatch(m.html(),/已闲置|从未使用/);}finally{m.stop();}
});
test('recent-use list and per-key usage and inactivity text add no controls or API calls',async()=>{
 const time=new Date(Date.now()-31*86400000).toISOString();
 const m=await mount({...catalog,credentials:[{...key,usage:{approved:1,denied:0,timeout:0,unavailable:0,lastAt:time,lastResult:'approved',lastInitiator:'test'}}],recentUsage:{status:'available',decisions:[{time,credentialId:'test',credentialName:key.name,initiator:'test',result:'approved',command:'echo synthetic',cwd:'/synthetic'}],lastDecisionAt:{test:time},skippedLines:0,truncated:false}});try{
 const h=m.html();
 const history=h.match(/<section aria-label="最近使用">[\s\S]*?<\/section>/)?.[0];
 const credential=h.match(/<li><strong>Synthetic<\/strong>[\s\S]*?<\/li>/)?.[0];
 assert.ok(history);assert.ok(credential);
 assert.match(history,/<ol>\s*<li/);assert.match(history,/echo synthetic/);
 assert.match(credential,/已批准 1 次/);assert.match(credential,/已闲置 31 天/);
 for(const content of [history,credential])assert.doesNotMatch(content,/\bdata-security\b|<(?:button|a)\b/i);
 assert.match(h,/data-security="refresh"/);assert.match(h,/data-security="input"/);
 const before=m.calls.length;
 // History descendants and per-key text have no actionable ancestor.
 for(const tagName of ['SECTION','OL','LI','TIME','STRONG','CODE','P'])await m.root.onclick({target:{tagName,closest:(selector:string)=>{assert.equal(selector,'[data-security]');return null;}}});
 assert.equal(m.calls.length,before);
 }finally{m.stop();}
});
