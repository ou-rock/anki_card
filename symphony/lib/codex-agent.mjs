import { once } from "node:events";
import { JsonRpcStdioClient } from "./json-rpc-stdio.mjs";
import { SymphonyError } from "./errors.mjs";

export class CodexAgentRunner {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async runTurnSession({ workspacePath, issue, prompt, continuationPrompt, onUpdate, signal }) {
    const client = new JsonRpcStdioClient(this.config.codex.command, workspacePath, this.logger).start();
    const cleanup = () => client.stop();
    signal?.addEventListener("abort", cleanup, { once: true });

    try {
      client.on("request", (message) => {
        this.logger?.warn("auto-denying app-server request", { issue_id: issue.id, issue_identifier: issue.identifier, method: message.method });
        client.respond(message.id, defaultRequestResponse(message.method));
      });

      client.on("notification", (message) => {
        onUpdate?.(normalizeCodexNotification(message));
      });

      await client.request("initialize", {
        clientInfo: { name: "symphony", version: "0.1.0" },
      }, this.config.codex.read_timeout_ms);

      const threadParams = {
        cwd: workspacePath,
        serviceName: "symphony",
      };
      if (this.config.codex.approval_policy) threadParams.approvalPolicy = this.config.codex.approval_policy;
      if (this.config.codex.thread_sandbox) threadParams.sandbox = this.config.codex.thread_sandbox;
      if (this.config.codex.model) threadParams.model = this.config.codex.model;

      const threadResponse = await client.request("thread/start", threadParams, this.config.codex.read_timeout_ms);
      const threadId = threadResponse?.thread?.id;
      if (!threadId) throw new SymphonyError("agent_error", "Codex app-server did not return a thread id.");

      let turnPrompt = prompt;
      let turnCount = 0;
      while (turnCount < this.config.agent.max_turns) {
        if (signal?.aborted) throw new SymphonyError("agent_canceled", "Agent run was canceled.");
        turnCount += 1;
        const started = await this.startTurn(client, threadId, workspacePath, turnPrompt);
        const turnId = started?.turn?.id;
        onUpdate?.({
          type: "turn_started",
          thread_id: threadId,
          turn_id: turnId,
          session_id: `${threadId}-${turnId || turnCount}`,
          turn_count: turnCount,
        });
        const completed = await this.waitForTurnCompleted(client, threadId, turnId, signal);
        onUpdate?.({
          ...normalizeTurn(completed.turn),
          type: "turn_completed",
          thread_id: threadId,
          turn_id: completed.turn?.id || turnId,
          session_id: `${threadId}-${completed.turn?.id || turnId || turnCount}`,
          turn_count: turnCount,
        });
        return { status: "succeeded", thread_id: threadId, turn_id: completed.turn?.id || turnId, turn_count: turnCount };
      }

      return { status: "succeeded", thread_id: threadId, turn_count: turnCount };
    } finally {
      signal?.removeEventListener("abort", cleanup);
      client.stop();
    }
  }

  async startTurn(client, threadId, cwd, prompt) {
    const params = {
      threadId,
      cwd,
      input: [{ type: "text", text: prompt }],
    };
    if (this.config.codex.approval_policy) params.approvalPolicy = this.config.codex.approval_policy;
    if (this.config.codex.turn_sandbox_policy) params.sandboxPolicy = this.config.codex.turn_sandbox_policy;
    if (this.config.codex.model) params.model = this.config.codex.model;
    return client.request("turn/start", params, this.config.codex.read_timeout_ms);
  }

  waitForTurnCompleted(client, threadId, turnId, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SymphonyError("agent_timeout", "Codex turn timed out.")), this.config.codex.turn_timeout_ms);
      const abort = () => reject(new SymphonyError("agent_canceled", "Agent run was canceled."));
      const handler = (message) => {
        if (message.method !== "turn/completed") return;
        if (message.params?.threadId !== threadId) return;
        if (turnId && message.params?.turn?.id && message.params.turn.id !== turnId) return;
        cleanup();
        resolve(message.params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        client.off("notification", handler);
      };
      signal?.addEventListener("abort", abort, { once: true });
      client.on("notification", handler);
      once(client, "close").then(([close]) => {
        cleanup();
        reject(new SymphonyError("agent_error", `Codex app-server closed before turn completed: ${JSON.stringify(close)}`));
      }).catch(() => {});
    });
  }
}

function defaultRequestResponse(method) {
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null };
  }
  if (method.includes("approval") || method.includes("permissions")) {
    return { decision: "denied", approved: false, reason: "Symphony does not grant interactive approvals." };
  }
  return {};
}

function normalizeCodexNotification(message) {
  const params = message.params || {};
  return {
    type: message.method,
    thread_id: params.threadId || params.thread?.id || null,
    turn_id: params.turn?.id || params.turnId || null,
    message: summarizePayload(params),
    tokens: extractTokens(params),
    rate_limits: message.method?.includes("rate") ? params : null,
  };
}

function normalizeTurn(turn = {}) {
  return {
    status: turn.status || null,
    message: turn.error?.message || turn.status || "",
    tokens: extractTokens(turn),
  };
}

function summarizePayload(payload) {
  if (typeof payload.text === "string") return payload.text.slice(0, 300);
  if (typeof payload.message === "string") return payload.message.slice(0, 300);
  if (payload.turn?.status) return `turn ${payload.turn.status}`;
  return "";
}

export function extractTokens(payload = {}) {
  const candidates = [
    payload.total_token_usage,
    payload.tokenUsage,
    payload.usage,
    payload.turn?.usage,
    payload.turn?.tokenUsage,
  ].filter(Boolean);
  const usage = candidates[0] || {};
  const input = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0;
  const output = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0;
  const total = usage.total_tokens ?? usage.totalTokens ?? (Number(input) + Number(output));
  return {
    input_tokens: Number(input) || 0,
    output_tokens: Number(output) || 0,
    total_tokens: Number(total) || 0,
  };
}
