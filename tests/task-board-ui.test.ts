import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A small DOM port tests interaction logic without operating the user's browser.
class Element {
  listeners: Record<string, Function> = {}; html = ''; writes = 0; textContent = ''; value = ''; disabled = false; hidden = false; open = false; checked = false; href = ''; dataset: Record<string, string> = {}; attributes: Record<string,string> = {};
  isConnected = true; onHTML?: (value: string)=>void; onFocus?: (element: Element)=>void;
  get innerHTML() { return this.html; } set innerHTML(value: string) { this.html=value; this.writes++; this.onHTML?.(value); }
  classes = new Set<string>();
  classList = { toggle: (name: string, enabled: boolean) => { enabled?this.classes.add(name):this.classes.delete(name); }, add: (name: string) => { this.classes.add(name); }, remove: (name: string) => { this.classes.delete(name); } };
  style: Record<string,string> = {}; setPointerCapture() {} remove() {}
  closest(_query: string): Element|null { return null; }
  focus() { if (this.isConnected) this.onFocus?.(this); }
  setAttribute(name: string,value: string) { this.attributes[name]=value; }
  getBoundingClientRect() { return {left:300,right:500,top:100,bottom:250}; }
  addEventListener(name: string, callback: Function) { this.listeners[name] = callback; }
  showModal() { this.open = true; } close() { this.open = false; } contains() { return false; }
}
async function fixture(options: {connected?: boolean} = {}) {
  const elements = new Map<string, Element>(), handlers: Record<string, Function> = {}, requests: {path: string; body: any}[] = []; let tick: Function, connected = options.connected ?? true, operationError = '', now = Date.parse('2026-10-02T10:00:00+08:00');
  const cards = new Map<string, Element>(), groups = new Map<string, Element[]>(); let activeElement: Element|null = null, taskContext: Element|null = null;
  const el = (id: string) => {
    if (!elements.has(id)) {
      const element = new Element(); element.onFocus = focused => { activeElement=focused; };
      if (['active','ready','waiting','finished'].includes(id)) element.onHTML = value => {
        for (const card of groups.get(id) || []) { card.isConnected=false; cards.delete(card.dataset.id); if (activeElement===card) activeElement=null; }
        const renderedCards = [...value.matchAll(/<article\b[^>]*\bdata-id="(\d+)"[^>]*>/g)].map(match=>{
          const card = new Element(); card.dataset.id=match[1]; card.onFocus=focused=>{activeElement=focused;}; card.closest=q=>q==='.card'?card:null;
          cards.set(card.dataset.id,card); return card;
        });
        groups.set(id,renderedCards);
      };
      if (id==='inspector') element.onHTML = value => {
        if (taskContext) taskContext.isConnected=false;
        taskContext=value.includes('<details class="task-context">')?new Element():null;
      };
      elements.set(id,element);
    }
    return elements.get(id)!;
  };
  const tasks = [
    {task_id: 1, sources:[3], line:'Safe <script>alert(1)</script>', title:'Audit', next:'Read actual results', acceptance:'Cite files', owner:'Claude', status:'todo', priority:'medium', eligible:true, cwd:'/fixture/project'},
    {task_id: 2, sources:[15,16], line:'Crew', title:'Check manifest', next:'Check', acceptance:'Two accepted members', owner:'Codex', status:'blocked', priority:'high', eligible:true, check_only:true, cwd:'/fixture/docs'},
    {task_id: 3, sources:[9], line:'Human playtest', title:'Play', next:'Play', owner:'Eddie', status:'todo', eligible:false, reason:'Human playtest', cwd:'/fixture/game'},
    {task_id: 4, sources:[20], line:'Finished task', title:'Organized', next:'Review', owner:'Codex', status:'done', eligible:false},
    {task_id: 5, sources:[19], line:'Active task', title:'Running', next:'Audit', owner:'Codex', status:'doing', eligible:false},
  ];
  const board = {tasks, jobs:[] as any[], crew_url:'http://127.0.0.1:4192'};
  const filters=['all','agent','human','done'].map(value=>{const button=el('filter-'+value);button.dataset.filter=value;return button;});
  const dockButtons=['detail','runs'].map(value=>{const button=el(value+'-tab');button.dataset.dockView=value;return button;});
  const document = {getElementById: el, querySelector:(q:string)=>{if(q==='#inspector .task-context')return taskContext;const match=q.match(/^\.card\[data-id="(\d+)"\]$/);return match?cards.get(match[1]) || null:el(q);}, get activeElement(){return activeElement;}, querySelectorAll:(q:string)=>q==='.tab'?filters:q==='[data-dock-view]'?dockButtons:q==='.job details[open]'?[...elements.values()].filter(e=>e.open&&e.dataset.job):[], addEventListener:(name:string,fn:Function)=>handlers[name]=fn, createElement:()=>new Element(),body:{appendChild(){}}};
  class Clock extends Date { constructor() { super(now); } static now() { return now; } toLocaleTimeString() { return super.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Taipei'}); } }
  vm.runInNewContext(readFileSync(new URL('../web/task-board.js', import.meta.url),'utf8'), {
    document, setInterval(fn: Function) { tick=fn; }, FormData: class { get() { return 'read-only'; } },
    fetch: async (path:string, options:any) => { if(options) requests.push({path,body:JSON.parse(options.body)}); return {ok:options?!operationError:connected,json:async()=>options&&operationError?{error:operationError}:board}; },
    Date: Clock, String, Number, console,
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {el,handlers,requests,tasks,board,card:(id:number)=>cards.get(String(id))!,context:()=>document.querySelector('#inspector .task-context'),activeElement:()=>document.activeElement,tick:()=>tick(),setConnected:(value:boolean)=>{connected=value;},setTime:(time:string)=>{now=Date.parse(`2026-10-02T${time}:00+08:00`);},setOperationError:(value:string)=>{operationError=value;}};
}
test('dragging a task opens concrete settings; only submit dispatches the chosen ID', async()=>{
  const f=await fixture();
  assert.match(f.el('ready').innerHTML,/Safe &lt;script&gt;/);
  assert.doesNotMatch(f.el('ready').innerHTML,/<script>alert/);
  const drop=f.el('dropzone');
  drop.listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '2'}});
  assert.equal(f.el('launch').open,true);
  assert.match(f.el('goal').value,/两位原生成员/);
  assert.equal(f.el('input[value="workspace-write"]').disabled,true);
  assert.equal(f.requests.length,0);
  f.el('notice').textContent='Earlier operation error';
  await f.el('launch-form').listeners.submit({preventDefault(){},target:{}});
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].path,'/api/dispatch');
  assert.equal(f.requests[0].body.task_id,2);
  assert.equal(f.requests[0].body.access,'read-only');
  assert.equal(f.el('launch').open,false);
  assert.equal(f.el('notice').textContent,'','successful submit still explicitly clears prior notices');
});
test('human tasks show their condition and never dispatch', async()=>{
  const f=await fixture();
  f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '3'}});
  assert.equal(f.el('launch').open,false);
  assert.match(f.el('inspector').innerHTML,/Human playtest/);
  assert.doesNotMatch(f.el('inspector').innerHTML,/data-detail-launch/);
  assert.equal(f.el('inspector').hidden,false);
  assert.equal(f.requests.length,0);
});
test('polling unchanged tasks preserves the card DOM for focus and dragging',async()=>{
  const f=await fixture(); const writes=f.el('ready').writes;
  await f.tick();
  assert.equal(f.el('ready').writes,writes);
});
test('pointer dragging opens settings on release over the zone and can be cancelled',async()=>{
  const f=await fixture(), card=new Element(); card.dataset.id='1';
  const target={closest:(q:string)=>q.startsWith('.card')?card:null};
  const event={button:0,target,pointerId:1,clientX:20,clientY:20,preventDefault(){}};
  f.handlers.pointerdown(event);
  f.handlers.pointermove({...event,clientX:340,clientY:140});
  assert.equal(f.el('launch').open,false);
  f.handlers.pointercancel({...event,clientX:340,clientY:140});
  assert.equal(f.el('launch').open,false);
  f.handlers.pointerdown(event);
  f.handlers.pointermove({...event,clientX:340,clientY:140});
  f.handlers.pointerup({...event,clientX:340,clientY:140});
  assert.equal(f.el('launch').open,true);
  assert.match(f.el('goal').value,/任务 #1/);
  assert.equal(f.requests.length,0);
});
test('selecting a row shows inline details without launching and keeps them through polling',async()=>{
  const f=await fixture(), card=new Element(); card.dataset.id='3';
  f.handlers.click({target:{closest:(q:string)=>q==='.card'?card:null}});
  assert.match(f.el('inspector').innerHTML,/任务 #3/);
  assert.match(f.el('waiting').innerHTML,/card selected/);
  assert.equal(f.el('launch').open,false);
  const writes=f.el('inspector').writes;
  await f.tick();
  assert.equal(f.el('inspector').writes,writes);
  assert.equal(f.requests.length,0);
});
test('details omit only empty context and exact duplicate waiting text while retaining required rows',async()=>{
  const f=await fixture(), task=f.tasks[2];
  Object.assign(task,{title:'  Human playtest\n',yesterday:' \n ',next:'  Play <chapter>\nKeep log  ',acceptance:'  Play <chapter>\nKeep log  ',reason:'Play <chapter>\nKeep log'});
  f.handlers.click({target:f.card(3)});
  const details=f.el('inspector').innerHTML;
  assert.match(details,/<div class="detail-row detail-step"><strong>下一步<\/strong>/);
  assert.match(details,/<div class="detail-row detail-secondary"><strong>交付条件<\/strong>/);
  assert.equal(details.split('Play &lt;chapter&gt;\nKeep log').length-1,2,'next and acceptance remain even when identical');
  assert.doesNotMatch(details,/<strong>等待条件<\/strong>|<strong>任务背景<\/strong>|<strong>昨日记录<\/strong>/);
  assert.match(details,/<details class="task-context"><summary>背景与记录<\/summary>/);
  for (const text of ['任务 #3','原编号 9','负责人 Eddie']) assert.ok(details.includes(text));
  assert.match(details,/需本人确认入口/);
  Object.assign(task,{title:'',yesterday:'',next:'',acceptance:'',reason:'',dependency:''});
  await f.tick();
  assert.match(f.el('inspector').innerHTML,/<strong>下一步<\/strong><p>尚未补充<\/p>/);
  assert.match(f.el('inspector').innerHTML,/<strong>交付条件<\/strong><p>尚未补充<\/p>/);
  assert.match(f.el('inspector').innerHTML,/<strong>等待条件<\/strong><p>尚未补充<\/p>/);
  assert.equal(f.requests.length,0);
});
test('distinct multiline detail content stays complete and escaped without changing execution instructions',async()=>{
  const f=await fixture();
  const content={title:'Human  playtest',yesterday:'Log <yesterday>\nKeep & compare',next:'Compare A\nB <next>',acceptance:'Pass <acceptance>\nC & D',reason:'Compare A B <next>',entry:'Local <entry>\nFollow & record'};
  Object.assign(f.tasks[2],content);
  f.handlers.click({target:f.card(3)});
  const details=f.el('inspector').innerHTML;
  assert.match(details,/<strong>下一步<\/strong><p>Compare A\nB &lt;next&gt;<\/p>/);
  assert.match(details,/<strong>交付条件<\/strong><p>Pass &lt;acceptance&gt;\nC &amp; D<\/p>/);
  assert.match(details,/<strong>等待条件<\/strong><p>Compare A B &lt;next&gt;<\/p>/);
  assert.match(details,/<strong>任务背景<\/strong><p>Human  playtest<\/p>/);
  assert.match(details,/<strong>昨日记录<\/strong><p>Log &lt;yesterday&gt;\nKeep &amp; compare<\/p>/);
  assert.match(details,/<div class="entry">Local &lt;entry&gt;\nFollow &amp; record<\/div>/);
  const agentTask=f.tasks[0]; Object.assign(agentTask,{title:content.title,next:content.next,acceptance:content.acceptance,entry:content.entry});
  f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  assert.ok(f.el('goal').value.includes(`本次目标：${content.next}\n交付条件：${content.acceptance}\n入口：${content.entry}`));
  assert.equal(agentTask.next,content.next);
  assert.equal(f.requests.length,0);
});
test('keyboard selection focuses the replacement row without dispatching or stealing mouse and form focus',async()=>{
  const f=await fixture();
  for (const [key,id] of [['Enter',3],[' ',2]] as const) {
    const before=f.card(id); before.focus(); let prevented=false;
    f.handlers.keydown({key,target:before,preventDefault(){prevented=true;}});
    assert.equal(prevented,true);
    assert.equal(before.isConnected,false,'the selected group was rerendered');
    assert.notEqual(f.card(id),before);
    assert.equal(f.activeElement(),f.card(id),'focus follows the newly rendered numeric task row');
    assert.match(f.el('inspector').innerHTML,new RegExp(`任务 #${id}`));
    assert.equal(f.el('launch').open,false);
    await f.tick();
    assert.equal(f.activeElement(),f.card(id),'unchanged polling keeps row focus');
  }
  const search=f.el('search'); search.focus();
  f.handlers.click({target:f.card(1)});
  assert.equal(f.activeElement(),search,'mouse selection does not steal another control focus');
  for (const native of ['button','a','input','textarea']) {
    const control=f.el('native-'+native); control.focus(); const target={closest:(q:string)=>q==='button,a,input,textarea'?control:q==='.card'?f.card(2):null};
    for (const key of ['Enter',' ']) f.handlers.keydown({key,target,preventDefault(){throw new Error('native control keystrokes must not be handled');}});
    assert.equal(f.activeElement(),control);
    assert.match(f.el('inspector').innerHTML,/任务 #1/);
  }
  assert.equal(f.el('launch').open,false);
  assert.equal(f.requests.length,0);
});
test('ended filter reveals completed tasks while hiding unrelated groups',async()=>{
  const f=await fixture(), button=f.el('filter-done');
  f.handlers.click({target:{closest:(q:string)=>q==='[data-filter]'?button:null}});
  assert.equal(button.attributes['aria-pressed'],'true');
  assert.match(f.el('finished').innerHTML,/Finished task/);
  assert.equal(f.el('archive').hidden,false);
  assert.equal(f.el('archive').open,true);
  assert.equal(f.el('ready-group').hidden,true);
  assert.equal(f.el('waiting-group').hidden,true);
  assert.equal(f.el('active-group').hidden,true);
});
test('running task stays visible and execution tabs switch without losing the selected task',async()=>{
  const f=await fixture(), button=f.el('runs-tab');
  assert.match(f.el('active').innerHTML,/Active task/);
  assert.equal(f.el('active-group').hidden,false);
  f.handlers.click({target:{closest:(q:string)=>q==='[data-dock-view]'?button:null}});
  assert.equal(f.el('jobs').hidden,false);
  assert.equal(f.el('inspector').hidden,true);
  assert.equal(button.attributes['aria-selected'],'true');
  await f.tick();
  assert.equal(f.el('jobs').hidden,false);
  assert.match(f.el('inspector').innerHTML,/任务 #1/);
  f.board.jobs.push(
    {id:'completed-run',task_id:1,title:'Previous audit',access:'read-only',created_at:'2026-10-02T10:00:00',state:'completed',label:'Audit finished',crew_link:'/crew/finished',snapshot:{agents:[{name:'Member A',state:'completed',output:'Actual result'}]}},
    {id:'current-run',task_id:2,title:'Current audit',access:'read-only',created_at:'2026-10-02T11:00:00',state:'waiting',label:'Waiting for your answer',crew_link:'/crew/current',snapshot:{error:'Action required'}},
  );
  await f.tick();
  assert.match(f.el('jobs').innerHTML,/<details class="job-history" data-job="completed-run"[^>]*>[\s\S]*Member A/);
  const live=f.el('jobs').innerHTML.split('<article class="job')[1];
  assert.match(live,/Waiting for your answer/);
  assert.match(live,/Action required/);
  assert.match(live,/href="\/crew\/current"/);
  assert.match(live,/data-stop="current-run"/);
  const history=f.el('completed-details'); history.dataset.job='completed-run'; history.open=true;
  await f.tick();
  assert.match(f.el('jobs').innerHTML,/data-job="completed-run" open/);
  const jobWrites=f.el('jobs').writes;
  await f.tick();
  assert.equal(f.el('jobs').writes,jobWrites);
  assert.equal(f.requests.length,0);
});
test('connection failure preserves tasks and recovery clears the connection notice',async()=>{
  const f=await fixture(), ready=f.el('ready').innerHTML;
  f.setConnected(false);
  await f.tick();
  assert.equal(f.el('connection-text').textContent,'连接中断');
  assert.match(f.el('notice').textContent,/无法连接/);
  assert.equal(f.el('ready').innerHTML,ready);
  f.setConnected(true);
  await f.tick();
  assert.equal(f.el('connection-text').textContent,'本地已连接');
  assert.equal(f.el('notice').textContent,'');
  assert.equal(f.requests.length,0);
});
test('launch shows current requirements with folded instructions and read-only default without dispatching',async()=>{
  const f=await fixture();
  f.tasks[0].acceptance='Cite actual files\nInclude remaining validation';
  f.el('launch-instructions').open=true;
  f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  assert.equal(f.el('launch-next').textContent,f.tasks[0].next);
  assert.equal(f.el('launch-acceptance').textContent,f.tasks[0].acceptance);
  assert.equal(f.el('launch-instructions').open,false);
  assert.equal(f.el('input[value="read-only"]').checked,true);
  assert.equal(Boolean(f.el('input[value="workspace-write"]').disabled),false);
  assert.match(f.el('launch-path').textContent,/\/fixture\/project/);
  assert.equal(f.requests.length,0);
});
test('folded execution instructions submit the full generated goal and preserve edits',async()=>{
  const page=readFileSync(new URL('../web/task-board.html', import.meta.url),'utf8');
  const instructions=page.match(/<details[^>]*id="launch-instructions"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(instructions,'complete goal remains editable inside folded instructions');
  assert.doesNotMatch(instructions[0].split('>')[0],/\bopen\b/);
  assert.match(instructions[1],/<textarea id="goal" maxlength="2800" rows="6" required>/);
  const f=await fixture(), drop=f.el('dropzone');
  drop.listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '2'}});
  const original=f.el('goal').value;
  assert.match(original,/crew_plan_tasks/);
  assert.match(original,/不得写文件、联网或申请扩大权限/);
  assert.equal(f.el('launch-instructions').open,false);
  await f.el('launch-form').listeners.submit({preventDefault(){},target:{}});
  assert.equal(f.requests[0].body.goal,original);
  drop.listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  f.el('launch-instructions').open=true;
  const edited='Task #1: inspect the actual files\nReturn all findings and exact paths.\nDo not change files.';
  f.el('goal').value=edited;
  f.el('launch-instructions').open=false;
  assert.equal(f.requests.length,1);
  await f.el('launch-form').listeners.submit({preventDefault(){},target:{}});
  assert.equal(f.requests[1].body.goal,edited);
  assert.equal(f.requests[1].body.task_id,1);
});
test('invalid folded goal reveals the editable instructions without dispatching',async()=>{
  const f=await fixture();
  f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  f.el('goal').value='';
  f.el('launch-instructions').open=false;
  assert.equal(typeof f.el('goal').listeners.invalid,'function');
  f.el('goal').listeners.invalid({});
  assert.equal(f.el('launch-instructions').open,true);
  assert.equal(f.el('launch').open,true);
  assert.equal(f.requests.length,0);
});
test('filters keep details on a visible row and empty searches clear the execution action',async()=>{
  const f=await fixture(), button=f.el('filter-human');
  f.handlers.click({target:{closest:(q:string)=>q==='[data-filter]'?button:null}});
  assert.match(f.el('inspector').innerHTML,/任务 #3/);
  assert.match(f.el('waiting').innerHTML,/card selected/);
  assert.doesNotMatch(f.el('inspector').innerHTML,/data-detail-launch/);
  assert.equal(f.el('task-panel').attributes['data-view'],'human');
  f.el('search').value='no matching task';
  f.el('search').listeners.input({});
  assert.equal(f.el('empty-list').hidden,false);
  assert.doesNotMatch(f.el('inspector').innerHTML,/data-detail-launch|任务 #/);
  await f.tick();
  assert.doesNotMatch(f.el('inspector').innerHTML,/data-detail-launch|任务 #/);
  f.el('search').value='';
  f.el('search').listeners.input({});
  assert.match(f.el('inspector').innerHTML,/任务 #3/);
  assert.equal(f.requests.length,0);
});
test('number searches match exact task IDs and both source numbers of a merged task',async()=>{
  const f=await fixture();
  f.tasks[0].task_id=219; f.tasks[0].sources=[1]; f.tasks[0].next='Compare step 16';
  f.tasks[1].task_id=231; f.tasks[1].sources=[15,16];
  for (const query of ['15','16','#231']) {
    f.el('search').value=query; f.el('search').listeners.input({});
    assert.match(f.el('ready').innerHTML,/Check manifest|Crew/);
    assert.doesNotMatch(f.el('ready').innerHTML,/Safe/);
    assert.match(f.el('inspector').innerHTML,/任务 #231/);
  }
  f.el('search').value='219'; f.el('search').listeners.input({});
  assert.match(f.el('inspector').innerHTML,/任务 #219/);
  assert.equal(f.requests.length,0);
});
test('rows use selection for details and retain an explicit action only for eligible tasks',async()=>{
  const f=await fixture();
  assert.doesNotMatch(f.el('waiting').innerHTML,/data-action="detail"/);
  assert.doesNotMatch(f.el('finished').innerHTML,/data-action=/);
  assert.match(f.el('ready').innerHTML,/data-action="launch"/);
  assert.match(f.el('ready').innerHTML,/aria-current="true"/);
  assert.equal(f.requests.length,0);
});
test('active runs disable new execution actions and completion restores them',async()=>{
  const f=await fixture();
  f.board.jobs.push({id:'active-run',task_id:2,title:'Audit in progress',access:'read-only',created_at:'2026-10-02T10:00:00',state:'running',label:'Running',crew_link:'/crew/active'});
  await f.tick();
  assert.match(f.el('ready').innerHTML,/data-action="launch"[^>]*disabled/);
  assert.match(f.el('inspector').innerHTML,/data-detail-launch="1"[^>]*disabled/);
  assert.equal(f.el('dropzone').attributes['aria-disabled'],'true');
  f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  assert.equal(f.el('launch').open,false);
  assert.equal(f.requests.length,0);
  f.board.jobs[0].state='completed'; await f.tick();
  assert.doesNotMatch(f.el('ready').innerHTML,/disabled/);
  assert.doesNotMatch(f.el('inspector').innerHTML,/disabled/);
  assert.equal(f.el('dropzone').attributes['aria-disabled'],'false');
  f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  assert.equal(f.el('launch').open,true);
  assert.equal(f.requests.length,0);
});
test('touch scrolling over a task never starts a drag or opens execution settings',async()=>{
  const f=await fixture(), card=new Element(); card.dataset.id='1';
  const target={closest:(q:string)=>q.startsWith('.card')?card:null};
  const event={button:0,pointerType:'touch',target,pointerId:2,clientX:20,clientY:20,preventDefault(){throw new Error('touch scroll must not be prevented');}};
  f.handlers.pointerdown(event);
  f.handlers.pointermove({...event,clientX:340,clientY:140});
  f.handlers.pointerup({...event,clientX:340,clientY:140});
  assert.equal(f.el('launch').open,false);
  assert.equal(f.requests.length,0);
});
test('expanded task context survives content and busy polling while unchanged polling keeps its DOM',async()=>{
  const f=await fixture(), original=f.context()!, writes=f.el('inspector').writes;
  assert.equal(original.open,false);
  original.open=true;
  await f.tick();
  assert.equal(f.context(),original);
  assert.equal(f.el('inspector').writes,writes);
  f.tasks[0].next='Read the updated results';
  await f.tick();
  assert.equal(original.isConnected,false,'changed inspector HTML detaches the old context');
  assert.notEqual(f.context(),original);
  assert.equal(f.context()!.open,true);
  const updated=f.context()!;
  f.board.jobs.push({id:'busy-run',task_id:2,title:'Audit',access:'read-only',created_at:'2026-10-02T10:00:00',state:'running',label:'Running',crew_link:'/crew/busy'});
  await f.tick();
  assert.equal(updated.isConnected,false,'busy action changes rebuild the inspector');
  assert.equal(f.context()!.open,true);
  assert.match(f.el('inspector').innerHTML,/data-detail-launch="1"[^>]*disabled/);
  f.board.jobs[0].state='completed';
  await f.tick();
  assert.equal(f.context()!.open,true);
  assert.doesNotMatch(f.el('inspector').innerHTML,/disabled/);
  assert.equal(f.requests.length,0);
});
test('task context survives detail and runs switches but resets for different or absent tasks',async()=>{
  const f=await fixture(), original=f.context()!;
  original.open=true;
  const switchView=(view:string)=>f.handlers.click({target:{closest:(q:string)=>q==='[data-dock-view]'?f.el(view+'-tab'):null}});
  switchView('runs');
  assert.equal(f.el('inspector').hidden,true);
  assert.equal(f.context(),original);
  Object.assign(f.tasks[0],{yesterday:'A newer record'});
  await f.tick();
  assert.equal(original.isConnected,false);
  assert.equal(f.context()!.open,true);
  const hiddenContext=f.context();
  switchView('detail');
  assert.equal(f.el('inspector').hidden,false);
  assert.equal(f.context(),hiddenContext);
  assert.equal(f.context()!.open,true);
  f.handlers.click({target:f.card(3)});
  assert.equal(f.context()!.open,false);
  f.context()!.open=true;
  f.handlers.click({target:f.card(1)});
  assert.equal(f.context()!.open,false,'returning to a task does not restore cross-task memory');
  f.context()!.open=true;
  const beforeEmpty=f.context()!;
  f.el('search').value='no matching task'; f.el('search').listeners.input({});
  assert.equal(beforeEmpty.isConnected,false);
  assert.equal(f.context(),null);
  f.el('search').value=''; f.el('search').listeners.input({});
  assert.equal(f.context()!.open,false);
  assert.equal(f.requests.length,0);
});
test('sync footer advances only after successful refresh and survives local interactions while disconnected',async()=>{
  const f=await fixture(), initialSync=f.el('synced').textContent;
  f.setTime('10:01');
  f.el('search').value='Safe'; f.el('search').listeners.input({});
  assert.equal(f.el('synced').textContent,initialSync,'local rendering must not advance the sync time');
  assert.equal(initialSync,'已同步 · 10:00');
  f.setConnected(false); await f.tick();
  const disconnected='连接中断 · 上次同步 10:00';
  assert.equal(f.el('synced').textContent,disconnected);
  assert.equal(f.el('connection-text').textContent,'连接中断');
  assert.equal(f.el('connection').classes.has('disconnected'),true);
  f.setTime('10:02');
  f.el('search').value=''; f.el('search').listeners.input({});
  assert.equal(f.el('synced').textContent,disconnected);
  f.handlers.click({target:{closest:(q:string)=>q==='[data-filter]'?f.el('filter-human'):null}});
  assert.equal(f.el('synced').textContent,disconnected);
  f.handlers.click({target:f.card(3)});
  assert.equal(f.el('synced').textContent,disconnected);
  assert.equal(f.el('connection-text').textContent,'连接中断');
  f.setConnected(true); await f.tick();
  assert.equal(f.el('synced').textContent,'已同步 · 10:02');
  assert.equal(f.el('connection-text').textContent,'本地已连接');
  assert.equal(f.el('connection').classes.has('disconnected'),false);
  assert.equal(f.el('notice').textContent,'');
  assert.equal(f.requests.length,0);
});
test('first refresh failure reports that no sync has succeeded through local rendering',async()=>{
  const f=await fixture({connected:false});
  assert.equal(f.el('synced').textContent,'连接中断 · 尚未同步');
  f.setTime('10:03'); f.el('search').listeners.input({});
  assert.equal(f.el('synced').textContent,'连接中断 · 尚未同步');
  f.setConnected(true); await f.tick();
  assert.equal(f.el('synced').textContent,'已同步 · 10:03');
  assert.equal(f.el('notice').textContent,'');
  assert.equal(f.requests.length,0);
});
test('operation errors survive refresh failure, recovery and busy launch interception',async()=>{
  const f=await fixture(), stop=new Element(); stop.dataset.stop='active-run';
  f.board.jobs.push({id:'active-run',task_id:2,title:'Audit',access:'read-only',created_at:'2026-10-02T10:00:00',state:'running',label:'Running',crew_link:'/crew/active'});
  await f.tick();
  f.setOperationError('Stop request rejected by API');
  f.handlers.click({target:{closest:(q:string)=>q==='[data-stop]'?stop:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.el('notice').textContent,'Stop request rejected by API');
  assert.equal(stop.disabled,false);
  f.setConnected(false); await f.tick();
  assert.equal(f.el('notice').textContent,'Stop request rejected by API');
  assert.equal(f.el('connection-text').textContent,'连接中断');
  f.setConnected(true); await f.tick();
  assert.equal(f.el('notice').textContent,'Stop request rejected by API');
  f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  assert.equal(f.el('notice').textContent,'Stop request rejected by API');
  assert.equal(f.el('launch').open,false);
  f.board.jobs[0].state='completed'; await f.tick();
  assert.equal(f.el('notice').textContent,'Stop request rejected by API');
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].path,'/api/stop');
});
test('busy notice clears only its own message after the run ends',async()=>{
  const f=await fixture(), busyNotice='已有任务运行中，请在运行记录查看进度，结束后再启动。';
  f.board.jobs.push({id:'active-run',task_id:2,title:'Audit',access:'read-only',created_at:'2026-10-02T10:00:00',state:'running',label:'Running',crew_link:'/crew/active'});
  await f.tick();
  const attempt=()=>f.el('dropzone').listeners.drop({preventDefault(){},dataTransfer:{getData:()=> '1'}});
  attempt(); assert.equal(f.el('notice').textContent,busyNotice);
  await f.tick(); assert.equal(f.el('notice').textContent,busyNotice);
  f.board.jobs[0].state='completed'; await f.tick();
  assert.equal(f.el('notice').textContent,'');
  f.board.jobs[0].state='running'; await f.tick();
  f.el('notice').textContent=busyNotice+' Please inspect the receipt.';
  attempt();
  assert.equal(f.el('notice').textContent,busyNotice+' Please inspect the receipt.');
  f.board.jobs[0].state='completed'; await f.tick();
  assert.equal(f.el('notice').textContent,busyNotice+' Please inspect the receipt.');
  f.el('notice').textContent=''; f.board.jobs[0].state='running'; await f.tick(); attempt();
  f.setConnected(false); await f.tick();
  assert.equal(f.el('notice').textContent,'暂时无法连接任务看板，恢复后会继续同步。');
  f.setConnected(true); await f.tick();
  assert.equal(f.el('notice').textContent,'');
  assert.equal(f.el('launch').open,false);
  assert.equal(f.requests.length,0);
});
test('completed run shows one escaped summary before collapsed history without completing its task',async()=>{
  const f=await fixture();
  f.board.jobs.push({id:'completed-run',task_id:1,title:'Previous audit',access:'read-only',created_at:'2026-10-02T10:00:00',state:'completed',label:'Audit <finished> & checked',crew_link:'/crew/finished',snapshot:{agents:[{name:'Member A',state:'completed',output:'Actual result'}],nativeTasks:[{state:'accepted'},{state:'pending'}]}});
  await f.tick();
  const job=f.el('jobs').innerHTML, summary='<p class="label">Audit &lt;finished&gt; &amp; checked</p>', history=job.slice(job.indexOf('<details'));
  assert.equal(job.split(summary).length-1,1);
  assert.ok(job.indexOf(summary)<job.indexOf('<details'),'summary remains visible before folded history');
  assert.match(job,/<span class="status-badge completed">运行结束<\/span>/);
  assert.doesNotMatch(history,/Audit &lt;finished&gt;/);
  assert.match(history,/<details class="job-history" data-job="completed-run" ><summary>背景与回执<\/summary>/);
  assert.match(history,/<span>Member A<\/span><span>完成<\/span>/);
  assert.match(history,/负责人已验收 1 \/ 2 项/);
  assert.match(history,/Actual result/);
  assert.match(history,/href="\/crew\/finished"/);
  assert.match(history,/href="\/api\/receipt\/completed-run"/);
  assert.equal(f.tasks[0].status,'todo');
  assert.match(f.el('inspector').innerHTML,/<span class="status-badge todo">待办<\/span>/);
  assert.equal(f.requests.length,0);
});
test('blocked run keeps summary and error visible with task and member labels unchanged',async()=>{
  const f=await fixture();
  f.board.jobs.push({id:'blocked-run',task_id:2,title:'Audit needs help',access:'read-only',created_at:'2026-10-02T10:00:00',state:'blocked',label:'Needs <attention>',crew_link:'/crew/blocked',snapshot:{error:'Failed <step> & retry',agents:[{name:'Member B',state:'blocked',output:'Partial output'}]}});
  await f.tick(); f.handlers.click({target:f.card(2)});
  const job=f.el('jobs').innerHTML;
  assert.match(job,/<span class="status-badge blocked">需处理<\/span>/);
  assert.match(job,/<p class="label">Needs &lt;attention&gt;<\/p>/);
  assert.equal(job.split('Needs &lt;attention&gt;').length-1,1);
  assert.match(job,/<p class="error">Failed &lt;step&gt; &amp; retry<\/p>/);
  assert.ok(job.indexOf('Needs &lt;attention&gt;')<job.indexOf('<details'));
  assert.ok(job.indexOf('Failed &lt;step&gt;')<job.indexOf('<details'));
  assert.doesNotMatch(job,/job-history/);
  assert.match(job,/<span>Member B<\/span><span>等待条件<\/span>/);
  assert.match(job,/Partial output/);
  assert.match(f.el('inspector').innerHTML,/<span class="status-badge blocked">等待条件<\/span>/);
  assert.equal(f.requests.length,0);
});
test('waiting run retains visible summary, Crew link and stop while empty labels add no paragraph',async()=>{
  const f=await fixture();
  f.board.jobs.push({id:'waiting-run',task_id:2,title:'Current audit',access:'read-only',created_at:'2026-10-02T10:00:00',state:'waiting',label:'Waiting for an answer',crew_link:'/crew/waiting',snapshot:{agents:[{name:'Member A',state:'waiting',output:'Question'}]}});
  await f.tick();
  const job=f.el('jobs').innerHTML;
  assert.match(job,/<span class="status-badge waiting">待处理<\/span>/);
  assert.equal(job.split('Waiting for an answer').length-1,1);
  assert.ok(job.indexOf('Waiting for an answer')<job.indexOf('<details'));
  assert.ok(job.indexOf('href="/crew/waiting"')>job.indexOf('</details>'));
  assert.ok(job.indexOf('data-stop="waiting-run"')>job.indexOf('</details>'));
  assert.match(job,/<span>Member A<\/span><span>待处理<\/span>/);
  f.board.jobs[0].label=''; await f.tick();
  assert.doesNotMatch(f.el('jobs').innerHTML,/<p class="label">/);
  assert.match(f.el('jobs').innerHTML,/data-stop="waiting-run"/);
  assert.equal(f.requests.length,0);
});
test('search counts cover matching categories independently of the selected filter',async()=>{
  const f=await fixture(), counts=()=>['all-count','agent-count','human-count','ended-count'].map(id=>Number(f.el(id).textContent));
  const readyOrder=()=>[...f.el('ready').innerHTML.matchAll(/data-id="(\d+)"/g)].map(match=>match[1]), initialOrder=readyOrder();
  const choose=(filter:string)=>f.handlers.click({target:{closest:(q:string)=>q==='[data-filter]'?f.el('filter-'+filter):null}});
  assert.deepEqual(counts(),[5,2,1,1]);
  for (const task of f.tasks.slice(0,4)) task.title='Match '+task.title;
  f.el('search').value='  MaTch  '; f.el('search').listeners.input({});
  assert.deepEqual(counts(),[4,2,1,1]);
  assert.match(f.el('inspector').innerHTML,/任务 #1/,'visible selected task stays selected');
  assert.deepEqual(readyOrder(),initialOrder,'search preserves the existing ready-row ordering');
  choose('human');
  assert.deepEqual(counts(),[4,2,1,1]);
  assert.match(f.el('inspector').innerHTML,/任务 #3/);
  assert.equal(f.el('ready-group').hidden,true);
  choose('done');
  assert.deepEqual(counts(),[4,2,1,1]);
  assert.match(f.el('inspector').innerHTML,/任务 #4/);
  assert.equal(f.el('archive').open,true);
  choose('agent');
  assert.deepEqual(counts(),[4,2,1,1]);
  assert.match(f.el('inspector').innerHTML,new RegExp(`任务 #${initialOrder[0]}`));
  f.el('search').value=''; f.el('search').listeners.input({});
  assert.deepEqual(counts(),[5,2,1,1]);
  assert.match(f.el('inspector').innerHTML,new RegExp(`任务 #${initialOrder[0]}`));
  assert.equal(f.el('launch').open,false);
  assert.equal(f.requests.length,0);
});
test('unmatched searches zero all category counts and clearing restores counts for every category',async()=>{
  const f=await fixture(), counts=()=>['all-count','agent-count','human-count','ended-count'].map(id=>Number(f.el(id).textContent));
  f.el('search').value='no matching task'; f.el('search').listeners.input({});
  assert.deepEqual(counts(),[0,0,0,0]);
  assert.equal(f.el('empty-list').hidden,false);
  assert.equal(f.context(),null);
  f.handlers.click({target:{closest:(q:string)=>q==='[data-filter]'?f.el('filter-done'):null}});
  assert.deepEqual(counts(),[0,0,0,0]);
  assert.doesNotMatch(f.el('inspector').innerHTML,/任务 #|data-detail-launch/);
  f.el('search').value=''; f.el('search').listeners.input({});
  assert.deepEqual(counts(),[5,2,1,1]);
  assert.equal(f.el('empty-list').hidden,true);
  assert.match(f.el('inspector').innerHTML,/任务 #4/);
  assert.equal(f.el('launch').open,false);
  assert.equal(f.requests.length,0);
});
test('exact task and merged source searches count each matching task once',async()=>{
  const f=await fixture(), counts=()=>['all-count','agent-count','human-count','ended-count'].map(id=>Number(f.el(id).textContent));
  f.tasks[0].task_id=219; f.tasks[0].sources=[1]; f.tasks[0].next='Compare step 16';
  f.tasks[1].task_id=231; f.tasks[1].sources=[15,16];
  for (const query of ['15','16','#231']) {
    f.el('search').value=query; f.el('search').listeners.input({});
    assert.deepEqual(counts(),[1,1,0,0]);
    assert.match(f.el('inspector').innerHTML,/任务 #231/);
    assert.doesNotMatch(f.el('ready').innerHTML,/data-id="219"/);
  }
  f.handlers.click({target:{closest:(q:string)=>q==='[data-filter]'?f.el('filter-human'):null}});
  assert.deepEqual(counts(),[1,1,0,0]);
  assert.equal(f.el('empty-list').hidden,false);
  f.handlers.click({target:{closest:(q:string)=>q==='[data-filter]'?f.el('filter-all'):null}});
  for (const query of ['219','1']) {
    f.el('search').value=query; f.el('search').listeners.input({});
    assert.deepEqual(counts(),[1,1,0,0]);
    assert.match(f.el('inspector').innerHTML,/任务 #219/);
  }
  f.el('search').value='9'; f.el('search').listeners.input({});
  assert.deepEqual(counts(),[1,0,1,0]);
  assert.match(f.el('inspector').innerHTML,/任务 #3/);
  assert.equal(f.el('launch').open,false);
  assert.equal(f.requests.length,0);
});
test('cross-day runs show source month and day without changing datetime, order or history',async()=>{
  const f=await fixture(), latest='2026-10-02T23:45:00+14:00', earlier='2026-09-30T23:45:00-05:00';
  f.board.jobs.push(
    {id:'october-run',task_id:1,title:'October audit',access:'workspace-write',created_at:latest,state:'completed',label:'Latest result',crew_link:'/crew/october'},
    {id:'september-run',task_id:1,title:'September audit',access:'read-only',created_at:earlier,state:'completed',label:'Earlier <result>',crew_link:'/crew/september'},
  );
  await f.tick();
  const jobs=f.el('jobs').innerHTML;
  assert.match(jobs,/<time datetime="2026-09-30T23:45:00-05:00">09-30 23:45<\/time><span>只读<\/span>/);
  assert.match(jobs,/<time datetime="2026-10-02T23:45:00\+14:00">10-02 23:45<\/time><span>隔离修改<\/span>/);
  assert.ok(jobs.indexOf('September audit')<jobs.indexOf('October audit'),'existing reverse input order is retained');
  assert.deepEqual(f.board.jobs.map(job=>job.created_at),[latest,earlier],'rendering leaves source dates and input order intact');
  assert.equal(jobs.split('<span class="status-badge completed">运行结束</span>').length-1,2);
  for (const [id,label] of [['september-run','Earlier &lt;result&gt;'],['october-run','Latest result']]) {
    const summary=`<p class="label">${label}</p>`, history=`<details class="job-history" data-job="${id}" >`;
    assert.equal(jobs.split(summary).length-1,1);
    assert.ok(jobs.indexOf(summary)<jobs.indexOf(history),'summary stays above its collapsed history');
    assert.ok(jobs.includes(history));
    assert.ok(jobs.includes(`href="/api/receipt/${id}"`));
  }
  f.setTime('11:45'); await f.tick();
  assert.equal(f.el('jobs').innerHTML,jobs,'record dates do not follow the refresh clock');
  assert.equal(f.el('synced').textContent,'已同步 · 11:45');
  assert.equal(f.requests.length,0);
});
