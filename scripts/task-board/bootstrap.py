"""Start the configured local services for the native app; never take over a port."""
import json, pathlib, subprocess, sys, time, urllib.request

config=json.loads(pathlib.Path(sys.argv[1]).read_text())
repo=pathlib.Path(config['repo'])

def get(port,path):
    try:
        with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=2) as r:
            return json.load(r)
    except Exception:
        return None

if not get(4192,'/api/state'):
    subprocess.run([config['node'],'--no-warnings',str(repo/'src/cli.ts'),'open',str(pathlib.Path(config['manifest']).parent),'--port','4192','--no-open'],cwd=repo,check=True,timeout=25)
board=get(6480,'/api/board')
if board and (board.get('workspace')!=config['workspace'] or board.get('manifest')!=config['manifest']):
    raise SystemExit('6480端口正在服务另一份看板，请先检查原运行。')
if not board:
    logs=pathlib.Path.home()/'Library/Logs/Crew Tasks'; logs.mkdir(parents=True,exist_ok=True)
    with (logs/'board.log').open('ab') as log:
        process=subprocess.Popen([config['python'],str(repo/'scripts/task-board/server.py'),'--workspace',config['workspace'],'--manifest',config['manifest']],cwd=repo,stdout=log,stderr=log,start_new_session=True)
    for _ in range(50):
        if get(6480,'/api/board'): break
        if process.poll() is not None: raise SystemExit('任务看板没有启动，请查看 ~/Library/Logs/Crew Tasks/board.log')
        time.sleep(.2)
    else: raise SystemExit('任务看板启动超时，请查看本地日志。')
print('http://127.0.0.1:6480/')
