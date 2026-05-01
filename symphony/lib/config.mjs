import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { SymphonyError } from "./errors.mjs";

const DEFAULTS = {
  linearEndpoint: "https://api.linear.app/graphql",
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
  pollingIntervalMs: 30000,
  workspaceRoot: "/symphony_workspaces",
  hookTimeoutMs: 60000,
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxRetryBackoffMs: 300000,
  continueAfterSuccess: false,
  codexCommand: "codex app-server",
  codexTurnTimeoutMs: 3600000,
  codexReadTimeoutMs: 5000,
  codexStallTimeoutMs: 300000,
};

export function resolveConfig(workflow, env = process.env) {
  const raw = workflow.config || {};
  const tracker = raw.tracker || {};
  const polling = raw.polling || {};
  const workspace = raw.workspace || {};
  const hooks = raw.hooks || {};
  const agent = raw.agent || {};
  const codex = raw.codex || {};
  const server = raw.server || {};

  const trackerKind = tracker.kind;
  const trackerApiKey = resolveSecret(tracker.api_key ?? (trackerKind === "linear" ? "$LINEAR_API_KEY" : undefined), env);
  const workspaceRoot = resolvePathValue(workspace.root ?? DEFAULTS.workspaceRoot, workflow.dir || dirname(workflow.path || process.cwd()), env);

  const config = {
    workflow_path: workflow.path,
    workflow_dir: workflow.dir,
    prompt_template: workflow.prompt_template,
    tracker: {
      kind: trackerKind,
      endpoint: tracker.endpoint || (trackerKind === "linear" ? DEFAULTS.linearEndpoint : undefined),
      api_key: trackerApiKey,
      project_slug: tracker.project_slug,
      active_states: stringList(tracker.active_states, DEFAULTS.activeStates),
      terminal_states: stringList(tracker.terminal_states, DEFAULTS.terminalStates),
    },
    polling: {
      interval_ms: positiveInteger(polling.interval_ms, DEFAULTS.pollingIntervalMs, "polling.interval_ms"),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      after_create: nullableString(hooks.after_create),
      before_run: nullableString(hooks.before_run),
      after_run: nullableString(hooks.after_run),
      before_remove: nullableString(hooks.before_remove),
      timeout_ms: positiveInteger(hooks.timeout_ms, DEFAULTS.hookTimeoutMs, "hooks.timeout_ms"),
    },
    agent: {
      max_concurrent_agents: positiveInteger(agent.max_concurrent_agents, DEFAULTS.maxConcurrentAgents, "agent.max_concurrent_agents"),
      max_turns: positiveInteger(agent.max_turns, DEFAULTS.maxTurns, "agent.max_turns"),
      max_retry_backoff_ms: positiveInteger(agent.max_retry_backoff_ms, DEFAULTS.maxRetryBackoffMs, "agent.max_retry_backoff_ms"),
      continue_after_success: Boolean(agent.continue_after_success ?? DEFAULTS.continueAfterSuccess),
      max_concurrent_agents_by_state: positiveIntegerMap(agent.max_concurrent_agents_by_state),
    },
    codex: {
      command: codex.command || DEFAULTS.codexCommand,
      approval_policy: codex.approval_policy ?? null,
      thread_sandbox: codex.thread_sandbox ?? null,
      turn_sandbox_policy: codex.turn_sandbox_policy ?? null,
      turn_timeout_ms: positiveInteger(codex.turn_timeout_ms, DEFAULTS.codexTurnTimeoutMs, "codex.turn_timeout_ms"),
      read_timeout_ms: positiveInteger(codex.read_timeout_ms, DEFAULTS.codexReadTimeoutMs, "codex.read_timeout_ms"),
      stall_timeout_ms: integer(codex.stall_timeout_ms, DEFAULTS.codexStallTimeoutMs, "codex.stall_timeout_ms"),
      model: codex.model ?? null,
    },
    server: {
      port: server.port === undefined ? null : integer(server.port, null, "server.port"),
    },
  };

  return config;
}

export function validateDispatchConfig(config) {
  if (config.tracker.kind !== "linear") {
    throw new SymphonyError("config_validation_error", "tracker.kind is required and must be 'linear'.");
  }
  if (!config.tracker.api_key) {
    throw new SymphonyError("config_validation_error", "tracker.api_key is required after environment resolution.");
  }
  if (!config.tracker.project_slug) {
    throw new SymphonyError("config_validation_error", "tracker.project_slug is required for Linear.");
  }
  if (!config.codex.command || !String(config.codex.command).trim()) {
    throw new SymphonyError("config_validation_error", "codex.command must be non-empty.");
  }
}

export function normalizeState(state) {
  return String(state || "").toLowerCase();
}

export function normalizedStateSet(states) {
  return new Set(states.map(normalizeState));
}

function resolveSecret(value, env) {
  if (!value) return "";
  if (typeof value === "string" && value.startsWith("$")) {
    return env[value.slice(1)] || "";
  }
  return value;
}

function resolvePathValue(value, baseDir, env) {
  let text = String(value || "");
  if (text.startsWith("$")) text = env[text.slice(1)] || "";
  if (text.startsWith("~/")) text = resolve(homedir(), text.slice(2));
  if (!isAbsolute(text)) text = resolve(baseDir, text);
  return resolve(text);
}

function stringList(value, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) return [...fallback];
  return value.map((item) => String(item)).filter(Boolean);
}

function nullableString(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function integer(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new SymphonyError("config_validation_error", `${name} must be an integer.`);
  return parsed;
}

function positiveInteger(value, fallback, name) {
  const parsed = integer(value, fallback, name);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new SymphonyError("config_validation_error", `${name} must be a positive integer.`);
  return parsed;
}

function positiveIntegerMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) result[normalizeState(key)] = parsed;
  }
  return result;
}
