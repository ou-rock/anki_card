import { normalizedStateSet, normalizeState, validateDispatchConfig } from "./config.mjs";
import { LinearClient } from "./linear.mjs";
import { WorkspaceManager } from "./workspace.mjs";
import { CodexAgentRunner } from "./codex-agent.mjs";
import { renderPrompt } from "./workflow.mjs";
import { asErrorMessage } from "./errors.mjs";

export class Orchestrator {
  constructor(runtime, logger) {
    this.runtime = runtime;
    this.logger = logger;
    this.timer = null;
    this.stopped = false;
    this.state = {
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
      recent_events: [],
    };
  }

  async start() {
    const config = await this.runtime.loadInitial();
    await this.startupCleanup(config);
    await this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.state.running.values()) entry.controller.abort();
  }

  async tick() {
    if (this.stopped) return;
    const startedAt = Date.now();
    let config = this.runtime.config;
    try {
      config = await this.runtime.reloadIfChanged({ validate: false });
      await this.reconcile(config);
      validateDispatchConfig(config);
      const tracker = new LinearClient(config, this.logger);
      const candidates = await tracker.fetchCandidateIssues();
      for (const issue of sortForDispatch(candidates)) {
        if (!this.hasGlobalSlot(config)) break;
        if (!this.shouldDispatch(issue, config)) continue;
        this.dispatch(issue, null, config);
      }
      this.logger.info("poll tick completed", { elapsed_ms: Date.now() - startedAt, running: this.state.running.size, retrying: this.state.retry_attempts.size });
    } catch (error) {
      this.logger.error("poll tick failed", { error: asErrorMessage(error) });
    } finally {
      const interval = this.runtime.config?.polling.interval_ms || 30000;
      this.timer = setTimeout(() => this.tick(), interval);
    }
  }

  async startupCleanup(config) {
    try {
      const tracker = new LinearClient(config, this.logger);
      const workspace = new WorkspaceManager(config, this.logger);
      const terminalIssues = await tracker.fetchTerminalIssues();
      for (const issue of terminalIssues) await workspace.removeForIssue(issue.identifier);
      this.logger.info("startup terminal cleanup completed", { count: terminalIssues.length });
    } catch (error) {
      this.logger.warn("startup terminal cleanup failed; continuing", { error: asErrorMessage(error) });
    }
  }

  async reconcile(config) {
    this.reconcileStalls(config);
    const runningIds = [...this.state.running.keys()];
    if (!runningIds.length) return;
    const tracker = new LinearClient(config, this.logger);
    let refreshed;
    try {
      refreshed = await tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.logger.warn("running issue refresh failed; keeping workers running", { error: asErrorMessage(error) });
      return;
    }
    const active = normalizedStateSet(config.tracker.active_states);
    const terminal = normalizedStateSet(config.tracker.terminal_states);
    const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const issueId of runningIds) {
      const issue = byId.get(issueId);
      const entry = this.state.running.get(issueId);
      if (!issue || !entry) continue;
      const state = normalizeState(issue.state);
      if (terminal.has(state)) {
        entry.controller.abort();
        this.release(issueId);
        await new WorkspaceManager(config, this.logger).removeForIssue(issue.identifier);
      } else if (active.has(state)) {
        entry.issue = issue;
      } else {
        entry.controller.abort();
        this.release(issueId);
      }
    }
  }

  reconcileStalls(config) {
    const stall = config.codex.stall_timeout_ms;
    if (stall <= 0) return;
    for (const [issueId, entry] of this.state.running.entries()) {
      const basis = entry.last_codex_timestamp || entry.started_at_ms;
      if (Date.now() - basis > stall) {
        entry.controller.abort();
        this.finishRunning(issueId, "stalled", "stall timeout");
      }
    }
  }

  shouldDispatch(issue, config) {
    if (!issue?.id || !issue.identifier || !issue.title || !issue.state) return false;
    const issueState = normalizeState(issue.state);
    const active = normalizedStateSet(config.tracker.active_states);
    const terminal = normalizedStateSet(config.tracker.terminal_states);
    if (!active.has(issueState) || terminal.has(issueState)) return false;
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) return false;
    if (!this.hasGlobalSlot(config) || !this.hasStateSlot(issueState, config)) return false;
    if (issueState === "todo") {
      const blockers = issue.blocked_by || [];
      if (blockers.some((blocker) => !terminal.has(normalizeState(blocker.state)))) return false;
    }
    return true;
  }

  hasGlobalSlot(config) {
    return this.state.running.size < config.agent.max_concurrent_agents;
  }

  hasStateSlot(state, config) {
    const limit = config.agent.max_concurrent_agents_by_state[state] || config.agent.max_concurrent_agents;
    let count = 0;
    for (const entry of this.state.running.values()) {
      if (normalizeState(entry.issue.state) === state) count += 1;
    }
    return count < limit;
  }

  dispatch(issue, attempt, config) {
    const controller = new AbortController();
    this.state.claimed.add(issue.id);
    this.state.retry_attempts.delete(issue.id);
    this.state.running.set(issue.id, {
      issue,
      attempt,
      controller,
      started_at: new Date().toISOString(),
      started_at_ms: Date.now(),
      session_id: null,
      turn_count: 0,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
    });
    this.logger.info("issue dispatched", { issue_id: issue.id, issue_identifier: issue.identifier, attempt });
    this.runIssue(issue, attempt, controller.signal).catch((error) => {
      this.finishRunning(issue.id, "failed", asErrorMessage(error));
      this.scheduleRetry(issue, nextAttempt(attempt), asErrorMessage(error), false);
    });
  }

  async runIssue(issue, attempt, signal) {
    const config = await this.runtime.reloadIfChanged({ validate: false });
    const workspace = new WorkspaceManager(config, this.logger);
    const currentWorkspace = await workspace.createForIssue(issue.identifier);
    if (config.hooks.before_run) await workspace.runHook("before_run", currentWorkspace.path, config.hooks.before_run, true);
    try {
      const prompt = await renderPrompt(config.prompt_template, issue, attempt);
      const runner = new CodexAgentRunner(config, this.logger);
      await runner.runTurnSession({
        workspacePath: currentWorkspace.path,
        issue,
        prompt,
        onUpdate: (update) => this.onCodexUpdate(issue.id, update),
        signal,
      });
      this.finishRunning(issue.id, "succeeded", null);
      if (config.agent.continue_after_success) this.scheduleRetry(issue, 1, null, true);
    } finally {
      if (config.hooks.after_run) await workspace.runHook("after_run", currentWorkspace.path, config.hooks.after_run, false);
    }
  }

  onCodexUpdate(issueId, update) {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    entry.last_codex_event = update.type;
    entry.last_codex_timestamp = Date.now();
    entry.last_codex_message = update.message || "";
    if (update.session_id) entry.session_id = update.session_id;
    if (update.turn_count) entry.turn_count = update.turn_count;
    if (update.rate_limits) this.state.codex_rate_limits = update.rate_limits;
    if (update.tokens?.total_tokens) {
      const inputDelta = Math.max(update.tokens.input_tokens - entry.last_reported_input_tokens, 0);
      const outputDelta = Math.max(update.tokens.output_tokens - entry.last_reported_output_tokens, 0);
      const totalDelta = Math.max(update.tokens.total_tokens - entry.last_reported_total_tokens, 0);
      entry.last_reported_input_tokens = update.tokens.input_tokens;
      entry.last_reported_output_tokens = update.tokens.output_tokens;
      entry.last_reported_total_tokens = update.tokens.total_tokens;
      entry.codex_input_tokens += inputDelta;
      entry.codex_output_tokens += outputDelta;
      entry.codex_total_tokens += totalDelta;
      this.state.codex_totals.input_tokens += inputDelta;
      this.state.codex_totals.output_tokens += outputDelta;
      this.state.codex_totals.total_tokens += totalDelta;
    }
  }

  finishRunning(issueId, status, error) {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    this.state.codex_totals.seconds_running += (Date.now() - entry.started_at_ms) / 1000;
    this.state.running.delete(issueId);
    if (status === "succeeded") this.state.completed.add(issueId);
    if (status !== "succeeded") this.state.claimed.delete(issueId);
    this.logger.info("worker exited", { issue_id: issueId, issue_identifier: entry.issue.identifier, status, error });
  }

  release(issueId) {
    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);
    this.state.retry_attempts.delete(issueId);
  }

  scheduleRetry(issue, attempt, error, continuation) {
    const config = this.runtime.config;
    const delay = continuation ? 1000 : Math.min(10000 * (2 ** Math.max(attempt - 1, 0)), config.agent.max_retry_backoff_ms);
    const existing = this.state.retry_attempts.get(issue.id);
    if (existing?.timer_handle) clearTimeout(existing.timer_handle);
    const timer = setTimeout(() => this.retryNow(issue.id), delay);
    this.state.claimed.add(issue.id);
    this.state.retry_attempts.set(issue.id, {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: Date.now() + delay,
      timer_handle: timer,
      error,
    });
  }

  async retryNow(issueId) {
    const config = await this.runtime.reloadIfChanged({ validate: false });
    const retry = this.state.retry_attempts.get(issueId);
    if (!retry) return;
    try {
      const tracker = new LinearClient(config, this.logger);
      const candidates = await tracker.fetchCandidateIssues();
      const issue = candidates.find((candidate) => candidate.id === issueId);
      this.state.claimed.delete(issueId);
      this.state.retry_attempts.delete(issueId);
      if (issue && this.shouldDispatch(issue, config)) this.dispatch(issue, retry.attempt, config);
      else if (issue) this.scheduleRetry(issue, retry.attempt + 1, "no available orchestrator slots", false);
      else this.release(issueId);
    } catch (error) {
      this.logger.error("retry failed", { issue_id: issueId, error: asErrorMessage(error) });
    }
  }

  snapshot() {
    const now = Date.now();
    const running = [...this.state.running.values()].map((entry) => ({
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      state: entry.issue.state,
      session_id: entry.session_id,
      turn_count: entry.turn_count,
      last_event: entry.last_codex_event,
      last_message: entry.last_codex_message,
      started_at: entry.started_at,
      last_event_at: entry.last_codex_timestamp ? new Date(entry.last_codex_timestamp).toISOString() : null,
      tokens: {
        input_tokens: entry.codex_input_tokens,
        output_tokens: entry.codex_output_tokens,
        total_tokens: entry.codex_total_tokens,
      },
    }));
    const activeSeconds = [...this.state.running.values()].reduce((total, entry) => total + ((now - entry.started_at_ms) / 1000), 0);
    return {
      generated_at: new Date().toISOString(),
      counts: { running: running.length, retrying: this.state.retry_attempts.size },
      running,
      retrying: [...this.state.retry_attempts.values()].map((entry) => ({
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        attempt: entry.attempt,
        due_at: new Date(entry.due_at_ms).toISOString(),
        error: entry.error,
      })),
      codex_totals: {
        ...this.state.codex_totals,
        seconds_running: this.state.codex_totals.seconds_running + activeSeconds,
      },
      rate_limits: this.state.codex_rate_limits,
      workflow_error: this.runtime.lastError,
    };
  }
}

export function sortForDispatch(issues) {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const created = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    if (created !== 0) return created;
    return String(a.identifier).localeCompare(String(b.identifier));
  });
}

function nextAttempt(attempt) {
  return attempt == null ? 1 : attempt + 1;
}
