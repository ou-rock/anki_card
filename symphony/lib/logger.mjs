export class Logger {
  constructor({ sink = process.stderr } = {}) {
    this.sink = sink;
  }

  event(level, message, context = {}) {
    const line = {
      ts: new Date().toISOString(),
      level,
      message,
      ...context,
    };
    this.sink.write(`${JSON.stringify(line)}\n`);
  }

  debug(message, context) {
    this.event("debug", message, context);
  }

  info(message, context) {
    this.event("info", message, context);
  }

  warn(message, context) {
    this.event("warn", message, context);
  }

  error(message, context) {
    this.event("error", message, context);
  }
}
