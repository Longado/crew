<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img alt="Crew" src="docs/logo-light.png" width="420">
  </picture>
</p>

<p align="center"><strong>A local agent workbench: keep a project's context, task cards and acceptance in one place, and hand the work to Codex or Claude.</strong></p>
<p align="center">For people pushing one project forward with Codex, Claude Code and web AI at the same time.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT"></a>
  <img src="https://img.shields.io/badge/tested%20on-macOS-black" alt="tested on macOS">
  <img src="https://img.shields.io/badge/Node-22.18%2B-green" alt="Node 22.18+">
  <img src="https://img.shields.io/badge/Python-3.9%2B-green" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/status-Alpha-orange" alt="Alpha">
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="https://longado.github.io/crew/">Live demo</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#build-with-us">Build with us</a>
</p>

When one project runs on several AIs, the discussion lives in Claude Code, the execution in Codex, and the conclusions in scattered chat logs. Crew puts them back on one local workbench: a lead splits the work into task cards, Crew dispatches them by dependency, workers return sourced results, and only accepted work unlocks the next step.

**Runs on your machine · Read-only dispatch by default · Next step only after acceptance**

## What it is

Crew does three things:

- **Shows the project as it stands.** It gathers project conversations, plans, decisions and task evidence, separates done, awaiting verification and blocked, and prepares handoff context for the next agent.
- **Orchestrates agent tasks.** In lead mode you split a goal into task cards with dependencies and writable scope; Crew dispatches them to Codex, with Claude available as a read-only worker. Independent cards run in parallel; returned work can be checked, or rejected and continued, and dependent cards start only after acceptance. It works from any terminal, including Orca.
- **Turns material into discussable next steps.** Meeting notes, interviews or research notes are compared against current projects, producing suggestions with source quotes and project evidence. You accept, defer or dismiss each one, then export the chosen suggestions.

> **Early release (0.3.0 Alpha).** Lead mode has been used for the author's own multi-round development and research orchestration. Real interaction with the Claude worker and the native credential housekeeper is not fully verified, and there are no external user results yet. Progress is tracked in the [handoff log (Chinese)](docs/HANDOFF.md).

## Screenshots

All screenshots use sample data; no real tasks were dispatched.

<p align="center"><img src="docs/media/crew-project-overview.jpg" alt="Project view: task states, where work last stopped, items needing you and next steps for a sample bookkeeping project" width="860"></p>
<p align="center"><sub>Project view: the sample bookkeeping project in the <a href="https://longado.github.io/crew/">live demo</a>, with task states, where work last stopped and next steps.</sub></p>

<p align="center"><img src="docs/media/crew-task-board.jpg" alt="Task board: runnable tasks listed apart from tasks waiting on you" width="860"></p>
<p align="center"><sub>Task board: runnable tasks are kept apart from tasks waiting on you. This one is a static page with sample data.</sub></p>

<p align="center"><img src="docs/media/crew-execution-settings.jpg" alt="Execution settings: choose read-only check or isolated modification before dispatch" width="860"></p>
<p align="center"><sub>Execution settings: choose read-only check or isolated modification before dispatch; read-only is the default.</sub></p>

## How orchestration works

Lead writes task cards → Crew dispatches by dependency → Codex executes → check and accept → move to the next step.

| You | Crew |
|---|---|
| Write task cards in the run directory's `cards/`, first line `依赖：t1` (depends on t1) | `crew worker run` dispatches only cards whose dependencies are accepted; independent cards run in parallel and the command returns at once |
| Wait for results | `crew worker wait` returns when a card comes back or looks stuck, with progress |
| Check the delivery | `crew worker check` matches each `/absolute/path:line` citation against the source |
| Accept | Refused if a citation does not match; on success, dispatches the downstream cards this acceptance unlocks |
| Reject | `--retry` continues the original session instead of starting over |
| Need file changes | Declare writable paths in the card header and pass `--write` explicitly; the Claude worker is read-only |

