import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.CORPUS_PROBE_DIR;
const token = process.env.CORPUS_PROBE_TOKEN;
if (!dir || !token) throw new Error('Missing probe configuration');
const log = value => appendFileSync(join(dir,'channel-events.jsonl'), JSON.stringify(value)+'\n');
const inbox = new Map();
const mcp = new Server({name:'corpus-probe',version:'0.0.1'},{
  capabilities:{experimental:{'claude/channel':{}},tools:{}},
  instructions:'This is a local communication test. Channel events include message_id. Reply using the reply tool with that exact message_id and the requested text. Do not use other tools.'
});
mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{
 name:'reply',description:'Return a reply for a received channel message.',
 inputSchema:{type:'object',properties:{message_id:{type:'string'},text:{type:'string'}},required:['message_id','text'],additionalProperties:false}
}]}));
mcp.setRequestHandler(CallToolRequestSchema,async req=>{
 const args=req.params.arguments;
 if(req.params.name!=='reply'||!args||typeof args.message_id!=='string'||typeof args.text!=='string'||!inbox.has(args.message_id)) return {isError:true,content:[{type:'text',text:'Unknown message or invalid reply'}]};
 log({kind:'reply',message_id:args.message_id,text:args.text});
 return {content:[{type:'text',text:'Reply recorded'}]};
});
const http=createServer(async(req,res)=>{
 if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
 if(req.method!=='POST'||req.url!=='/inbox'){res.writeHead(404).end();return;}
 try {
  let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error('too large');}
  const msg=JSON.parse(body);
  if(typeof msg.message_id!=='string'||typeof msg.content!=='string')throw Error('bad message');
  if(inbox.has(msg.message_id)){res.writeHead(409).end();return;}
  inbox.set(msg.message_id,msg);
  await mcp.notification({method:'notifications/claude/channel',params:{content:msg.content,meta:{message_id:msg.message_id}}});
  log({kind:'transport_written',message_id:msg.message_id});
  res.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify({state:'transport_written'}));
 }catch {res.writeHead(400).end();}
});
mcp.oninitialized=()=>{
 log({kind:'initialized'});
 http.listen(0,'127.0.0.1',()=>{
  writeFileSync(join(dir,'endpoint.json'),JSON.stringify({port:http.address().port}),{mode:0o600});
 });
};
mcp.onclose=()=>{http.close();process.exit(0);};
await mcp.connect(new StdioServerTransport());
