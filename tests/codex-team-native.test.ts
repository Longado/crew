import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexTeamAdapter } from '../src/bridge/codex-team-native.ts';
import type { AdapterContext } from '../src/bridge/types.ts';
import { codexTeamFixture } from './helpers/codex-team-fixture.ts';

test('native startup uses dedicated stdio, subscription guard, isolated policies and real tool contracts before turns', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-fake-codex-')), log = join(dir, 'rpc.jsonl'), executable = join(dir, 'codex');
  writeFileSync(executable, `#!${process.execPath}
import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
const args=process.argv.slice(2);if(args[0]==='mcp'){console.log(JSON.stringify([{name:'foreign',transport:{type:'stdio',command:'foreign-server'}}]));process.exit(0)}
appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:args})+'\\n');
function send(m){console.log(JSON.stringify(m))}
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(m.id===undefined)return;
let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'pro'}};
if(m.method==='thread/start'||m.method==='thread/resume'){const p=m.params;result={thread:{id:m.method==='thread/start'?'root':p.threadId,parentThreadId:m.method==='thread/start'?null:'root',turns:[]},cwd:p.cwd,approvalPolicy:p.approvalPolicy,approvalsReviewer:p.approvalsReviewer,sandbox:{type:p.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false,writableRoots:[],excludeSlashTmp:true,excludeTmpdirEnvVar:true}}}
if(m.method==='turn/start'){result={turn:{id:'turn'}};send({method:'turn/started',params:{threadId:m.params.threadId,turn:{id:'turn',status:'inProgress'}}})}
send({id:m.id,result})});
`); chmodSync(executable, 0o700);
  const originalPath = process.env.PATH; process.env.PATH = `${dir}:${originalPath}`;
  const adapter = createCodexTeamAdapter(), outputs: unknown[] = [], faults: string[] = [];
  const ctx: AdapterContext = { url: '', tokens: { codex: '', claude: '' }, run: { id: 'r', mode: 'codex-team', cwd: dir, goal: 'Inspect', access: 'read-only' }, onMember(id, p) { outputs.push([id, p]); }, onOutput() {}, onFault(m) { faults.push(m); } };
  try {
    await adapter.start(ctx);
    const records = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const start = records().find(m => m.method === 'thread/start');
    assert.equal(start.params.config.features.multi_agent, true); assert.equal(start.params.config.mcp_servers.foreign.enabled, false);
    assert.equal(start.params.config.approvals_reviewer, 'user'); assert.equal(start.params.config.agents.max_threads, 3);
    assert.equal(start.params.dynamicTools.length, 3); assert.match(start.params.developerInstructions, /文件职责/);
    assert.equal(records().some(m => m.method === 'turn/start'), false);
    await adapter.deliver({ id: 'goal', from: 'user', to: 'codex', text: 'Inspect', state: 'queued', createdAt: '' });
    await adapter.steer!('root', 'Supplement');
    const steer = records().find(m => m.method === 'turn/steer'); assert.equal(steer.params.expectedTurnId, 'turn');
    await assert.rejects(adapter.steer!('stranger', 'escape'), /unknown/);
    assert.equal(faults.length, 0); assert.ok(outputs.some((p: any) => p[1].connection === 'ready'));
  } finally { await adapter.close(); process.env.PATH = originalPath; }
});

test('native startup preserves a bounded, redacted diagnostic and exit code before any model turn', async () => {
  const f = codexTeamFixture({ failStartup: true }), originalPath = process.env.PATH;
  process.env.PATH = `${f.directory}:${originalPath}`;
  const adapter = createCodexTeamAdapter();
  try {
    await assert.rejects(adapter.start({ url: '', tokens: { codex: '', claude: '' }, run: { id: 'r', mode: 'codex-team', cwd: f.directory, goal: 'Inspect', access: 'read-only' }, onMember() {}, onOutput() {} }), error => {
      const text = String(error); assert.match(text, /exit 7/); assert.match(text, /Fixture config rejected/); assert.match(text, /已隐藏的凭证/);
      assert.equal(text.includes('sk-test-123456789012345678901234567890'), false); assert.ok(text.length < 4300); return true;
    });
    assert.equal(readFileSync(f.log, 'utf8').includes('turn/start'), false);
  } finally { await adapter.close(); process.env.PATH = originalPath; }
});
