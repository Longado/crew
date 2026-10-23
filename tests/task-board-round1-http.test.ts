import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const python = String.raw`
import importlib.util,json,pathlib,sys,threading,urllib.request
source,root,manifest,crew,job_id,mode=sys.argv[1:]
spec=importlib.util.spec_from_file_location('round1_board',source)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
store=module.BoardStore(root,manifest)
runner=module.Runner(store,crew)
assert store.status(1)['jobs'][-1]['state']=='recovery_required'
server=module.ThreadingHTTPServer(('127.0.0.1',0),module.handler(runner,pathlib.Path(root)))
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
base='http://127.0.0.1:'+str(server.server_port)
def request(path,payload=None):
    req=urllib.request.Request(base+path,data=json.dumps(payload).encode() if payload else None,headers={'Content-Type':'application/json','x-corpus':'1'})
    with urllib.request.urlopen(req,timeout=10) as response:return json.load(response)
try:
    board=request('/api/board')
    assert board['jobs'][-1]['state']=='recovery_required'
    result=request('/api/reconcile',{'job_id':job_id})
    if mode=='live-stop':
        assert result['outcome']=='live' and result['job']['can_stop']
        assert store.get(1)['status']=='doing'
        stopped=request('/api/stop',{'job_id':job_id})
        assert stopped['ok'] and stopped['stop_requested'] and stopped['stopped']
        result=request('/api/reconcile',{'job_id':job_id})
        assert result['outcome']=='finished'
        assert store.get(1)['status']=='todo'
    elif mode=='unreachable':
        assert result['outcome']=='unresolved'
        assert result['job']['state']=='recovery_required' and not result['job']['can_stop']
        assert store.get(1)['status']=='doing'
    else:
        assert result['outcome']=='finished' and store.get(1)['status']=='todo'
    board=request('/api/board')
    persisted=store.status(1)['jobs'][-1]
    assert board['jobs'][-1]['state']==persisted['state']
    print(json.dumps({'mode':mode,'outcome':result['outcome'],'job_state':persisted['state'],'task_status':store.get(1)['status']}))
finally:
    server.shutdown();server.server_close();thread.join(timeout=2)
`;

test('restarted Python board and real Crew HTTP agree on live stop, stale IDs, unreachable and ended recovery without models', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-round1-http-')));
  const db = openDb(':memory:');
  const env = {...process.env,CREW_HOME:join(root,'registry'),CORPUS_HOME:join(root,'unused-corpus'),PYTHONDONTWRITEBYTECODE:'1'};
  let starts = 0, closes = 0;
  const wb = createTeamWorkbench({ adapterFactory: () => ({
    async start(ctx) { starts++; ctx.onMember('codex', { connection:'ready', sessionId:'synthetic-root' }); return { setup:{ command:'', instructions:'' } }; },
    async deliver() {}, async close() { closes++; },
  }) });
  let server: ReturnType<typeof serve> | undefined;
  try {
    const cwd = join(root,'project'), manifest = join(root,'manifest.json');
    mkdirSync(cwd); mkdirSync(join(root,'.data'));
    const tasks = new DatabaseSync(join(root,'.data/tasks.db'));
    try {
      tasks.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,local_path TEXT);
        CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,notes TEXT);
        INSERT INTO projects VALUES(1,'project');
        INSERT INTO tasks VALUES(1,1,'Synthetic task','todo','medium','original history');`);
    } finally { tasks.close(); }
    writeFileSync(manifest,JSON.stringify({tasks:[{task_id:1,sources:[1],line:'Synthetic recovery',owner:'Codex',next:'Read',acceptance:'Check synthetic data'}]}));
    const projectId = db.createProject({ name:'Synthetic recovery', goal:null, dirs:[cwd] });
    server = serve(db,0,wb);
    await new Promise<void>(resolve => server!.once('listening',resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const first = await wb.start(projectId,{mode:'codex-team',cwd,goal:'Synthetic observation',access:'read-only'});
    const runs = join(root,'runs'); mkdirSync(runs);
    const record = (id:string,snapshot:unknown,at:string) => {
      const tasks = new DatabaseSync(join(root,'.data/tasks.db'));
      tasks.prepare("UPDATE tasks SET status='doing' WHERE id=1").run(); tasks.close();
      writeFileSync(join(runs,`${id}.json`),JSON.stringify({id,task_id:1,project_id:projectId,state:'running',snapshot,previous:'todo',access:'read-only',created_at:at,title:'Synthetic recovery'}));
    };
    const run = async (id:string,mode:string,crew=base) => {
      const result = await execute('python3',['-c',python,join(repo,'scripts/task-board/server.py'),root,manifest,crew,id,mode],{timeout:20_000,env});
      return JSON.parse(result.stdout);
    };
    record('20261001-210000-old',first,'2026-10-01T21:00:00');
    const stopped = await run('20261001-210000-old','live-stop');
    assert.equal(stopped.task_status,'todo'); assert.equal(starts,1); assert.equal(closes,1);
    const next = await wb.start(projectId,{mode:'codex-team',cwd,goal:'New synthetic observation',access:'read-only'});
    const stale = await fetch(base+'/api/team/stop',{method:'POST',headers:{'content-type':'application/json','x-corpus':'1'},body:JSON.stringify({projectId,runId:first.run!.id})});
    assert.equal(stale.status,409); assert.equal(wb.snapshot(projectId).run!.id,next.run!.id);
    assert.equal(wb.snapshot(projectId).status,'running'); assert.equal(closes,1);
    record('20261001-210001-new',next,'2026-10-01T21:00:01');
    const unresolved = await run('20261001-210001-new','unreachable','http://127.0.0.1:1');
    assert.equal(unresolved.task_status,'doing'); assert.equal(starts,2); assert.equal(closes,1);
    await wb.stop(projectId,next.run!.id);
    const ended = await run('20261001-210001-new','ended');
    assert.equal(ended.task_status,'todo'); assert.equal(starts,2); assert.equal(closes,2);
    const status = await execute(process.execPath,['--no-warnings',join(repo,'src/cli.ts'),'tasks','status','--task','1','--workspace',root,'--manifest',manifest],{env,timeout:10_000});
    const cli = JSON.parse(status.stdout);
    assert.equal(cli.task.status,'todo'); assert.ok(cli.jobs.every((job:any)=>job.state!=='recovery_required'));
  } finally {
    await wb.close();
    if (server) await new Promise<void>(resolve => server!.close(()=>resolve()));
    db.raw.close(); rmSync(root,{recursive:true,force:true});
  }
});
