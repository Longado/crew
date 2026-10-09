import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexTeamProtocol } from '../src/bridge/codex-team.ts';
import type { NativeAgent, NativeTask } from '../src/bridge/types.ts';

function setup() {
  let agents: NativeAgent[] = [], tasks: NativeTask[] = [];
  const sent: any[] = [], attached: string[] = [];
  const protocol = createCodexTeamProtocol({ url: '', tokens: { codex: '', claude: '' }, run: { id: 'run', cwd: mkdtempSync(join(tmpdir(), 'crew-current-')), mode: 'codex-team', access: 'read-only', goal: 'Inspect' }, onMember() {}, onOutput() {}, onNativeState(a,t) { agents=a; tasks=t; } }, { send(m) { sent.push(m); }, response() {}, attach(id) { attached.push(id); } });
  const event = (method: string, params: any) => protocol.handle({ method, params });
  protocol.leader('root'); event('turn/started', { threadId: 'root', turn: { id: 'turn', status: 'inProgress' } });
  let id=1;
  const tool = (name: string, args: any) => { protocol.handle({ id:id++, method:'item/tool/call', params:{ threadId:'root', turnId:'turn', tool:name, arguments:args } }); return sent.at(-1); };
  return { protocol,event,tool,attached,get agents(){return agents;},get tasks(){return tasks;} };
}
test('current subAgentActivity discovers real threads and binds returned member names', () => {
  const f=setup(); f.tool('crew_plan_tasks',{tasks:[{id:'a',title:'Check',files:['README.md'],acceptance:['Quote content']}]});
  f.event('item/completed',{threadId:'root',turnId:'turn',item:{type:'subAgentActivity',id:'spawn',kind:'started',agentThreadId:'child',agentPath:'/root/member_a'}});
  assert.deepEqual(f.attached,['child']);
  assert.equal(f.tool('crew_assign_task',{taskId:'a',threadId:'member_a'}).result.success,true);
  assert.equal(f.tasks[0].threadId,'child');
  f.event('turn/started',{threadId:'child',turn:{id:'child-turn',status:'inProgress'}});
  f.event('item/completed',{threadId:'child',turnId:'child-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'README states scope.'}});
  f.event('turn/completed',{threadId:'child',turn:{id:'child-turn',status:'completed'}});
  assert.equal(f.tool('crew_review_task',{taskId:'a',decision:'accept',reason:'Read evidence'}).result.success,true);
  assert.equal(f.tasks[0].state,'accepted');
});
test('activity cannot adopt grandchildren or unknown aliases', () => {
  const f=setup(); f.tool('crew_plan_tasks',{tasks:[{id:'a',title:'Check',files:[],acceptance:['Report']}]});
  f.event('item/completed',{threadId:'root',item:{type:'subAgentActivity',id:'nested',kind:'started',agentThreadId:'outside',agentPath:'/root/worker/nested'}});
  assert.deepEqual(f.attached,[]);
  assert.equal(f.tool('crew_assign_task',{taskId:'a',threadId:'made_up'}).result.success,false);
});
