# Local task board and macOS launcher

The board reads a selected manifest and joins its task IDs with the workspace's existing `.data/tasks.db`. It does not create a second task database. Python's standard library serves the UI and routes execution to the existing Crew API. The first executor is the native Codex team; the manifest's original owner remains visible.

```sh
python3 scripts/task-board/server.py --workspace /path/to/workspace --manifest /path/to/manifest.json --crew-url http://127.0.0.1:4192
python3 scripts/task-board/build-app.py --workspace /path/to/workspace --manifest /path/to/manifest.json --output "$HOME/Applications/Crew Tasks.app"
```

The generated app uses AppKit and WKWebView, and records the current repo, workspace, manifest, Python and Node locations in its local bundle. Moving those directories requires rebuilding the launcher. The app connects to port 6480 and Crew on 4192. Its bootstrap starts missing services, checks an existing board's workspace and manifest, and leaves an existing Crew run alone. Services keep running when the window closes or the app quits; use the run's stop button to stop execution.

Drag a card to the execution area or use its Execute button. Review the goal and choose read-only (default) or an isolated workspace copy. Human steps, paused tasks, missing project paths and ended tasks cannot dispatch. One Crew run executes at a time. Write results require follow-up review; read-only checks preserve the original task's acceptance requirements. DB writes use backups and compare the prior status to avoid overwriting concurrent changes. Local run receipts survive app restarts. A restarted board never silently resumes an orphaned run; inspect it in Crew.

The current daily-manifest integration has one explicit check-only task (sources 15 and 16, Crew line). It requires two bound members and two accepted tasks before marking that check done. Other worklines remain governed by their own acceptance criteria.

Validation:

```sh
python3 scripts/task-board/test_server.py
node --no-warnings --test tests/task-board-ui.test.ts tests/codex-team-current-events.test.ts tests/codex-team-protocol.test.ts tests/codex-team-native.test.ts
```

The UI tests exercise drag/drop settings and dispatch payloads through a small DOM port; they do not substitute for a real native-window check. Native UI evidence and actual model-run receipts belong beside the selected local manifest, outside this public repo.
