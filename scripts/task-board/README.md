# Local task board and macOS launcher

The board reads a selected manifest and joins its task IDs with the workspace's existing `.data/tasks.db`. It does not create a second task database. Python's standard library serves the UI and routes execution to the existing Crew API. The first executor is the native Codex team; the manifest's original owner remains visible.

```sh
python3 scripts/task-board/server.py --workspace /path/to/workspace --manifest /path/to/manifest.json --crew-url http://127.0.0.1:4192
python3 scripts/task-board/build-app.py --workspace /path/to/workspace --manifest /path/to/manifest.json --output "$HOME/Applications/Crew Tasks.app"
```

The generated app uses AppKit and WKWebView, and records the current repo, workspace, manifest, Python and Node locations in its local bundle. Moving those directories requires rebuilding the launcher. The app connects to port 6480 and Crew on 4192. Its bootstrap starts missing services, checks an existing board's workspace and manifest, and leaves an existing Crew run alone. Services keep running when the window closes or the app quits; use the run's stop button to stop execution.

Drag a card to the execution area or use its Execute button. Review the goal and choose read-only (default) or an isolated workspace copy. Human steps, paused tasks, missing project paths and ended tasks cannot dispatch. One Crew run executes at a time. Write results require follow-up review; read-only checks preserve the original task's acceptance requirements. DB writes use backups and compare the prior status to avoid overwriting concurrent changes. Local run receipts survive app restarts. A restarted board never silently resumes an orphaned run; inspect it in Crew.

The current daily-manifest integration has one explicit check-only task (sources 15 and 16, Crew line). It requires two bound members and two accepted tasks before marking that check done. Other worklines remain governed by their own acceptance criteria.

## Review isolated changes

Use the standalone CLI for a `workspace-write` receipt. Both commands below **write an archive**, even without `--accept`: the worker copy and isolation baseline are saved beside the receipt under `runs/<job>-worker`, using a temporary name before renaming. The JSON report lists changed, added, deleted and merged files. An existing archive is reused, including after the temporary worker copy disappears.

```sh
python3 -B scripts/task-board/review.py --workspace /path/to/workspace --manifest /path/to/workspace/docs/sample/manifest.json --job sample-job
python3 -B scripts/task-board/review.py --workspace /path/to/workspace --manifest /path/to/workspace/docs/sample/manifest.json --job sample-job --accept
```

`--accept` merges code only; it does not accept the task, update status or notes, or open or back up `.data/tasks.db`. The source must be inside the selected workspace. If any changed source file has changed since isolation, or an added path already exists, the whole merge is refused. Otherwise only changed and added files are copied; deletions are reported but never applied. Diff and merge skip `.git`, `node_modules`, `__pycache__` and symlinks. This command is not connected to a web button or `crew tasks`.

Validation:

```sh
python3 scripts/task-board/test_server.py
node --no-warnings --test tests/task-board-ui.test.ts tests/codex-team-current-events.test.ts tests/codex-team-protocol.test.ts tests/codex-team-native.test.ts
```

The UI tests exercise drag/drop settings and dispatch payloads through a small DOM port; they do not substitute for a real native-window check. Native UI evidence and actual model-run receipts belong beside the selected local manifest, outside this public repo.
