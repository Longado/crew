import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Model-free native protocol fixture, not evidence of a subscription session. */
export function codexTeamFixture(options: { failStartup?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'crew-native-fixture-')), log = join(directory, 'rpc.jsonl'), executable = join(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}
import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
const argv=process.argv.slice(2);if(argv[0]==='mcp'){console.log('[]');process.exit(0)}
const record=m=>appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');record({argv});
if(${!!options.failStartup}){process.stderr.write('x'.repeat(5000)+'\\nFixture config rejected; api_key=sk-test-123456789012345678901234567890\\n');process.exit(7)}
const send=m=>console.log(JSON.stringify(m));const notify=(method,params)=>send({method,params});
const thread=id=>({id,parentThreadId:id==='root'?null:'root',agentNickname:id==='worker'?'Checker':null,turns:id==='worker'?[{id:'worker-turn',status:'inProgress'}]:[]});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);record(m);if(!m.method)return;
let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'pro'}};
if(m.method==='thread/start'||m.method==='thread/resume'){const p=m.params;result={thread:thread(m.method==='thread/start'?'root':p.threadId),cwd:p.cwd,approvalPolicy:p.approvalPolicy,approvalsReviewer:p.approvalsReviewer,sandbox:{type:p.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false,writableRoots:[],excludeSlashTmp:true,excludeTmpdirEnvVar:true}}}
if(m.method==='turn/start'){result={turn:{id:'root-turn'}};notify('turn/started',{threadId:'root',turn:{id:'root-turn',status:'inProgress'}})}
send({id:m.id,result});
if(m.method==='turn/start'){notify('item/completed',{threadId:'root',turnId:'root-turn',item:{id:'text',type:'agentMessage',text:'Native fixture connected; no model called.'}});notify('thread/started',{thread:thread('worker')})}
if(m.method==='thread/resume')setTimeout(()=>{send({id:500,method:'item/tool/requestUserInput',params:{threadId:'worker',turnId:'worker-turn',questions:[{id:'note',header:'Private fixture note',question:'Enter a temporary test note',isSecret:true}]}});send({id:501,method:'item/commandExecution/requestApproval',params:{threadId:'worker',turnId:'worker-turn',itemId:'command',command:'fixture-only check',cwd:m.params.cwd}})},30);
if(m.method==='turn/interrupt')setTimeout(()=>notify('turn/completed',{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted'}}),50);
});
`); chmodSync(executable, 0o700);
  return { directory, log, executable };
}
