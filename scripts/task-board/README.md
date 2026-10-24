# Local task board and macOS launcher

The board reads a selected manifest and joins its task IDs with the workspace's existing `.data/tasks.db`. It does not create a second task database. Python's standard library serves the UI and routes execution to the existing Crew API. The first executor is the native Codex team; the manifest's original owner remains visible.

```sh
python3 scripts/task-board/server.py --workspace /path/to/workspace --manifest /path/to/manifest.json --crew-url http://127.0.0.1:4192
python3 scripts/task-board/build-app.py --workspace /path/to/workspace --manifest /path/to/manifest.json --output "$HOME/Applications/Crew Tasks.app"
```

The generated app uses AppKit and WKWebView, and records the current repo, workspace, manifest, Python and Node locations in its local bundle. Moving those directories requires rebuilding the launcher. The app connects to port 6480 and Crew on 4192. Its bootstrap starts missing services, checks an existing board's workspace and manifest, and leaves an existing Crew run alone. Services keep running when the window closes or the app quits; use the run's stop button to stop execution.

Drag a card to the execution area or use its Execute button. Review the goal and choose read-only (default) or an isolated workspace copy. Human steps, missing project paths and ended tasks cannot dispatch. One Crew run executes at a time. Write results require follow-up review; read-only checks preserve the original task's acceptance requirements. DB writes use backups and compare the prior status to avoid overwriting concurrent changes. Local run receipts survive app restarts. A restarted board marks unfinished receipts as requiring reconciliation; it never silently resumes them or assumes they have ended.

The current daily-manifest integration has one explicit check-only task (sources 15 and 16, Crew line). It requires two bound members and two accepted tasks before marking that check done. Other worklines remain governed by their own acceptance criteria.

## Stop the original run

The board sends its receipt's `job_id` to `/api/stop`. The server retrieves that receipt's original Crew run ID and sends both `projectId` and `runId` to `/api/team/stop`; it does not stop whichever run happens to be current in the project. A missing run ID or mismatched response prevents stop confirmation. “Stop requested” is not “stopped”: the receipt records confirmation only when the matching response reports `status: stopped`.

## Reconcile after a restart

Unfinished receipts become `recovery_required` (“待重新核对”) after a board restart, initially with stopping disabled. Use the card's “重新核对” action (`/api/reconcile`, with `job_id`) to check the original run. If Crew explicitly rejected the start and its current snapshot shows no run, the task is settled as blocked right away instead of waiting for a check. The board sends its receipt ID as `clientRequestId` with the start request, and Crew records it on the run; when the start result is unknown (timeout, dropped connection), checking queries the current team snapshot and claims the run by that ID, recovering the run ID and the isolated copy location. Older snapshots without the ID follow the previous rules, except that no run after an unknown start leaves the receipt unresolved: Crew may have restarted, so check the workbench or isolated copy directory before using “确认原运行已结束”. An unreachable Crew service, or a run that cannot be tied to this receipt, leaves the receipt unresolved and does not settle the task; an unresolved receipt then offers “确认原运行已结束” (`/api/reconcile` with `confirm_ended: true`), a two-step in-page confirmation (click once to show the note, click again within five seconds; clicking elsewhere cancels). Before settling, the board queries Crew again and refuses while the original run is still starting or running. Confirming keeps the outputs and settles the task as blocked, noting that Crew did not confirm it. It never accepts or merges results. A matching live run enables stopping that original run or checking again. Only a matching run with `status: stopped` can be settled; a completed leader alone is insufficient.

Reconciliation preserves results and checks for a newer receipt or a task status changed by another operation before writing back. Those newer changes are kept. If task writeback fails, the receipt remains available for another reconciliation attempt. None of these steps redispatches the task automatically.

## Review isolated changes

Use the standalone CLI for a `workspace-write` receipt. Both commands below **write an archive**, even without `--accept`: the worker copy and isolation baseline are saved beside the receipt under `runs/<job>-worker`, using a temporary name before renaming. The JSON report lists changed, added, deleted and merged files. An existing archive is reused, including after the temporary worker copy disappears.

```sh
python3 -B scripts/task-board/review.py --workspace /path/to/workspace --manifest /path/to/workspace/docs/sample/manifest.json --job sample-job
python3 -B scripts/task-board/review.py --workspace /path/to/workspace --manifest /path/to/workspace/docs/sample/manifest.json --job sample-job --accept
```

`--accept` merges code only; it does not accept the task, update status or notes, or open or back up `.data/tasks.db`. The source must be inside the selected workspace. If any changed source file has changed since isolation, or an added path already exists, the whole merge is refused. Otherwise only changed and added files are copied; deletions are reported but never applied. Diff and merge skip `.git`, `node_modules`, `__pycache__` and symlinks. If any level of a target path in the source project is a symlink (including a dangling one), the whole merge is refused; targets are checked again right before copying. This command is not connected to a web button or `crew tasks`.

Validation (the first command is the shared entry point: it runs every board test and the lead-mode tests, with a temporary registry and a fake Codex):

```sh
python3 scripts/lead/run_tests.py
node --no-warnings --test tests/task-board-ui.test.ts tests/codex-team-current-events.test.ts tests/codex-team-protocol.test.ts tests/codex-team-native.test.ts
```

The UI tests exercise drag/drop settings and dispatch payloads through a small DOM port; they do not substitute for a real native-window check. Native UI evidence and actual model-run receipts belong beside the selected local manifest, outside this public repo.
