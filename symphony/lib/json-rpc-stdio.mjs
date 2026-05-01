import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

export class JsonRpcStdioClient extends EventEmitter {
  constructor(command, cwd, logger) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.logger = logger;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  start() {
    this.child = spawn("bash", ["-lc", this.command], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.logger?.debug("codex stderr", { message: String(chunk).trim() }));
    this.child.on("close", (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`app-server closed code=${code} signal=${signal}`));
      this.pending.clear();
      this.emit("close", { code, signal });
    });
    return this;
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.write(message);
    return promise;
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onStdout(chunk) {
    this.buffer += String(chunk);
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.onMessage(line);
    }
  }

  onMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.logger?.warn("invalid json-rpc line", { line });
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("request", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }
}
