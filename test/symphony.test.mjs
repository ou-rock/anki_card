import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflowSource, loadWorkflow, renderPrompt } from "../symphony/lib/workflow.mjs";
import { resolveConfig, validateDispatchConfig } from "../symphony/lib/config.mjs";
import { workspaceKey, WorkspaceManager } from "../symphony/lib/workspace.mjs";
import { Orchestrator, sortForDispatch } from "../symphony/lib/orchestrator.mjs";

test("workflow parser splits YAML front matter and prompt", () => {
  const workflow = parseWorkflowSource(`---
tracker:
  kind: linear
---
Hello {{ issue.identifier }}
`);
  assert.equal(workflow.config.tracker.kind, "linear");
  assert.equal(workflow.prompt_template, "Hello {{ issue.identifier }}");
});

test("workflow parser rejects non-map front matter", () => {
  assert.throws(() => parseWorkflowSource("---\n- bad\n---\nbody"), /front matter must decode to an object/);
});

test("config resolves env secrets and relative workspace roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "symphony-test-"));
  const path = join(dir, "WORKFLOW.md");
  await writeFile(path, `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: demo
workspace:
  root: ./work
---
Prompt
`);
  const workflow = await loadWorkflow(path);
  const config = resolveConfig(workflow, { LINEAR_API_KEY: "secret" });
  validateDispatchConfig(config);
  assert.equal(config.tracker.api_key, "secret");
  assert.equal(config.workspace.root, join(dir, "work"));
  await rm(dir, { recursive: true, force: true });
});

test("strict prompt rendering fails unknown variables", async () => {
  await assert.rejects(() => renderPrompt("{{ issue.missing.deep }}", { identifier: "ABC-1" }), /Prompt render failed/);
});

test("workspace keys replace unsafe characters", () => {
  assert.equal(workspaceKey("软考·信息知识 ABC-1"), "________ABC-1");
});

test("workspace manager creates and reuses deterministic paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "symphony-workspace-"));
  const manager = new WorkspaceManager({ workspace: { root }, hooks: { timeout_ms: 1000 } });
  const first = await manager.createForIssue("ABC-1");
  const second = await manager.createForIssue("ABC-1");
  assert.equal(first.path, second.path);
  assert.equal(first.created_now, true);
  assert.equal(second.created_now, false);
  await rm(root, { recursive: true, force: true });
});

test("dispatch sorting follows priority, creation time, identifier", () => {
  const sorted = sortForDispatch([
    { identifier: "B-2", priority: null, created_at: "2026-01-01" },
    { identifier: "A-2", priority: 2, created_at: "2026-01-02" },
    { identifier: "A-1", priority: 1, created_at: "2026-01-03" },
    { identifier: "A-0", priority: 1, created_at: "2026-01-01" },
  ]);
  assert.deepEqual(sorted.map((issue) => issue.identifier), ["A-0", "A-1", "A-2", "B-2"]);
});

test("orchestrator does not dispatch Todo issues with active blockers", () => {
  const runtime = { config: null };
  const orchestrator = new Orchestrator(runtime, { info() {}, warn() {}, error() {}, debug() {} });
  const config = {
    tracker: {
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    agent: {
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
    },
  };
  const issue = {
    id: "1",
    identifier: "ABC-1",
    title: "Blocked",
    state: "Todo",
    blocked_by: [{ state: "In Progress" }],
  };
  assert.equal(orchestrator.shouldDispatch(issue, config), false);
});
