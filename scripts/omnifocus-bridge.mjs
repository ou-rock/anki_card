import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.OMNIFOCUS_BRIDGE_PORT || 3479);
const STATE_PATH = process.env.OMNIFOCUS_BRIDGE_STATE || join(homedir(), ".anki-card-studio", "omnifocus-sync.json");
const COMMAND_TIMEOUT_MS = Number(process.env.OMNIFOCUS_COMMAND_TIMEOUT_MS || 20000);
const managedNote = "Managed by Anki Card Studio";

function bridgeEnv() {
  return {
    ...process.env,
    PATH: `${join(homedir(), ".bun", "bin")}:${process.env.PATH || ""}`,
  };
}

async function runOf(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("of", args, {
      env: bridgeEnv(),
      maxBuffer: 1024 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return { args, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error('OmniFocus CLI "of" was not found. Run: export PATH="$HOME/.bun/bin:$PATH" && bun install -g @stephendolan/omnifocus-cli');
    }
    if (error.killed && error.signal === "SIGTERM") {
      throw new Error(`OmniFocus CLI timed out after ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s. Check OmniFocus automation permissions and whether the app is responding.`);
    }
    const parsedError = parseOfError(error.stdout) || parseOfError(error.stderr);
    if (options.allowFailure) {
      return {
        args,
        stdout: String(error.stdout || "").trim(),
        stderr: String(error.stderr || error.message || "").trim(),
        error: parsedError,
        failed: true,
      };
    }
    const message = parsedError || String(error.stderr || error.stdout || error.message || "of command failed").trim();
    throw new Error(message);
  }
}

function parseOfError(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.detail || parsed?.error?.message || parsed?.error || null;
  } catch {
    return null;
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseTaskId(output) {
  const text = String(output || "");
  try {
    const parsed = JSON.parse(text);
    return parsed.id || parsed.taskId || parsed.primaryKey || parsed.uuid || null;
  } catch {
    // Fall through to text patterns.
  }
  return (
    text.match(/\b(?:id|ID)\s*[:=]\s*([A-Za-z0-9:_-]+)/)?.[1]
    || text.match(/\b([0-9a-f]{8}-[0-9a-f-]{27,})\b/i)?.[1]
    || null
  );
}

async function parseJsonCommand(args) {
  const result = await runOf(args);
  try {
    return JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(`Could not parse JSON from: of ${args.join(" ")}`);
  }
}

async function ensureProject(projectName) {
  const projects = await parseJsonCommand(["project", "list"]);
  const existing = Array.isArray(projects) ? projects.find((project) => project.name === projectName) : null;
  if (existing) {
    return { id: existing.id, name: existing.name, reused: true };
  }

  const created = await parseJsonCommand(["project", "create", projectName, "--sequential", "--note", managedNote]);
  return { id: created.id, name: created.name || projectName, reused: false };
}

async function ensureTag(tagName) {
  const tags = await parseJsonCommand(["tag", "list"]);
  const existing = Array.isArray(tags) ? tags.find((tag) => tag.name === tagName) : null;
  if (existing) {
    return { id: existing.id, name: existing.name, reused: true };
  }

  const created = await parseJsonCommand(["tag", "create", tagName]);
  return { id: created.id, name: created.name || tagName, reused: false };
}

async function taskExists(taskId) {
  if (!taskId) return false;
  try {
    await parseJsonCommand(["task", "view", taskId]);
    return true;
  } catch (error) {
    if (String(error.message || "").includes("Task not found")) return false;
    throw error;
  }
}

async function syncPlan(plan) {
  if (!plan?.key || !plan.deckName || !plan.projectName) {
    throw new Error("Invalid OmniFocus sync plan.");
  }

  const state = await readState();
  let existing = state[plan.key];
  const commands = [];

  if (plan.shouldComplete) {
    if (!existing?.taskId) {
      const sync = {
        status: "completed",
        message: "No existing OmniFocus task for this deck/date.",
        updatedAt: new Date().toISOString(),
      };
      state[plan.key] = { ...existing, ...sync, plan };
      await writeState(state);
      return { sync, commands };
    }

    const stillExists = await taskExists(existing.taskId);
    if (!stillExists) {
      const sync = {
        ...existing,
        status: "completed",
        staleTaskId: existing.taskId,
        taskId: null,
        message: "Existing OmniFocus task was already deleted.",
        completedAt: new Date().toISOString(),
        plan,
      };
      state[plan.key] = sync;
      await writeState(state);
      return { sync, commands };
    }

    const complete = await runOf(["task", "update", existing.taskId, "--complete"]);
    commands.push(complete);
    const sync = {
      ...existing,
      status: "completed",
      taskId: existing.taskId,
      completedAt: new Date().toISOString(),
      plan,
    };
    state[plan.key] = sync;
    await writeState(state);
    return { sync, commands };
  }

  if (existing?.taskId && existing.status === "synced") {
    const stillExists = await taskExists(existing.taskId);
    if (!stillExists) {
      state[plan.key] = {
        ...existing,
        status: "stale",
        staleTaskId: existing.taskId,
        taskId: null,
        staleAt: new Date().toISOString(),
        plan,
      };
      existing = null;
      await writeState(state);
    } else {
      const sync = {
        ...existing,
        status: "synced",
        reused: true,
        checkedAt: new Date().toISOString(),
        plan,
      };
      state[plan.key] = sync;
      await writeState(state);
      return { sync, commands };
    }
  }

  const project = await ensureProject(plan.projectName);
  const tag = await ensureTag(plan.tagName || "anki");

  const taskNote = [
    managedNote,
    `sync-key: ${plan.key}`,
    `deck: ${plan.deckName}`,
    `due-now: ${plan.dueNow}`,
    `due-soon: ${plan.dueSoon}`,
    `score: ${plan.score}`,
  ].join("\n");
  const createArgs = [
    "task",
    "create",
    plan.title,
    "--project",
    plan.projectName,
    "--due",
    plan.dueDate,
    "--note",
    taskNote,
    "--tag",
    tag.id || tag.name,
    "--estimate",
    String(plan.estimateMinutes || Math.max(Math.round((plan.estimateSeconds || 300) / 60), 5)),
  ];
  if (plan.flagged) createArgs.push("--flagged");

  const created = await runOf(createArgs);
  commands.push(created);

  const taskId = parseTaskId(`${created.stdout}\n${created.stderr}`);
  const sync = {
    status: "synced",
    taskId,
    projectId: project.id,
    tagId: tag.id,
    title: plan.title,
    createdAt: new Date().toISOString(),
    plan,
    rawOutput: created.stdout || created.stderr,
  };
  state[plan.key] = sync;
  await writeState(state);
  return { sync, commands };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(response, status, payload) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      send(response, 204, {});
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { ok: true, statePath: STATE_PATH });
      return;
    }

    if (request.method === "GET" && url.pathname === "/state") {
      send(response, 200, { ok: true, state: await readState(), statePath: STATE_PATH });
      return;
    }

    if (request.method === "POST" && url.pathname === "/sync") {
      const body = await readBody(request);
      const result = await syncPlan(body.plan);
      const verb = result.sync.status === "completed" ? "完成" : result.sync.reused ? "复用" : "创建";
      send(response, 200, {
        ok: true,
        sync: result.sync,
        commands: result.commands,
        message: `OmniFocus 已${verb}：${result.sync.title || result.sync.plan?.title || result.sync.message}`,
      });
      return;
    }

    send(response, 404, { error: "Not found" });
  } catch (error) {
    send(response, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OmniFocus bridge listening at http://127.0.0.1:${PORT}`);
  console.log(`State file: ${STATE_PATH}`);
});
