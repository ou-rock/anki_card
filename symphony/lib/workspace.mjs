import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SymphonyError } from "./errors.mjs";

export function workspaceKey(identifier) {
  return String(identifier).replace(/[^A-Za-z0-9._-]/g, "_");
}

export class WorkspaceManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  workspacePath(identifier) {
    return join(this.config.workspace.root, workspaceKey(identifier));
  }

  async createForIssue(identifier) {
    const path = this.workspacePath(identifier);
    let createdNow = false;
    try {
      await stat(path);
    } catch {
      await mkdir(path, { recursive: true });
      createdNow = true;
    }

    if (createdNow && this.config.hooks.after_create) {
      await this.runHook("after_create", path, this.config.hooks.after_create, true);
    }

    return { path, workspace_key: workspaceKey(identifier), created_now: createdNow };
  }

  async removeForIssue(identifier) {
    const path = this.workspacePath(identifier);
    if (this.config.hooks.before_remove) {
      await this.runHook("before_remove", path, this.config.hooks.before_remove, false);
    }
    await rm(path, { recursive: true, force: true });
  }

  async runHook(name, cwd, script, failOnError) {
    const result = await runShell(script, cwd, this.config.hooks.timeout_ms);
    if (result.code !== 0) {
      const message = `${name} hook failed with exit ${result.code}: ${result.stderr || result.stdout}`;
      if (failOnError) throw new SymphonyError("hook_error", message, { hook: name, cwd });
      this.logger?.warn("hook failed ignored", { hook: name, cwd, exit_code: result.code, stderr: result.stderr });
    }
    return result;
  }
}

export function runShell(script, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 124 : code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