The full rules (card headers, continuation, `watch`/`pause`, cross-run dependencies) are printed by `crew worker guide` (Chinese) and maintained alongside the commands. See also the [workbench guide (Chinese)](docs/CREW.md#负责人模式claude-code-拆卡codexclaude-执行者干活).

## Things to try

None of these call a model.

| Try | What you see |
|---|---|
| `crew team --demo` | The terminal team view: members, question Q1, approval A1, all simulated; `/quit` to exit |
| `crew demo`, then `crew show --project <id>` as printed | A sample bookkeeping project: six tasks with states, blockers and next steps |
| `crew app` | Opens the local workbench in its own window; `crew stop` stops the background service |
| `crew worker guide` | The full guide to task cards, dispatch and acceptance |
| `./bin/crew intake demo` | The material flow: one sourced suggestion card with A1 and A2 awaiting your decision; Python only |

## Quick start

Requires macOS (on Linux only the material-flow tests have run), Git, Node 22.18+ and Python 3.9+. Real dispatch needs Codex or Claude Code installed and signed in; model processing uses those services, and an open-source license does not make them free.

### Option A: let your AI install it

Paste this into Claude Code or Codex:

```text
Install Crew (https://github.com/Longado/crew) on this machine.
1. Read the repository README.md first to see what it does and needs.
2. Check that node -v is at least 22.18 and python3 --version is at least 3.9; if not, tell me instead of upgrading anything.
3. Clone it into the directory I name, then run npm ci and npm link.
4. Run crew team --demo so I can see the terminal team demo, then run crew worker guide and explain how to write task cards.
5. Remind me: real dispatch needs Codex or Claude Code signed in; dispatch is read-only by default and file changes need my explicit --write.
```

### Option B: install it yourself

```sh
git clone https://github.com/Longado/crew && cd crew
npm ci
npm link          # makes the crew command available
crew app          # opens the local workbench
crew worker guide # task cards, dispatch and acceptance
```

To try only the material flow, without Node:

```sh
git clone https://github.com/Longado/crew && cd crew
./bin/crew intake demo
```

Claude Code plugin: run `/plugin marketplace add Longado/crew` inside Claude Code, then follow the [plugin guide](docs/PLUGIN.md).

## Material to action

The interview discusses adding sources and applicable versions to a release-note draft, while explicitly deferring automatic publishing. Crew puts source quotes and project context beside each suggestion. Accept “check the release notes,” leave the recommendation to defer automatic publishing pending, then export the accepted next step.

### Try the preset example

Requires only **Python 3.9+, Git and macOS/Linux**; no Node/npm, model account or private database. `./bin/crew intake demo` uses synthetic material and preset analysis and does not call a model, so it demonstrates the workflow, not model quality. Review, accept one suggestion, and export:

```sh
CREW_CARD="$(./bin/crew intake demo --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["cards"][0]["json"])')"
./bin/crew intake review "$CREW_CARD"
./bin/crew intake review "$CREW_CARD" --action A1 --decision accept --note 'For the next discussion'
./bin/crew intake export "$CREW_CARD"
```

New suggestions start as `pending`. Use `--decision defer` or `--decision dismiss` for other choices. Decisions retain history; rerunning the demo keeps your choices. Export contains only accepted suggestions for the current card, with their sources. **Accepted does not mean executed.** Add `--format json` for JSON output.

### Your material and projects

Inspect the bundled synthetic inputs first:

```sh
./bin/crew intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --dry-run
```

Create a project JSON file using the [catalog contract](docs/INTAKE.md#项目依据), then replace the material, `--workspace` and `--catalog` paths with your own. Project paths resolve against `--workspace`, not the catalog file. Current project handoffs or documentation provide context. Existing task databases remain a compatibility option through `--database`; they are not required.

Minimal catalog shape: `id` is a unique positive integer; `name` and `path` are required. `description` is optional; `status` defaults to `active` and also accepts `paused`.

```json
{"version":1,"projects":[{"id":1,"name":"Release notes","description":"Draft release notes with sources","path":"projects/release-notes","status":"active"}]}
```

Remove `--dry-run` for real analysis. This requires **Claude Code installed and signed in with a subscription account**. Material and candidate project excerpts are sent to that service. Intake does not use an API key.

Inputs are UTF-8 `.txt`/`.md`; directory scans are nonrecursive. Convert PDF, audio and video to text first. Prompts and cards are currently mainly Simplified Chinese. Valid citations do not establish that a speaker is correct or a suggestion is useful. Accepted suggestions currently need to be scheduled separately; accepting does not create or dispatch tasks. See the [intake guide (Chinese)](docs/INTAKE.md).

## Storage and limits

- Workbench data lives in `~/.working-corpus` by default (override with `CORPUS_HOME`); lead-mode task cards, deliveries and acceptance records stay in the run directory you choose.
- Real intake results default to `~/.local-sensitive/crew-intake/`, demo results to `~/.local-sensitive/crew-intake-demo/`; use `--output` for another private local directory. Snapshots, caches, cards, decisions and run records are stored there; manage permissions and backups yourself.
- Dispatch is read-only by default; file changes require writable paths in the card header and an explicit `--write`. Crew does not take over existing Orca or native terminal sessions.
- Real dispatch and real analysis use the remote Codex/Claude services; not all processing happens on your machine.
- No inbox watcher, PDF/audio/video parser or intake web interface is included.

[Workbench](docs/CREW.md) · [Team workbench](docs/TEAM-WORKBENCH.md) · [Housekeeper](docs/HOUSEKEEPER.md) · [MCP](docs/MCP.md) · [Claude Code plugin](docs/PLUGIN.md) · [Legacy demo guide](docs/DEMO.md) · [0.3.0 release notes](docs/releases/0.3.0.md)

## Build with us

**When several AIs work on one project, how can a person decide only at the points that matter without losing context?**

| If you like… | You could contribute |
|---|---|
| Workflow design | How accepted material suggestions flow back into task cards (today accepting only exports) |
| File processing | Converting PDF, audio and video to text for the material flow |
| Claude Code / Codex | A real run with the Claude worker, reporting where it breaks |
| Terminal UI | Packaging the terminal team as a terminal plugin (a direction, not built yet) |
| Linux | Running the full workbench on Linux and reporting issues |

The most useful feedback is one concrete run: how you split the tasks, where things failed to connect, and which delivery was not yet worth accepting. Please use examples without personal material. Issues and pull requests are welcome via [GitHub Issues](https://github.com/Longado/crew/issues); read [CONTRIBUTING.md](CONTRIBUTING.md) before a PR.

## Development

```sh
npm ci
npm run typecheck
npm test                                                        # starts local processes and browsers; prefer an isolated environment
python3 scripts/lead/run_tests.py                               # lead mode
python3 -B -m unittest discover -s scripts/intake -p 'test_*.py' # material flow
```

## License

[MIT](LICENSE)
