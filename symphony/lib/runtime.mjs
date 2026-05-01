import { stat } from "node:fs/promises";
import { loadWorkflow } from "./workflow.mjs";
import { resolveConfig, validateDispatchConfig } from "./config.mjs";

export class WorkflowRuntime {
  constructor(workflowPath, logger) {
    this.workflowPath = workflowPath;
    this.logger = logger;
    this.workflow = null;
    this.config = null;
    this.lastError = null;
  }

  async loadInitial() {
    const workflow = await loadWorkflow(this.workflowPath);
    const config = resolveConfig(workflow);
    validateDispatchConfig(config);
    this.workflow = workflow;
    this.config = config;
    this.lastError = null;
    return config;
  }

  async reloadIfChanged({ validate = false } = {}) {
    if (!this.workflow) return this.loadInitial();
    let currentMtime = null;
    try {
      currentMtime = (await stat(this.workflow.path)).mtimeMs;
    } catch (error) {
      this.lastError = error.message;
      this.logger?.error("workflow stat failed", { error: error.message });
      return this.config;
    }

    if (currentMtime === this.workflow.mtime_ms) return this.config;

    try {
      const workflow = await loadWorkflow(this.workflow.path);
      const config = resolveConfig(workflow);
      if (validate) validateDispatchConfig(config);
      this.workflow = workflow;
      this.config = config;
      this.lastError = null;
      this.logger?.info("workflow reloaded", { workflow_path: workflow.path });
    } catch (error) {
      this.lastError = error.message;
      this.logger?.error("workflow reload failed; keeping last known good config", { error: error.message });
    }
    return this.config;
  }
}
