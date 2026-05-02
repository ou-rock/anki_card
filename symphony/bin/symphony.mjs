#!/usr/bin/env node
import { resolve } from "node:path";
import { Logger } from "../lib/logger.mjs";
import { WorkflowRuntime } from "../lib/runtime.mjs";
import { Orchestrator } from "../lib/orchestrator.mjs";
import { startHttpServer } from "../lib/http-server.mjs";

const args = parseArgs(process.argv.slice(2));
const logger = new Logger();
const workflowPath = resolve(args.workflow || "WORKFLOW.md");
const runtime = new WorkflowRuntime(workflowPath, logger);

try {
  if (args.command === "validate") {
    const config = await runtime.loadInitial();
    logger.info("workflow valid", {
      workflow_path: workflowPath,
      tracker_kind: config.tracker.kind,
      workspace_root: config.workspace.root,
      polling_interval_ms: config.polling.interval_ms,
    });
    process.exit(0);
  }

  const orchestrator = new Orchestrator(runtime, logger);
  const config = await runtime.loadInitial();
  const port = args.port !== undefined ? Number(args.port) : config.server.port;
  const host = args.host || config.server.host;
  if (port !== null && port !== undefined) startHttpServer(orchestrator, port, logger, { host });

  process.on("SIGINT", () => {
    logger.info("shutdown requested", { signal: "SIGINT" });
    orchestrator.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    logger.info("shutdown requested", { signal: "SIGTERM" });
    orchestrator.stop();
    process.exit(0);
  });

  await orchestrator.start();
} catch (error) {
  logger.error("symphony startup failed", { error: error.message, code: error.code });
  process.exit(1);
}

function parseArgs(argv) {
  const result = { command: "start" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "start" || arg === "validate") {
      result.command = arg;
    } else if (arg === "--workflow") {
      result.workflow = argv[++index];
    } else if (arg === "--port") {
      result.port = argv[++index];
    } else if (arg === "--host") {
      result.host = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return result;
}

function printHelp() {
  console.log(`Usage: node symphony/bin/symphony.mjs [start|validate] [--workflow WORKFLOW.md] [--port PORT] [--host HOST]

Commands:
  start      Start the long-running Symphony service.
  validate   Load WORKFLOW.md, resolve config, and run dispatch preflight validation.

Options:
  --workflow PATH  Workflow file path. Defaults to ./WORKFLOW.md.
  --port PORT      Enable optional HTTP dashboard/API on the configured host.
  --host HOST      HTTP bind address. Use 0.0.0.0 for LAN/mobile access.
`);
}
