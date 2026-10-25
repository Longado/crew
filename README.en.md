<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img alt="Crew" src="docs/logo-light.png" width="420">
  </picture>
</p>

# Crew

**Turn material into action: material + current projects → sourced suggestions → individual decisions → export accepted actions.**

The interview discusses adding sources and applicable versions to a release-note draft, while explicitly deferring automatic publishing. Crew puts source quotes and project context beside each suggestion. Accept “check the release notes,” leave the recommendation to defer automatic publishing pending, then export the accepted next step.

[简体中文](README.md) · [Intake guide (Chinese)](docs/INTAKE.md) · [0.3.0 release notes](docs/releases/0.3.0.md) · MIT · **Alpha**

## Try the preset example

Requires **Python 3.9+, Git and macOS/Linux**. No Node/npm, model account or private database required.

```sh
git clone https://github.com/Longado/crew
cd crew
./bin/crew intake demo
```

This local demo uses synthetic material and preset analysis; it does not call a model. A1 checks release-note sources and applicable versions; A2 recommends deferring automatic publishing. This demonstrates the workflow, not model quality.

Review, accept one suggestion, and export:

```sh
CREW_CARD="$(./bin/crew intake demo --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["cards"][0]["json"])')"
./bin/crew intake review "$CREW_CARD"
./bin/crew intake review "$CREW_CARD" --action A1 --decision accept --note 'For the next discussion'
./bin/crew intake export "$CREW_CARD"
```

New suggestions start as `pending`. Use `--decision defer` or `--decision dismiss` for other choices. Decisions retain history; rerunning the demo keeps your choices. Export contains only accepted suggestions for the current card, with their sources. **Accepted does not mean executed.** Add `--format json` for JSON output.

## Your material and projects

Inspect the bundled synthetic inputs first:

```sh
./bin/crew intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --dry-run
```

Create a project JSON file using the [catalog contract](docs/INTAKE.md#项目依据), then replace the material, `--workspace` and `--catalog` paths with your own. Project paths resolve against `--workspace`, not the catalog file. Current project handoffs or documentation provide context. Existing task databases remain a compatibility option through `--database`; they are not required.

Minimal catalog shape: `id` is a unique positive integer; `name` and `path` are required. `description` is optional; `status` defaults to `active` and also accepts `paused`.

```json
{"version":1,"projects":[{"id":1,"name":"Release notes","description":"Draft release notes with sources","path":"projects/release-notes","status":"active"}]}
```

Remove `--dry-run` for real analysis. This requires **Claude Code installed and signed in with a subscription account**. Material and candidate project excerpts are sent to that service. Intake does not use an API key; Claude Code's own installation requirements apply.

Inputs are UTF-8 `.txt`/`.md`; directory scans are nonrecursive. Convert PDF, audio and video to text first. Prompts and cards are currently mainly Simplified Chinese. Valid citations do not establish that a speaker is correct or a suggestion is useful.

## Storage and limits

Real results default to `~/.local-sensitive/crew-intake/`; demo results to `~/.local-sensitive/crew-intake-demo/`. Use `--output` for another private local directory. Snapshots, caches, cards, decisions and run records are stored there; manage permissions and backups yourself. Originals stay unchanged. Accepting a suggestion only affects export: it does not create tasks, change projects, send messages or execute actions. Real analysis uses the remote Claude service.

**0.3.0 remains an early Alpha.** No inbox watcher, PDF/audio/video parser or intake web interface is included. Start with synthetic material before deciding what to send. See the [intake guide](docs/INTAKE.md) for the full scope.

## Existing workbench and project view

Crew retains its local terminal workbench, conversation-based project view, lead mode and housekeeper. The optional full installation requires Node 22.18+:

```sh
npm ci
npm link
crew demo
crew app
```

The [legacy project-view demo](https://longado.github.io/crew/) is a read-only bookkeeping-project example. Its pages, recordings and explainer show the project view, not the material-to-action workflow.

[Workbench](docs/CREW.md) · [Team workbench](docs/TEAM-WORKBENCH.md) · [Housekeeper](docs/HOUSEKEEPER.md) · [MCP](docs/MCP.md) · [Claude Code plugin](docs/PLUGIN.md) · [Legacy demo guide](docs/DEMO.md)

## Feedback and contributions

Share a small synthetic example: input, unexpected suggestion, and expected decision or export. Avoid personal material. Open an [issue](https://github.com/Longado/crew/issues) or read [CONTRIBUTING.md](CONTRIBUTING.md) before a PR.

## License

[MIT](LICENSE)
