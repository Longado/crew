import unittest, tempfile, pathlib, sqlite3, json, importlib.util, threading, time
import io, sys, subprocess
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('board_server', pathlib.Path(__file__).with_name('server.py'))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class BoardTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name); (self.root/'.data').mkdir(); (self.root/'project').mkdir()
        with closing(sqlite3.connect(self.root/'.data/tasks.db')) as db:
            db.executescript('CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,local_path TEXT); CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,notes TEXT); INSERT INTO projects VALUES(1,"Test","project");')
            for n,s in [(1,'todo'),(2,'blocked'),(3,'todo'),(4,'done')]: db.execute('INSERT INTO tasks VALUES(?,1,?, ?,"medium","")',(n,'Task '+str(n),s))
            db.commit()
        self.manifest=self.root/'清单.json'
        self.manifest.write_text(json.dumps({'tasks':[{'task_id':n,'sources':[n],'line':'Test','owner':'Eddie' if n==3 else 'Codex','next':'Read README','acceptance':'Quote actual file','dependency':'Wait'} for n in range(1,5)]}))
        self.store=module.BoardStore(self.root,self.manifest)
    def test_lists_live_database_status_instead_of_manifest(self):
        self.assertEqual(len(self.store.list()),4)
        self.assertEqual(self.store.list()[1]['status'],'blocked')
    def cancel_request(self, payload):
        cls=module.handler(module.Runner(self.store,'http://127.0.0.1:4192'),self.root)
        instance=object.__new__(cls)
        content=json.dumps(payload).encode()
        instance.server=SimpleNamespace(server_port=6480)
        instance.headers={'Host':'127.0.0.1:6480','x-corpus':'1','Content-Length':str(len(content))}
        instance.path='/api/tasks/cancel'; instance.rfile=io.BytesIO(content)
        responses=[]; instance.respond=lambda status,value: responses.append((status,value))
        instance.do_POST()
        return responses[0]
    def test_cancel_updates_shared_db_and_live_card_and_manifest(self):
        original=self.manifest.read_bytes()
        code,result=self.cancel_request({'task_id':2,'expected_status':'blocked','note':'不再实验；已有结果已沉淀。'})
        self.assertEqual(code,200,result)
        self.assertEqual(result['task']['status'],'cancelled')
        self.assertFalse(result['task']['eligible'])
        self.assertIn('已有结果已沉淀',result['task']['next'])
        with closing(sqlite3.connect(self.store.db)) as db, db:
            status,notes=db.execute('SELECT status,notes FROM tasks WHERE id=2').fetchone()
        self.assertEqual(status,'cancelled');self.assertIn('不再实验',notes)
        self.assertNotEqual(self.manifest.read_bytes(),original)
        self.assertTrue(list((self.root/'.data/backups').glob('*.db')))
        self.assertEqual(self.store.list()[1]['next'],result['task']['next'])
    def test_cancel_rejects_stale_status_and_tasks_outside_manifest(self):
        for payload in [{'task_id':2,'expected_status':'todo','note':'停止'}, {'task_id':999,'expected_status':'todo','note':'停止'}]:
            code,result=self.cancel_request(payload)
            self.assertEqual(code,400,result)
        self.assertEqual(self.store.list()[1]['status'],'blocked')
    def test_cancel_cannot_close_running_or_completed_task(self):
        self.store.update(1,'doing','Running',expected='todo')
        for n,status in [(1,'doing'),(4,'done')]:
            code,result=self.cancel_request({'task_id':n,'expected_status':status,'note':'停止'})
            self.assertEqual(code,400,result)
        self.assertEqual(self.store.list()[0]['status'],'doing')
        self.assertEqual(self.store.list()[3]['status'],'done')
    def test_cancel_requires_explicit_status_and_single_line_note(self):
        for payload in [{'task_id':1,'note':'停止'}, {'task_id':1,'expected_status':'todo','note':''}, {'task_id':1,'expected_status':'todo','note':'停止\n伪造记录'}]:
            code,result=self.cancel_request(payload)
            self.assertEqual(code,400,result)
        self.assertEqual(self.store.list()[0]['status'],'todo')
    def test_dispatch_rejects_human_blocked_and_unknown_tasks(self):
        for n in [2,3,4,999]:
            with self.assertRaises(ValueError): self.store.prepare(n,'read-only','Read')
        with self.assertRaises(ValueError): self.store.prepare(1,'danger-full-access','Read')
        self.assertEqual(self.store.prepare(1,'read-only','Read')['cwd'],str((self.root/'project').resolve()))
    def test_rejects_project_outside_workspace(self):
        with closing(sqlite3.connect(self.root/'.data/tasks.db')) as db, db: db.execute('UPDATE projects SET local_path="/tmp"')
        with self.assertRaises(ValueError): self.store.prepare(1,'read-only','Read')
    def test_readonly_success_does_not_close_implementation_task(self):
        snap={'agents':[{'state':'completed','output':'Checked'}],'nativeTasks':[{'state':'accepted'}]}
        self.store.settle(1,'todo','read-only',snap)
        self.assertEqual(len(self.store.list()),4)
        self.assertEqual(self.store.list()[0]['status'],'todo')
    def test_unaccepted_or_isolated_results_require_followup(self):
        for access,snap in [('read-only',{'agents':[{'state':'completed'}],'nativeTasks':[{'state':'planned'}]}),('workspace-write',{'agents':[{'state':'completed'}],'nativeTasks':[{'state':'accepted'}]})]:
            self.store.settle(1,'todo',access,snap)
            self.assertEqual(len(self.store.list()),4)
            self.assertEqual(self.store.list()[0]['status'],'blocked')
    def test_concurrent_status_change_is_not_overwritten(self):
        self.store.update(1,'doing','Dispatched',expected='todo')
        with closing(sqlite3.connect(self.root/'.data/tasks.db')) as db, db:
            db.execute('UPDATE tasks SET status="done" WHERE id=1')
        with self.assertRaises(ValueError):
            self.store.settle(1,'todo','read-only',{'error':'Stopped'},expected='doing')
        self.assertEqual(self.store.list()[0]['status'],'done')
    def test_crew_check_requires_two_accepted_members(self):
        folder=self.root/'docs'; folder.mkdir(); manifest=folder/'清单.json'
        manifest.write_text(json.dumps({'tasks':[{'task_id':1,'line':'Crew','owner':'Codex','sources':[15,16]}]}))
        store=module.BoardStore(self.root,manifest)
        snap={'agents':[{'state':'completed','output':'Summary'}, {'parentThreadId':'root','state':'completed'}, {'parentThreadId':'root','state':'completed'}], 'nativeTasks':[{'state':'accepted'}, {'state':'planned'}]}
        store.settle(1,'blocked','read-only',snap)
        self.assertEqual(store.list()[0]['status'],'blocked')
        snap['nativeTasks'][1]['state']='accepted'
        store.settle(1,'blocked','read-only',snap)
        self.assertEqual(store.list()[0]['status'],'done')
    def test_runner_records_actual_outcome_and_rejects_existing_team(self):
        class FixtureRunner(module.Runner):
            occupied=False
            started=False
            def request(self,path,payload=None):
                if path=='/api/state': return {'projects':[{'id':'fixture','dirs':[str((self.store.root/'project').resolve())]}]}
                if path.startswith('/api/team?'):
                    if self.started: return {'status':'running','agents':[{'state':'completed','output':'Actual fixture result'}],'nativeTasks':[],'run':{'id':'fixture-run'}}
                    return {'status':'running' if self.occupied else 'stopped','run':{'id':'fixture-run'} if self.occupied else None}
                if path=='/api/team/start':
                    self.started=True
                    return self.request('/api/team?projectId=fixture')
                if path=='/api/team/stop':
                    self.assert_stop=payload
                    return {**self.request('/api/team?projectId=fixture'),'status':'stopped'}
                raise AssertionError(path)
        runner=FixtureRunner(self.store,'http://127.0.0.1:4192')
        runner.occupied=True
        with self.assertRaises(ValueError): runner.dispatch(1,'read-only','Read')
        self.assertEqual(self.store.list()[0]['status'],'todo')
        runner.occupied=False
        job=runner.dispatch(1,'read-only','Read')
        for _ in range(100):
            if runner.active is None: break
            time.sleep(.01)
        self.assertIsNone(runner.active)
        receipt=json.loads((runner.runs/(job['id']+'.json')).read_text())
        self.assertEqual(receipt['state'],'completed')
        self.assertEqual(receipt['snapshot']['agents'][0]['output'],'Actual fixture result')
        self.assertEqual(self.store.list()[0]['status'],'todo')
        self.assertEqual(runner.assert_stop,{'projectId':'fixture','runId':'fixture-run'})

    def test_task_get_and_status_preserve_persisted_run_state(self):
        runs=self.manifest.parent/'runs'; runs.mkdir()
        jobs=[{'id':'one','task_id':1,'state':'running'}, {'id':'other','task_id':2,'state':'completed'}]
        for job in jobs: (runs/(job['id']+'.json')).write_text(json.dumps(job))
        self.assertEqual(self.store.get(1)['task_id'],1)
        self.assertEqual(self.store.status(1)['jobs'],[jobs[0]])
        with self.assertRaises(ValueError): self.store.get(999)

    def test_cancel_backs_up_database_and_manifest_and_preserves_history(self):
        original=self.manifest.read_bytes()
        result=self.store.cancel(1,'todo','不继续执行；保留沉淀记录。')
        self.assertTrue(result['manifest_synced'])
        self.assertFalse(result['idempotent'])
        self.assertEqual(result['task']['status'],'cancelled')
        item=json.loads(self.manifest.read_text())['tasks'][0]
        self.assertEqual(item['sources'],[1])
        self.assertEqual(item['status'],'cancelled')
        self.assertEqual(item['next'],'不继续执行；保留沉淀记录。')
        self.assertEqual(item['dependency'],'无新增执行。')
        self.assertEqual(item['acceptance'],'任务已终止，保留已有记录；不继续执行。')
        self.assertEqual(item['dispatch'],'用户终止')
        self.assertEqual(item['cancellation']['note'],item['next'])
        backups=self.root/'.data/backups'
        self.assertEqual(len(list(backups.glob('*.db'))),1)
        self.assertIn(original,[p.read_bytes() for p in backups.glob('*.json')])
        with closing(sqlite3.connect(self.store.db)) as db, db:
            notes=db.execute('SELECT notes FROM tasks WHERE id=1').fetchone()[0]
        self.assertIn('不继续执行；保留沉淀记录。',notes)
        before=self.manifest.read_bytes()
        repeated=self.store.cancel(1,'todo','同一取消操作重试。')
        self.assertTrue(repeated['idempotent'])
        self.assertEqual(before,self.manifest.read_bytes())
        self.assertEqual(len(list(backups.glob('*.db'))),1)

    def test_cancel_rejects_invalid_stale_and_active_requests(self):
        for args in [(True,'todo','Stop'),('1','todo','Stop'),(999,'todo','Stop'),(1,'other','Stop'),(1,'todo',''),(1,'todo','x'*2801),(1,'blocked','Stop')]:
            with self.assertRaises(ValueError): self.store.cancel(*args)
        with closing(sqlite3.connect(self.store.db)) as db, db: db.execute('UPDATE tasks SET status="doing" WHERE id=1')
        with self.assertRaises(ValueError): self.store.cancel(1,'doing','Stop')
        with closing(sqlite3.connect(self.store.db)) as db, db: db.execute('UPDATE tasks SET status="todo" WHERE id=1')
        runs=self.manifest.parent/'runs'; runs.mkdir()
        for state in ['starting','running','waiting']:
            (runs/'active.json').write_text(json.dumps({'id':'active','task_id':1,'state':state}))
            with self.assertRaises(ValueError): self.store.cancel(1,'todo','Stop')
        self.assertEqual(self.store.get(1)['status'],'todo')

    def test_cancel_reports_manifest_failure_without_hiding_database_success(self):
        original=self.manifest.read_bytes()
        with patch.object(module,'write_json',side_effect=OSError('manifest is read-only')):
            result=self.store.cancel(1,'todo','Stop')
        self.assertFalse(result['manifest_synced'])
        self.assertIn('manifest is read-only',result['sync_warning'])
        self.assertEqual(result['task']['status'],'cancelled')
        self.assertEqual(original,self.manifest.read_bytes())
        repaired=self.store.cancel(1,'todo','Stop')
        self.assertTrue(repaired['idempotent'])
        self.assertTrue(repaired['manifest_synced'])
        self.assertEqual(json.loads(self.manifest.read_text())['tasks'][0]['status'],'cancelled')

    def test_cancel_reports_manifest_changed_after_database_commit(self):
        update=self.store.update
        def change_manifest_after_update(*args,**kwargs):
            update(*args,**kwargs)
            self.manifest.write_text('{invalid json')
        with patch.object(self.store,'update',side_effect=change_manifest_after_update):
            result=self.store.cancel(1,'todo','Stop')
        self.assertEqual(result['task']['status'],'cancelled')
        self.assertFalse(result['manifest_synced'])
        self.assertTrue(result['sync_warning'])
        with closing(sqlite3.connect(self.store.db)) as db, db:
            self.assertEqual(db.execute('SELECT status FROM tasks WHERE id=1').fetchone()[0],'cancelled')

    def test_http_cancel_uses_store_and_rejects_active_runner(self):
        runner=module.Runner(self.store,'http://127.0.0.1:4192')
        cls=module.handler(runner,self.root)
        def request():
            instance=object.__new__(cls)
            payload=json.dumps({'task_id':1,'expected_status':'todo','note':'Stop'}).encode()
            instance.headers={'Host':'127.0.0.1:6480','x-corpus':'1','Content-Length':str(len(payload))}
            instance.server=SimpleNamespace(server_port=6480)
            instance.path='/api/tasks/cancel'; instance.rfile=io.BytesIO(payload)
            responses=[]; instance.respond=lambda status,value: responses.append((status,value))
            instance.do_POST()
            return responses[0]
        runner.active={'id':'active','task_id':1}
        code,response=request()
        self.assertEqual(code,400)
        self.assertEqual(self.store.get(1)['status'],'todo')
        runner.active=None
        code,response=request()
        self.assertEqual(code,200)
        self.assertEqual(response['task']['status'],'cancelled')

    def command(self,*args):
        return subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('command.py')),'--workspace',str(self.root),'--manifest',str(self.manifest),*args],capture_output=True,text=True)

    def test_offline_command_reads_and_cancels_same_store(self):
        listing=self.command('--action','list')
        self.assertEqual(listing.returncode,0,listing.stderr)
        result=json.loads(listing.stdout)
        self.assertEqual(len(result['tasks']),4)
        self.assertEqual(result['workspace'],str(self.root.resolve()))
        self.assertEqual(result['manifest'],str(self.manifest.resolve()))
        self.assertEqual(self.command('--action','get','--task','1').returncode,0)
        self.assertEqual(self.command('--action','status','--task','1').returncode,0)
        cancelled=self.command('--action','cancel','--task','1','--expected-status','todo','--note','Stop')
        self.assertEqual(cancelled.returncode,0,cancelled.stderr)
        self.assertEqual(json.loads(cancelled.stdout)['task']['status'],'cancelled')
        for args in [('--action','get','--task','999'),('--action','cancel','--task','1'),('--action','other')]:
            failed=self.command(*args)
            self.assertEqual(failed.returncode,1)
            self.assertEqual(failed.stdout,'')
            self.assertTrue(failed.stderr.strip())

    def test_read_command_does_not_create_missing_database(self):
        self.store.db.unlink()
        result=self.command('--action','list')
        self.assertEqual(result.returncode,1)
        self.assertFalse(self.store.db.exists())

    def test_read_does_not_recreate_database_removed_after_existence_check(self):
        self.store.db.unlink()
        with patch.object(pathlib.Path,'is_file',return_value=True):
            with self.assertRaises(sqlite3.OperationalError): self.store.list()
        self.assertFalse(self.store.db.exists())

if __name__=='__main__': unittest.main()
