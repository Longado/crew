import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=()=>readFileSync(new URL('../web/security.js',import.meta.url),'utf8').replace('export function mountSecurity','function mountSecurity');
async function render(catalog:unknown){
 let html='';const root:any={set innerHTML(v:string){html=v},onclick:null};const ctx:any={setTimeout,clearTimeout};vm.createContext(ctx);vm.runInContext(source()+';this.mount=mountSecurity;',ctx);
 const unmount=ctx.mount(root,{api:async()=>catalog});await new Promise(r=>setImmediate(r));unmount();return html;
}
const base={status:'available',testOnly:true,nativeAvailable:false};
test('runnable local key shows approval-per-use and its use counts, escaped, with no action buttons',async()=>{
 const html=await render({...base,localStore:{status:'available',count:1},credentials:[{id:'local:id',name:'Synthetic run key',storage:'macos-keychain',usageInstructions:'逐次授权取用',environmentVariables:['SYNTHETIC_API_KEY'],canProbe:false,runnable:true,usage:{approved:2,denied:1,timeout:1,unavailable:0,lastAt:'2026-10-21T01:00:00Z',lastResult:'denied',lastInitiator:'Codex <b>Terminal</b>'}}]});
 assert.doesNotMatch(html,/本地钥匙串 · 逐次授权取用（每次 Touch ID 或密码）/);
 assert.equal((html.match(/逐次授权取用/g)||[]).length,1);
 assert.match(html,/已批准 2 次，未批准 2 次/);
 assert.match(html,/Codex &lt;b&gt;Terminal&lt;\/b&gt;（已拒绝）/);
 assert.doesNotMatch(html,/待接入授权使用|data-security="probe"/);
});
test('unreadable usage summary is said out loud',async()=>{
 const html=await render({...base,localStore:{status:'available',count:1,usage:'unavailable'},credentials:[{id:'local:id',name:'Synthetic run key',storage:'macos-keychain',usageInstructions:'逐次授权取用',environmentVariables:['SYNTHETIC_API_KEY'],canProbe:false,runnable:true}]});
 assert.match(html,/使用记录暂不可读取/);
 assert.doesNotMatch(html,/已批准/);
});
