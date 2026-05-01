# Symphony Implementation

This workspace includes a Node.js implementation of the draft OpenAI Symphony service specification.

## Run

Install dependencies:

```bash
bun install
```

Create a workflow:

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

Set required secrets:

```bash
export LINEAR_API_KEY=...
export REPOSITORY_URL=...
```

Validate:

```bash
npm run symphony -- validate --workflow WORKFLOW.md
```

Start:

```bash
npm run symphony -- start --workflow WORKFLOW.md --port 8787
```

Dashboard/API:

```text
http://127.0.0.1:8787/
http://127.0.0.1:8787/api/v1/state
http://127.0.0.1:8787/api/v1/<issue_identifier>
```

## Implemented

- `WORKFLOW.md` discovery, YAML front matter parsing, prompt body extraction.
- Strict Liquid prompt rendering with unknown variables/filters treated as errors.
- Typed config resolution with defaults, `$VAR` secret resolution, `~` and relative workspace path expansion.
- Dynamic workflow reload on file mtime changes, retaining the last known good config on invalid reload.
- Linear tracker adapter for active, terminal, and by-ID issue fetches.
- Normalized issue model with labels, blocker refs, branch name, timestamps, and state.
- In-memory orchestrator state for `running`, `claimed`, retry queue, completed set, token totals, and rate limits.
- Poll loop, reconciliation, candidate sorting, global/per-state concurrency, Todo blocker gate.
- Exponential retry backoff and one-second continuation retry after successful runs.
- Successful issues are not continued by default; set `agent.continue_after_success: true` to enable the spec's continuation retry behavior.
- Per-issue workspace isolation with sanitized directory names.
- Workspace hooks: `after_create`, `before_run`, `after_run`, `before_remove`.
- Codex app-server JSON-RPC stdio adapter using `initialize`, `thread/start`, and `turn/start`.
- Codex threads default to `danger-full-access` with turn policy `{ type: "dangerFullAccess" }`. Use this only when issue workspaces are treated as disposable sandboxes.
- Structured JSON logs.
- Optional loopback HTTP dashboard and `/api/v1/*` JSON API.

## Implementation-Defined Policy

- Workspace population is delegated to hooks. The service only creates/reuses per-issue directories.
- The default trust posture is non-interactive. App-server approval/input requests are denied by the adapter unless Codex config avoids generating them.
- Ticket writes are not built into Symphony. Agents should update Linear through their own configured tools/workflow.
- The optional HTTP server binds to `127.0.0.1`.
- Listener port changes require restart.
- Existing workspaces are not destructively reset on reuse.

## Known Boundaries

- The service targets Linear project filtering by `project_slug` using Linear GraphQL.
- Codex runs one turn per worker session. `agent.continue_after_success: true` schedules a one-second continuation retry if the issue remains active; the default is `false` to avoid repeated duplicate work when the agent cannot update Linear state.
- Exact Codex sandbox/approval values are passed through to the installed Codex app-server.
