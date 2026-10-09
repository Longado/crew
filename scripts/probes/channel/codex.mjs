import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir=pathToFileURL(mkdtempSync(join(tmpdir(),'corpus-codex-probe-'))+'/');
const tmp=createServer();await new Promise(r=>tmp.listen(0,'127.0.0.1',r));const port=tmp.address().port;await new Promise(r=>tmp.close(r));
const url=`ws://127.0.0.1:${port}`;
const server=spawn('codex',['app-server','--listen',url],{cwd:dir,stdio:['ignore','pipe','pipe']});
let stderr='';server.stderr.on('data',x=>stderr+=x);server.stdout.resume();
let ws;const pending=new Map();const notices=[];let next=1;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function request(method,params){return new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},20000);pending.set(id,{resolve:x=>{clearTimeout(timer);resolve(x)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}));});}
async function waitFor(fn,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const v=fn();if(v)return v;await sleep(100);}throw Error('Notification timeout');}
try{
 for(let n=0;n<60;n++){
  try{ws=await new Promise((resolve,reject)=>{const s=new WebSocket(url);s.addEventListener('open',()=>resolve(s),{once:true});s.addEventListener('error',reject,{once:true});});break;}catch{await sleep(150);}
 }
 if(!ws)throw Error('App Server did not listen');
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else notices.push(m);});
 await request('initialize',{clientInfo:{name:'corpus-channel-probe',version:'0.0.1'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized'}));
 const created=await request('thread/start',{cwd:dir.pathname,approvalPolicy:'never',sandbox:'read-only',developerInstructions:'This is an isolated communication test. Do not use any tools, spawn agents, inspect files or access the network. Reply only with the exact marker requested by each message.'});
 const threadId=created.thread.id;console.log('THREAD_CREATED');
 const started=await request('turn/start',{threadId,input:[{type:'text',text:'Reply exactly CORPUS_CODEX_INITIAL_OK.'}]});
 await waitFor(()=>notices.find(x=>x.method==='turn/completed'&&x.params?.turn?.id===started.turn.id));
 const before=notices.filter(x=>x.method==='item/completed'&&x.params?.item?.type==='agentMessage').map(x=>x.params.item.text);
 console.log('INITIAL',JSON.stringify(before));
 const queue=spawn('codex',['queue','--remote',url,'--thread',threadId,'--message','Reply exactly CORPUS_CODEX_QUEUE_OK.'],{cwd:dir,stdio:['ignore','pipe','pipe']});
 let qo='',qe='';queue.stdout.on('data',x=>qo+=x);queue.stderr.on('data',x=>qe+=x);
 const code=await new Promise(r=>queue.on('close',r));console.log('QUEUE_EXIT',code);if(code!==0)throw Error(qe.slice(-1000));
 await waitFor(()=>notices.find(x=>x.method==='item/completed'&&x.params?.item?.type==='agentMessage'&&x.params.item.text.includes('CORPUS_CODEX_QUEUE_OK')));
 const record={probe:'codex queue to dedicated App Server thread',initial:before,queuedReply:notices.filter(x=>x.method==='item/completed'&&x.params?.item?.type==='agentMessage').map(x=>x.params.item.text),queueExit:code};
 writeFileSync(new URL('receipt.json',dir),JSON.stringify(record,null,2));console.log('RECEIPT',JSON.stringify(record));
}catch(e){console.log('PROBE_ERROR',String(e));console.log('SERVER_DIAGNOSTIC',stderr.split('\n').filter(x=>/error|warn/i.test(x)).slice(-4).join('\n').slice(-1800));process.exitCode=1;}
finally{ws?.close();server.kill('SIGTERM');setTimeout(()=>server.kill('SIGKILL'),1500).unref();}
