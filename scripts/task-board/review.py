"""Review and accept the files a workspace-write Crew run left in its isolated copy.

  python3 scripts/task-board/review.py --workspace WS --manifest M --job JOB_ID [--accept]

Review archives the worker copy beside the run receipt (the original lives in the system
temporary directory and can be cleaned), then lists changed/added/deleted files against the
isolation baseline. --accept copies changed and added files into the source project only if
none of the touched source paths moved since isolation; any conflict refuses the whole merge.
Review without --accept still writes the archive; it is not a read-only operation.
Deletions are reported, never applied. --accept merges code only; it does not accept tasks,
update task status or notes, or open or back up the task database.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

SKIP = {'.git', 'node_modules', '__pycache__'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files_under(root):
    found = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(part in SKIP for part in rel.parts) or not path.is_file() or path.is_symlink():
            continue
        found[rel.as_posix()] = digest(path)
    return found


def load(workspace, manifest, job_id):
    runs = Path(manifest).resolve().parent / 'runs'
    receipt_path = runs / f'{job_id}.json'
    if not receipt_path.is_file():
        raise ValueError(f'找不到运行回执:{receipt_path}')
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    if receipt.get('access') != 'workspace-write':
        raise ValueError('只有隔离修改的运行才有成果可审阅。')
    run = (receipt.get('snapshot') or {}).get('run') or {}
    archive = runs / f'{job_id}-worker'
    if not archive.is_dir():
        if not run.get('workerCwd') or not run.get('baselinePath'):
            raise ValueError('回执未记录隔离副本或基线位置;成果不可用。')
        worker, baseline = Path(run['workerCwd']), Path(run['baselinePath'])
        if not worker.is_dir() or not baseline.is_file():
            raise ValueError('隔离副本已不存在,且之前没有存档;成果无法找回。')
        # Copy to a temporary name first so a half-written archive is never mistaken for a complete one.
        partial = runs / f'{job_id}-worker.partial'
        shutil.rmtree(partial, ignore_errors=True)
        shutil.copytree(worker, partial / 'workspace', symlinks=True)
        shutil.copy2(baseline, partial / 'baseline.json')
        partial.rename(archive)
    base = json.loads((archive / 'baseline.json').read_text(encoding='utf-8'))
    return receipt, archive, base


def check_targets(source, paths):
    unsafe = []
    root = source.resolve()
    for relative in paths:
        target = source
        linked = target.is_symlink()
        for part in Path(relative).parts:
            target = target / part
            linked = linked or target.is_symlink()
        # is_symlink also detects dangling links, before is_file/exists/digest can follow them.
        if linked or not target.resolve().is_relative_to(root):
            unsafe.append(relative)
    if unsafe:
        raise ValueError('目标路径含符号链接或越出来源根,整批拒绝合并:' + ', '.join(sorted(unsafe)))


def review(workspace, manifest, job_id, accept=False):
    workspace = Path(workspace).resolve()
    receipt, archive, base = load(workspace, manifest, job_id)
    source = Path(base['source']).absolute()
    if not source.resolve().is_relative_to(workspace):
        raise ValueError('隔离来源不在当前工作区内,拒绝合并。')
    before = {f['path']: f['sha256'] for f in base['files']}
    after = files_under(archive / 'workspace')
    changed = sorted(p for p in after if p in before and after[p] != before[p])
    added = sorted(p for p in after if p not in before)
    deleted = sorted(p for p in before if p not in after and not any(part in SKIP for part in Path(p).parts))
    report = {'job': job_id, 'task_id': receipt.get('task_id'), 'source': str(source.resolve()), 'archive': str(archive),
              'changed': changed, 'added': added, 'deleted': deleted, 'merged': []}
    if not accept:
        return report
    merged = sorted(changed + added)
    check_targets(source, merged)
    conflicts = [p for p in changed if not (source / p).is_file() or digest(source / p) != before[p]]
    conflicts += [p for p in added if (source / p).exists()]
    if conflicts:
        raise ValueError('源项目在隔离之后已有改动,整批拒绝合并:' + ', '.join(sorted(conflicts)))
    check_targets(source, merged)
    for p in merged:
        target = source / p
        target.parent.mkdir(parents=True, exist_ok=True)
        check_targets(source, [p])
        shutil.copy2(archive / 'workspace' / p, target)
    report['merged'] = merged
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--job', required=True)
    parser.add_argument('--accept', action='store_true')
    args = parser.parse_args()
    print(json.dumps(review(args.workspace, args.manifest, args.job, args.accept), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
