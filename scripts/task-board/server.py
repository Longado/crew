"""Local task-board adapter. Stdlib only; task truth stays in the workspace DB."""
import argparse
import copy
import datetime as dt
import fcntl
import json
import mimetypes
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lead'))
from runs_registry import read_runs


ACTIVE_JOB_STATES = ('starting', 'running', 'waiting', 'recovery_required')

def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


class BoardStore:
    def __init__(self, root, manifest):
        self.root = Path(root).resolve()
        self.manifest = Path(manifest).resolve()
        self.db = self.root / '.data/tasks.db'

    @staticmethod
    def is_check(task):
        return set(task.get('sources', [])) == {15, 16} and task.get('line', '').lower().startswith('crew')

    def list(self):
        if not self.db.is_file():
            raise ValueError('工作区任务库不存在；不会新建任务库。')
        source = json.loads(self.manifest.read_text(encoding='utf-8'))['tasks']
        with closing(sqlite3.connect(self.db.as_uri() + '?mode=ro', uri=True)) as db, db:
            db.row_factory = sqlite3.Row
            rows = {r['id']: dict(r) for r in db.execute('SELECT t.id,t.title,t.status,t.priority,t.notes,p.local_path FROM tasks t JOIN projects p ON p.id=t.project_id')}
        result = []
        for item in source:
            live = rows.get(item['task_id'])
            if not live:
                continue
            task = {**item, **live}
            task.pop('id', None)
            if task['status'] == 'cancelled' and 'Crew任务终止：' in (task.get('notes') or ''):
                task['cancellation_reason'] = task['notes'].rsplit('Crew任务终止：', 1)[1].splitlines()[0]
                task['next'] = '已终止：' + task['cancellation_reason']
            task['check_only'] = self.is_check(task)
            task['reason'] = self.condition(task)
            try:
                task['cwd'] = str(self.directory(task))
            except ValueError as error:
                task['reason'] = task['reason'] or str(error)
            task['eligible'] = not task['reason']
            result.append(task)
        return result

    def get(self, task_id):
        if type(task_id) is not int or task_id <= 0:
            raise ValueError('task_id 必须是正整数。')
        task = next((t for t in self.list() if t['task_id'] == task_id), None)
        if not task:
            raise ValueError('任务不在这份清单内。')
        return task

    def jobs(self, task_id):
        result = []
        for path in sorted((self.manifest.parent / 'runs').glob('*.json')):
            try:
                job = json.loads(path.read_text(encoding='utf-8'))
                if isinstance(job, dict) and job.get('task_id') == task_id:
                    result.append(job)
            except (OSError, ValueError):
                continue
        return result

    def status(self, task_id):
        return {'task': self.get(task_id), 'jobs': self.jobs(task_id)}

    def view(self):
        return {'tasks': self.list(), 'batch': json.loads(self.manifest.read_text(encoding='utf-8')).get('batch', ''), 'workspace': str(self.root), 'manifest': str(self.manifest)}

    def cancel(self, task_id, expected_status, note):
        if type(task_id) is not int or task_id <= 0:
            raise ValueError('task_id 必须是正整数。')
        if expected_status not in ('todo', 'blocked', 'doing', 'done', 'cancelled'):
            raise ValueError('请提供有效的 expected_status。')
        if not isinstance(note, str) or not note.strip() or len(note) > 2800 or '\n' in note or '\r' in note:
            raise ValueError('请填写单行终止说明，最多2800字。')
        note = note.strip()
        # CLI, MCP and HTTP cancellations share this lock and the same database.
        with (self.root / '.data/task-board.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            task = self.get(task_id)
            if task['status'] in ('doing', 'done'):
                raise ValueError('正在执行或已完成的任务不能终止；执行中请先检查并停止原运行。')
            if any(job.get('state') in ACTIVE_JOB_STATES for job in self.jobs(task_id)):
                raise ValueError('这项任务仍有运行记录处于执行中，请先检查并停止原运行。')
            idempotent = task['status'] == 'cancelled'
            if not idempotent:
                if task['status'] != expected_status:
                    raise ValueError('任务状态已被其他操作改变，请刷新后检查。')
                self.update(task_id, 'cancelled', 'Crew任务看板：用户终止；' + note, expected=expected_status)
            cancelled = {**task, 'status': 'cancelled', 'reason': '这项已结束，可查看记录。', 'eligible': False}
            result = {'task': cancelled, 'manifest_synced': False, 'idempotent': idempotent}
            try:
                manifest = json.loads(self.manifest.read_text(encoding='utf-8'))
                item = next(t for t in manifest['tasks'] if t['task_id'] == task_id)
                if not (idempotent and item.get('status') == 'cancelled' and item.get('cancellation')):
                    backup = self.root / '.data/backups' / ('task-board-manifest-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.json')
                    backup.parent.mkdir(exist_ok=True)
                    backup.write_bytes(self.manifest.read_bytes())
                    item.update(status='cancelled', next=note, dependency='无新增执行。', acceptance='任务已终止，保留已有记录；不继续执行。', dispatch='用户终止', cancellation={'at': now(), 'note': note})
                    write_json(self.manifest, manifest)
                result['manifest_synced'] = True
                result['task'] = self.get(task_id)
            except (OSError, ValueError, KeyError, StopIteration) as error:
                result['sync_warning'] = '任务库已终止；清单同步失败，请重试同步：' + str(error)
            return result

    def condition(self, task):
        if task['status'] in ('done', 'cancelled'):
            return '这项已结束，可查看记录。'
        if any(job.get('state') in ACTIVE_JOB_STATES for job in self.jobs(task['task_id'])):
            return '这项仍有运行回执待结束或核对，请先检查原运行。'
        if task['status'] == 'doing':
            return '这项正在执行。'
        if task['status'] == 'blocked' and not self.is_check(task):
            return task.get('dependency') or '先满足任务条件，再安排执行。'
        if task.get('owner', '').startswith('Eddie'):
            return task.get('dependency') or '这一步需要你本人参与。'
        return ''

    def directory(self, task):
        if self.is_check(task):
            path = self.manifest.parent
        else:
            value = task.get('local_path') or task.get('path')
            if not value:
                raise ValueError('尚无可执行的本地项目入口。')
            path = Path(value)
            if not path.is_absolute():
                path = self.root / path
        path = path.resolve()
        if path == self.root or not path.is_relative_to(self.root) or not path.is_dir() or '.local-sensitive' in path.parts:
            raise ValueError('执行入口必须是工作区内已存在的项目目录。')
        return path

    def prepare(self, task_id, access, goal):
        task = self.get(task_id)
        if access not in ('read-only', 'workspace-write'):
            raise ValueError('请选择只读检查或隔离修改。')
        if not task['eligible']:
            raise ValueError(task['reason'])
        if self.is_check(task) and access != 'read-only':
            raise ValueError('清单核对只需要只读权限。')
        if not isinstance(goal, str) or not goal.strip() or len(goal) > 2800:
            raise ValueError('请填写本次目标，最多2800字。')
        task['access'] = access
        task['goal'] = goal.strip()
        return task

    def update(self, task_id, status, note, expected=None):
        backups = self.root / '.data/backups'
        backups.mkdir(exist_ok=True)
        with closing(sqlite3.connect(self.db, timeout=10)) as db, db:
            db.execute('PRAGMA foreign_keys=ON')
            with closing(sqlite3.connect(backups / ('tasks-board-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.db'))) as backup, backup:
                db.backup(backup)
            columns = {r[1] for r in db.execute('PRAGMA table_info(tasks)')}
            sql = "UPDATE tasks SET status=?,notes=COALESCE(notes,'') || ?"
            if 'updated_at' in columns:
                sql += ",updated_at=date('now')"
            sql += ' WHERE id=?'
            args = [status, '\n[' + now() + '] ' + note, task_id]
            if expected:
                sql += ' AND status=?'
                args.append(expected)
            if db.execute(sql, args).rowcount != 1:
                raise ValueError('任务状态已被其他操作改变，请刷新后检查。')

    def settle(self, task_id, previous, access, snapshot, receipt='', expected=None, recover=False):
        agents = snapshot.get('agents', [])
        leader = next((a for a in agents if not a.get('parentThreadId')), {})
        tasks = snapshot.get('nativeTasks', [])
        accepted = bool(leader.get('output')) and leader.get('state') == 'completed' and all(t.get('state') == 'accepted' for t in tasks) and not snapshot.get('error')
        item = next(t for t in self.list() if t['task_id'] == task_id)
        if self.is_check(item):
            accepted = accepted and len(tasks) == 2 and len(agents) == 3
        status = ('done' if self.is_check(item) else previous) if accepted and access == 'read-only' else 'blocked'
        label = '清单核对完成' if status == 'done' else '只读检查完成，任务原有验收仍需继续' if accepted and access == 'read-only' else '隔离成果待确认' if accepted else '执行未完成验收，需查看结果'
        if recover and not accepted and previous in ('todo', 'blocked'):
            status = previous
            label = '原运行已结束但未完成验收；已保留成果，可重新处理任务'
        self.update(task_id, status, 'Crew任务看板：' + label + ('；回执 ' + receipt if receipt else ''), expected)
        return status, label


class Runner:
    def __init__(self, store, crew_url):
        self.store, self.crew_url = store, crew_url.rstrip('/')
        self.lock = threading.RLock()
        self.jobs = []
        self.active = None
        self.runs = store.manifest.parent / 'runs'
        for path in sorted(self.runs.glob('*.json')):
            try:
                job = json.loads(path.read_text())
                if job['state'] in ACTIVE_JOB_STATES:
                    job.update(state='recovery_required', can_stop=False, reconciliation_outcome=None, label='看板服务已重启，请重新核对原运行；尚未确认结束。')
                    self.persist(job)
                self.jobs.append(job)
            except (OSError, ValueError, KeyError, TypeError):
                continue

    def request(self, path, payload=None):
        request = urllib.request.Request(self.crew_url + path, data=json.dumps(payload).encode() if payload is not None else None, headers={'Content-Type': 'application/json', 'x-corpus': '1'})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode('utf-8', errors='replace')[:500]
            raise ValueError('Crew返回错误：' + detail) from error
        except urllib.error.URLError as error:
            raise ValueError('无法连接本地Crew服务，请检查运行入口。') from error

    def persist(self, job):
        with self.lock:
            write_json(self.runs / (job['id'] + '.json'), job)

    def view(self):
        with self.lock:
            recent = {j['id'] for j in self.jobs[-15:]}
            jobs = copy.deepcopy([j for j in self.jobs if j['id'] in recent or j['state'] == 'recovery_required'])
        for job in jobs:
            snap = job.get('snapshot', {})
            for agent in snap.get('agents', []):
                agent.pop('events', None)
            snap.pop('messages', None)
        return {'tasks': self.store.list(), 'jobs': jobs, 'crew_url': self.crew_url, 'batch': json.loads(self.store.manifest.read_text()).get('batch', ''), 'workspace':str(self.store.root), 'manifest':str(self.store.manifest)}

    def dispatch(self, task_id, access, goal):
        with self.lock:
            if self.active or any(j['state'] == 'recovery_required' for j in self.jobs):
                raise ValueError('Crew仍有运行待结束或核对，请先检查原运行。')
            task = self.store.prepare(task_id, access, goal)
            state = self.request('/api/state')
            snapshots = {}
            for project in state['projects']:
                snap = self.request('/api/team?projectId=' + project['id'])
                snapshots[project['id']] = snap
                if snap['status'] in ('starting', 'running', 'error') and snap.get('run'):
                    raise ValueError('Crew中已有运行，请先在原工作台检查并停止。')
            project = next((p for p in state['projects'] if task['cwd'] in p.get('dirs', [])), None)
            project_id = project['id'] if project else self.request('/api/projects', {'name': Path(task['cwd']).name, 'dirs': [task['cwd']]})['id']
            job = {'id': dt.datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8], 'task_id': task_id, 'title': task['line'], 'previous': task['status'], 'access': access, 'goal': goal, 'project_id': project_id, 'crew_link': self.crew_url + '/#/p/' + project_id + '/team', 'created_at': now(), 'state': 'starting', 'label': '正在启动Crew', 'snapshot': {}}
            job['prior_run_id'] = (snapshots.get(project_id, {}).get('run') or {}).get('id')
            self.store.update(task_id, 'doing', '任务看板已派发，运行 ' + job['id'], expected=task['status'])
            self.active = job
            self.jobs.append(job)
            self.persist(job)
            threading.Thread(target=self.run, args=(job, task), daemon=True).start()
            return copy.deepcopy(job)

    def run(self, job, task):
        snap = {}
        run_id = None
        start_rejected = False
        try:
            boundary = '\n本轮仅执行以上范围。只读模式不修改文件；修改模式仅改Crew隔离副本，不合并源项目。不得发布、发消息、启停云机、安装或修改凭据。遇到权限限制如实报告，不申请扩大权限。'
            goal = task['goal'] + boundary
            snap = self.request('/api/team/start', {'projectId': job['project_id'], 'clientRequestId': job['id'], 'mode': 'codex-team', 'cwd': task['cwd'], 'goal': goal, 'access': task['access']})
            run_id = (snap.get('run') or {}).get('id')
            if not isinstance(run_id, str) or not run_id:
                raise ValueError('Crew未返回原运行编号，需重新核对。')
            deadline = time.monotonic() + 1800
            while True:
                with self.lock:
                    job['snapshot'] = snap
                    waiting = any(i.get('state') == 'pending' for i in snap.get('inputs', []) + snap.get('approvals', []))
                    job['state'] = 'waiting' if waiting else 'running'
                    job['label'] = 'Crew等待你的输入，请打开工作台' if waiting else 'Crew正在执行'
                    job['can_stop'] = snap.get('status') != 'stopped'
                    self.persist(job)
                leader = next((a for a in snap.get('agents', []) if not a.get('parentThreadId')), {})
                if snap['status'] in ('error', 'stopped') or leader.get('state') in ('completed', 'failed', 'interrupted'):
                    break
                if time.monotonic() > deadline:
                    raise ValueError('运行超过30分钟，需确认原运行是否结束；已保留成果。')
                time.sleep(2)
                current = self.request('/api/team?projectId=' + job['project_id'])
                if (current.get('run') or {}).get('id') != run_id:
                    raise ValueError('Crew当前运行与原回执不同，需重新核对。')
                snap = current
            if job.get('stop_requested'):
                snap = {**snap, 'error': '用户已请求停止原运行。'}
        except Exception as error:
            snap = {**snap, 'error': str(error)}
            start_rejected = not run_id and isinstance(error.__cause__ or error, urllib.error.HTTPError)
        finally:
            confirmed = False
            reason = None
            try:
                if not run_id:
                    if not start_rejected:
                        raise ValueError('启动结果未知，原运行编号缺失；请重新核对。')
                    current = self.request('/api/team?projectId=' + job['project_id'])
                    if not self.not_started(job, current, rejected=True):
                        raise ValueError(self.current_description(current))
                    reason = 'Crew 明确拒绝启动，当前没有正在启动或执行的运行；确认没启动。'
                else:
                    current = self.request('/api/team?projectId=' + job['project_id'])
                    if (current.get('run') or {}).get('id') != run_id:
                        raise ValueError('Crew当前运行与原回执不同，未停止其他运行。')
                    if current.get('status') != 'stopped':
                        current = self.request('/api/team/stop', {'projectId': job['project_id'], 'runId': run_id})
                    if (current.get('run') or {}).get('id') != run_id or current.get('status') != 'stopped':
                        raise ValueError('停止请求尚未确认原运行结束。')
                    snap = {**snap, **current}
                confirmed = True
            except Exception as error:
                with self.lock:
                    job['snapshot'] = snap
                    self.pending(job, '原运行待重新核对：' + str(error))
            with self.lock:
                if confirmed:
                    self.finish(job, snap, reason=reason)
                if self.active is job:
                    self.active = None

    def find_job(self, job_id):
        if not isinstance(job_id, str) or not job_id.strip():
            raise ValueError('请指定运行回执编号。')
        if self.active and self.active['id'] == job_id:
            return self.active
        job = next((j for j in self.jobs if j['id'] == job_id), None)
        if not job:
            raise ValueError('找不到该运行回执，请刷新。')
        return job

    @staticmethod
    def ended(snapshot):
        return snapshot.get('status') == 'stopped'

    @staticmethod
    def current_description(snapshot):
        if snapshot.get('status') == 'idle' and not snapshot.get('run'):
            return 'Crew 当前没有运行，可能已重启；无法确认原运行是否启动过，请到工作台或隔离副本目录核实后用「确认原运行已结束」。'
        run_id = (snapshot.get('run') or {}).get('id') or '无编号'
        return f'Crew 当前运行 {run_id}，状态 {snapshot.get("status", "未知")}；无法确认原运行归属或结束，请到 Crew 工作台判断。'

    @staticmethod
    def valid_claim(value):
        return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value) is not None

    @classmethod
    def matches_run(cls, job, snapshot):
        run = snapshot.get('run') or {}
        if not isinstance(run.get('id'), str) or not run['id']:
            return False
        recorded_id = (job.get('snapshot', {}).get('run') or {}).get('id')
        if recorded_id:
            return run['id'] == recorded_id
        claim = run.get('clientRequestId')
        return cls.valid_claim(claim) and claim == job['id']

    @staticmethod
    def not_started(job, snapshot, rejected=False):
        run = snapshot.get('run') or {}
        # A validated claim identifies a separate dispatch even when that run is live.
        # Legacy snapshots without a claim retain the conservative checks below.
        if isinstance(run.get('id'), str) and run['id'] and Runner.valid_claim(run.get('clientRequestId')):
            return run['clientRequestId'] != job['id']
        status = snapshot.get('status')
        if status not in ('idle', 'stopped', 'error'):
            return False
        if any(a.get('state') in ('starting', 'running', 'waiting_input', 'waiting_approval', 'interrupt_requested')
               for a in snapshot.get('agents', [])):
            return False
        run = snapshot.get('run')
        if not run:
            # A restart can erase a run whose start response was lost.
            return rejected
        if status != 'stopped':
            return False
        if rejected or (job.get('prior_run_id') and run.get('id') == job['prior_run_id']):
            return True
        # An older update proves this run predates dispatch. Missing/ambiguous times do not.
        stamp = run.get('startedAt') or snapshot.get('updatedAt')
        try:
            return dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')) < dt.datetime.fromisoformat(job['created_at'])
        except (AttributeError, KeyError, TypeError, ValueError):
            return False

    def pending(self, job, label, can_stop=False, outcome=None):
        job.update(state='recovery_required', label=label, can_stop=can_stop, reconciliation_outcome=outcome)
        self.persist(job)

    def newer_job(self, job):
        for other in self.store.jobs(job['task_id']):
            if other.get('id') == job['id']:
                continue
            created, other_created = job.get('created_at'), other.get('created_at')
            if not created or not other_created or other_created >= created:
                return True
        return False

    def finish(self, job, snapshot, recover=False, reason=None):
        # The store lock coordinates CLI/MCP cancellation; expected='doing'
        # also protects task status changed by clients outside this lock.
        with (self.store.root / '.data/task-board.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            task = self.store.get(job['task_id'])
            if self.newer_job(job):
                status, label = task['status'], '原运行已结束；任务已有较新回执，未回写任务状态。'
            elif task['status'] != 'doing':
                status, label = task['status'], '原运行已结束；任务状态已由其他操作改变，保留当前状态。'
            else:
                receipt = str((self.runs / (job['id'] + '.json')).relative_to(self.store.root))
                try:
                    if reason:
                        status, label = 'blocked', reason
                        self.store.update(job['task_id'], status, 'Crew任务看板：' + label + '；回执 ' + receipt, expected='doing')
                    else:
                        status, label = self.store.settle(job['task_id'], job['previous'], job['access'], snapshot, receipt, expected='doing', recover=recover)
                except Exception as error:
                    self.pending(job, '原运行已结束，任务回写待重新核对：' + str(error))
                    return False
        if reason and label != reason:
            label = reason + '；' + label
        if job.get('snapshot') != snapshot:
            job['prior_snapshot'] = job.get('snapshot', {})
        job.update(snapshot=snapshot, state='blocked' if reason or status == 'blocked' else 'completed', label=label, can_stop=False, reconciliation_outcome='finished', finished_at=now())
        self.persist(job)
        return True

    def reconcile(self, job_id, confirm_ended=False):
        if type(confirm_ended) is not bool:
            raise ValueError('confirm_ended 必须是明确的布尔确认。')
        with self.lock:
            job = self.find_job(job_id)
            if confirm_ended:
                if job['state'] != 'recovery_required' or job.get('reconciliation_outcome') != 'unresolved' or job.get('can_stop'):
                    raise ValueError('仅核对结果为 unresolved 的待核对回执可以确认结束；请先重新核对。')
            if job['state'] not in ACTIVE_JOB_STATES:
                return {'ok': True, 'outcome': 'finished', 'job': copy.deepcopy(job), 'task': self.store.get(job['task_id'])}
            if self.active is job and job['state'] != 'recovery_required':
                raise ValueError('原运行正在由本看板跟踪，请等待或停止原运行。')
            run_id = (job.get('snapshot', {}).get('run') or {}).get('id')
        current, error, not_started = None, None, False
        try:
            current = self.request('/api/team?projectId=' + job['project_id'])
            if self.matches_run(job, current):
                pass
            elif not isinstance(run_id, str) or not run_id:
                not_started = self.not_started(job, current)
                if not not_started:
                    raise ValueError(self.current_description(current))
            else:
                raise ValueError(self.current_description(current))
        except Exception as issue:
            error = str(issue)
        with self.lock:
            if job['state'] in ACTIVE_JOB_STATES and not error and not not_started and not run_id:
                # The claimed run's snapshot is authoritative; a startup transport
                # error is history, not an execution failure of the recovered run.
                job['prior_snapshot'] = job.get('snapshot', {})
                job['snapshot'] = current
            if job['state'] not in ACTIVE_JOB_STATES:
                outcome = 'finished'
            elif not error and not not_started and not self.ended(current):
                job['snapshot'] = {**job['snapshot'], **current}
                self.pending(job, '已确认原运行仍在Crew中；请先停止原运行或再次核对。', can_stop=True, outcome='live')
                outcome = 'live'
            elif confirm_ended:
                # Another reconciliation may have established a live run during this query.
                if job.get('reconciliation_outcome') != 'unresolved' or job.get('can_stop'):
                    raise ValueError('原运行状态已改变，请重新核对；仍在执行时请先停止。')
                snapshot = job.get('snapshot', {})
                if not error and not not_started:
                    snapshot = {**snapshot, **current}
                reason = '用户确认结束，未经 Crew 证实；成果和回执已保留，未自动验收或合并隔离成果。'
                job['user_confirmed_ended'] = True
                outcome = 'finished' if self.finish(job, snapshot, reason=reason) else 'unresolved'
                if outcome == 'finished' and self.active is job:
                    self.active = None
            elif error:
                self.pending(job, '原运行待重新核对：' + error, outcome='unresolved')
                outcome = 'unresolved'
            elif not_started:
                outcome = 'finished' if self.finish(job, job.get('snapshot', {}), reason='已核对 Crew 当前快照，确认本次没启动；成果和回执已保留。') else 'unresolved'
            else:
                snapshot = {**job['snapshot'], **current}
                if job.get('stop_requested'):
                    snapshot['error'] = snapshot.get('error') or '用户已请求停止原运行。'
                outcome = 'finished' if self.finish(job, snapshot, recover=True) else 'unresolved'
            return {'ok': True, 'outcome': outcome, 'job': copy.deepcopy(job), 'task': self.store.get(job['task_id'])}

    def stop(self, job_id):
        with self.lock:
            job = self.find_job(job_id)
            if job['state'] not in ACTIVE_JOB_STATES:
                raise ValueError('该运行已结束，请刷新。')
            run_id = (job.get('snapshot', {}).get('run') or {}).get('id')
            if not isinstance(run_id, str) or not run_id:
                raise ValueError('原运行编号尚未确认，不能停止；请稍后重新核对。')
        result = self.request('/api/team/stop', {'projectId': job['project_id'], 'runId': run_id})
        if (result.get('run') or {}).get('id') != run_id:
            raise ValueError('停止响应与原运行不符，未确认停止成功，请重新核对。')
        with self.lock:
            stopped = result.get('status') == 'stopped'
            job.update(stop_requested=True, stop_confirmed=stopped, snapshot={**job['snapshot'], **result}, can_stop=not stopped, reconciliation_outcome=None, label='原运行停止已确认，请等待结算或重新核对。' if stopped else '停止请求已发送，尚未确认原运行结束。')
            self.persist(job)
            return {'ok': True, 'stop_requested': True, 'stopped': stopped, 'job': copy.deepcopy(job)}

    def cancel(self, task_id, expected_status, note):
        with self.lock:
            if self.active:
                raise ValueError('Crew正在执行一项任务，请先检查并停止原运行。')
            return self.store.cancel(task_id, expected_status, note)


def handler(runner, assets):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, value, mime='application/json; charset=utf-8'):
            content = json.dumps(value, ensure_ascii=False).encode() if not isinstance(value, bytes) else value
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(content)

        def local(self):
            return self.headers.get('Host') in ('127.0.0.1:' + str(self.server.server_port), 'localhost:' + str(self.server.server_port))

        def do_GET(self):
            if not self.local():
                return self.respond(403, {'error': 'Local host required'})
            path = urllib.parse.urlsplit(self.path).path
            if path == '/api/board':
                return self.respond(200, runner.view())
            if path == '/api/lead-runs':
                try:
                    return self.respond(200, {'runs': read_runs()})
                except OSError as error:
                    return self.respond(503, {'error': '负责人运行登记暂不可读：' + str(error)})
            if path.startswith('/api/receipt/'):
                name = path.rsplit('/', 1)[-1]
                job = next((j for j in runner.jobs if j['id'] == name), None)
                return self.respond(200, job) if job else self.respond(404, {'error': 'Unknown receipt'})
            name = {'/': 'task-board.html', '/task-board.js': 'task-board.js', '/task-board.css': 'task-board.css'}.get(path)
            if name:
                content = (assets / name).read_bytes()
                if path == '/':
                    # 只挂入负责人只读区块，原任务页面和派发脚本保持独立。
                    extra = Path(__file__).resolve().parent
                    content = content.replace(b'</head>', b'<link rel="stylesheet" href="/lead-runs.css"><script defer src="/lead-runs.js"></script></head>')
                    content = content.replace(b'<footer>', (extra / 'lead-runs.html').read_bytes() + b'<footer>')
                return self.respond(200, content, mimetypes.guess_type(name)[0] + '; charset=utf-8')
            if path in ('/lead-runs.js', '/lead-runs.css'):
                content = (Path(__file__).resolve().parent / path[1:]).read_bytes()
                return self.respond(200, content, mimetypes.guess_type(path)[0] + '; charset=utf-8')
            return self.respond(404, {'error': 'Not found'})

        def do_POST(self):
            origin = self.headers.get('Origin')
            if not self.local() or self.headers.get('x-corpus') != '1' or (origin and origin not in ('http://127.0.0.1:' + str(self.server.server_port), 'http://localhost:' + str(self.server.server_port))):
                return self.respond(403, {'error': 'Same-origin request required'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 16000:
                    raise ValueError('Invalid request size')
                body = json.loads(self.rfile.read(length))
                if self.path == '/api/dispatch':
                    result = runner.dispatch(body.get('task_id'), body.get('access'), body.get('goal'))
                elif self.path == '/api/stop':
                    result = runner.stop(body.get('job_id'))
                elif self.path == '/api/reconcile':
                    result = runner.reconcile(body.get('job_id'), confirm_ended=body.get('confirm_ended', False))
                elif self.path == '/api/tasks/cancel':
                    result = runner.cancel(body.get('task_id'), body.get('expected_status'), body.get('note', body.get('reason')))
                else:
                    return self.respond(404, {'error': 'Not found'})
                self.respond(200, result)
            except (ValueError, TypeError, KeyError) as error:
                self.respond(400, {'error': str(error)})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--crew-url', default='http://127.0.0.1:4192')
    parser.add_argument('--port', type=int, default=6480)
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.crew_url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost'):
        parser.error('crew-url must be a local HTTP service')
    store = BoardStore(args.workspace, args.manifest)
    assets = Path(__file__).resolve().parents[2] / 'web'
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(Runner(store, args.crew_url), assets))
    print('Task board: http://127.0.0.1:' + str(args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == '__main__':
    main()
