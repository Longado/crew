import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from './bridge-core.mjs';
import { subscriptionEnv, checkCodexSubscription } from './subscription.mjs';

test('subscription mode strips API credentials without mutating parent', () => {
 const source = { PATH:'/bin', OPENAI_API_KEY:'secret', ANTHROPIC_API_KEY:'secret', CLAUDE_CODE_USE_VERTEX:'1' };
 assert.deepEqual(subscriptionEnv(source), {PATH:'/bin'});
 assert.equal(source.OPENAI_API_KEY,'secret');
 assert.throws(()=>checkCodexSubscription({account:{type:'apiKey'}}));
 assert.throws(()=>checkCodexSubscription({account:{type:'chatgpt',planType:'free'}}));
 assert.deepEqual(checkCodexSubscription({account:{type:'chatgpt',planType:'pro'}}),{authMethod:'chatgpt',planType:'pro'});
});

test('authenticated routing, correlated replies and idempotency', async () => {
 const delivered=[];
 const bridge=await createBridge({tokens:{codex:'a',claude:'b'},deliverCodex: async m=>{delivered.push(m);}});
 const post=async (token,path,body)=>{const r=await fetch(bridge.url+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try {
  const body={to:'claude',text:'marker?',request_id:'1',from:'claude'};
  assert.equal((await post('bad','/send',body)).status,401);
  const first=await post('a','/send',body);assert.equal(first.status,202);
  assert.equal(bridge.messages.get(first.body.message_id).from,'codex');
  assert.equal((await post('a','/send',body)).body.message_id,first.body.message_id);
  assert.equal((await post('a','/send',{...body,text:'different'})).status,409);
  const reply={message_id:first.body.message_id,text:'secret'};
  assert.equal((await post('a','/reply',reply)).status,400);
  assert.equal((await post('b','/reply',{...reply,message_id:'missing'})).status,400);
  const response=await post('b','/reply',reply);assert.equal(response.status,202);
  assert.equal((await post('b','/reply',reply)).body.message_id,response.body.message_id);
  assert.equal((await post('b','/reply',{...reply,text:'changed'})).status,409);
  assert.equal(delivered.length,1);assert.equal(delivered[0].to,'codex');
  assert.equal(delivered[0].in_reply_to,first.body.message_id);
  assert.equal(bridge.messages.get(first.body.message_id).state,'replied');
 } finally {await bridge.close();}
});

test('delivery failure is not reported as model receipt', async()=>{
 const bridge=await createBridge({tokens:{codex:'a',claude:'b'},deliverCodex:async()=>{throw new Error('queue unavailable');}});
 try {
  const r=await fetch(bridge.url+'/send',{method:'POST',headers:{authorization:'Bearer b'},body:JSON.stringify({to:'codex',text:'hello',request_id:'1'})});
  const {message_id}=await r.json();await new Promise(r=>setTimeout(r,10));
  assert.equal(bridge.messages.get(message_id).state,'delivery_unknown');
  assert.equal(bridge.events.some(e=>e.kind==='agent_replied'),false);
 }finally{await bridge.close();}
});

test('relay MCP tools route through HTTP and Claude receives the channel event', async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const {fileURLToPath}=await import('node:url');
 const delivered=[];
 const bridge=await createBridge({tokens:{codex:'a',claude:'b'},deliverCodex:async m=>{delivered.push(m);}});
 const clients=[];const notifications=[];
 try{
  for(const [member,token] of [['claude','b'],['codex','a']]){
   const client=new Client({name:'test-'+member,version:'1'});
   client.fallbackNotificationHandler=async n=>{notifications.push(n);};
   const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./relay.mjs',import.meta.url))],env:{...process.env,CORPUS_BRIDGE_URL:bridge.url,CORPUS_BRIDGE_TOKEN:token,CORPUS_BRIDGE_MEMBER:member}});
   await client.connect(transport);clients.push(client);
  }
  const [claude,codex]=clients;
  await claude.callTool({name:'ready',arguments:{}});
  const sent=await codex.callTool({name:'send_message',arguments:{to:'claude',text:'question',request_id:'mcp-1'}});
  const id=JSON.parse(sent.content[0].text).message_id;
  const end=Date.now()+3000;
  while(!notifications.some(n=>n.params?.meta?.message_id===id)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
  assert.ok(notifications.some(n=>n.method==='notifications/claude/channel'&&n.params.meta.message_id===id&&n.params.content==='question'));
  await claude.callTool({name:'reply_message',arguments:{message_id:id,text:'answer'}});
  assert.equal(delivered.length,1);assert.equal(delivered[0].text,'answer');assert.equal(delivered[0].in_reply_to,id);
 }finally{await Promise.all(clients.map(c=>c.close()));await bridge.close();}
});
