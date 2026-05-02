import { createServer } from "node:http";

const DEFAULT_HOST = "127.0.0.1";
const EVENT_INTERVAL_MS = 2000;

export function startHttpServer(orchestrator, port, logger, options = {}) {
  const host = options.host || DEFAULT_HOST;
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/v1/state") {
      sendJson(response, 200, orchestrator.snapshot());
      return;
    }

    if (url.pathname === "/api/v1/events") {
      sendEventStream(request, response, orchestrator);
      return;
    }

    if (url.pathname.startsWith("/api/v1/")) {
      const identifier = decodeURIComponent(url.pathname.slice("/api/v1/".length));
      const snapshot = orchestrator.snapshot();
      const running = snapshot.running.find((entry) => entry.issue_identifier === identifier);
      const retry = snapshot.retrying.find((entry) => entry.issue_identifier === identifier);
      if (!running && !retry) {
        sendJson(response, 404, { error: "not found", issue_identifier: identifier });
        return;
      }
      sendJson(response, 200, {
        issue_identifier: identifier,
        issue_id: running?.issue_id || retry?.issue_id || null,
        status: running ? "running" : "retrying",
        running: running || null,
        retry: retry || null,
      });
      return;
    }

    if (url.pathname === "/") {
      const snapshot = orchestrator.snapshot();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderDashboard(snapshot));
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  server.listen(port, host, () => {
    const address = server.address();
    logger.info("http server listening", { host, port: address.port });
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      logger.error("http server port is already in use", { host, port });
      process.exitCode = 1;
      return;
    }
    logger.error("http server failed", { error: error.message, code: error.code });
    process.exitCode = 1;
  });
  return server;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendEventStream(request, response, orchestrator) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  response.write("retry: 2000\n\n");
  const sendSnapshot = () => {
    response.write(`event: state\ndata: ${JSON.stringify(orchestrator.snapshot())}\n\n`);
  };
  sendSnapshot();
  const timer = setInterval(sendSnapshot, EVENT_INTERVAL_MS);
  request.on("close", () => clearInterval(timer));
}

function renderDashboard(snapshot) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; color: #17201b; background: #f7faf8; }
    main { width: min(1120px, calc(100% - 32px)); margin: 24px auto 40px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
    h1 { margin: 0; font-size: clamp(28px, 6vw, 42px); line-height: 1; }
    h2 { margin: 28px 0 10px; font-size: 18px; }
    p { margin: 6px 0; }
    .status { display: flex; gap: 8px; align-items: center; justify-content: flex-end; min-width: 130px; }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: #d28b26; }
    .status.live .dot { background: #168451; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0; }
    .metric { border: 1px solid #d7dfda; border-radius: 8px; padding: 12px; background: white; }
    .metric strong { display: block; font-size: 24px; }
    .table-wrap { overflow-x: auto; border: 1px solid #d7dfda; border-radius: 8px; background: white; }
    table { border-collapse: collapse; width: 100%; min-width: 760px; }
    th, td { border-bottom: 1px solid #d7dfda; padding: 10px; text-align: left; vertical-align: top; }
    tr:last-child td { border-bottom: 0; }
    code, pre { background: #eef4ef; padding: 2px 5px; border-radius: 4px; }
    ul { padding-left: 20px; }
    .muted { color: #5b6861; }
    @media (prefers-color-scheme: dark) {
      body { color: #e8eee9; background: #111714; }
      .metric, .table-wrap { background: #18211d; border-color: #32423a; }
      th, td { border-color: #32423a; }
      code, pre { background: #243029; }
      .muted { color: #a9b8af; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Symphony</h1>
        <p class="muted">Generated at <span data-field="generated_at">${escapeHtml(snapshot.generated_at)}</span></p>
      </div>
      <div class="status" id="stream-status"><span class="dot"></span><span>Connecting</span></div>
    </header>
    <section class="summary">
      <div class="metric"><span>Running</span><strong data-field="running_count">${snapshot.counts.running}</strong></div>
      <div class="metric"><span>Retrying</span><strong data-field="retrying_count">${snapshot.counts.retrying}</strong></div>
      <div class="metric"><span>Tokens</span><strong data-field="tokens">${snapshot.codex_totals.total_tokens}</strong></div>
      <div class="metric"><span>Runtime seconds</span><strong data-field="seconds">${Math.round(snapshot.codex_totals.seconds_running)}</strong></div>
    </section>
    <p id="workflow-error">${snapshot.workflow_error ? `<strong>Workflow error:</strong> ${escapeHtml(snapshot.workflow_error)}` : ""}</p>
    <h2>Running</h2>
    <div class="table-wrap">
      <table><thead><tr><th>Issue</th><th>State</th><th>Session</th><th>Turns</th><th>Last event</th><th>Last message</th></tr></thead><tbody id="running-body"></tbody></table>
    </div>
    <h2>Retrying</h2>
    <ul id="retrying-list"></ul>
  </main>
  <script>
    const initialSnapshot = ${safeJson(snapshot)};
    const statusEl = document.getElementById("stream-status");
    const setText = (selector, value) => {
      const element = document.querySelector(selector);
      if (element) element.textContent = value ?? "";
    };
    const render = (snapshot) => {
      setText("[data-field='generated_at']", snapshot.generated_at);
      setText("[data-field='running_count']", snapshot.counts.running);
      setText("[data-field='retrying_count']", snapshot.counts.retrying);
      setText("[data-field='tokens']", snapshot.codex_totals.total_tokens);
      setText("[data-field='seconds']", Math.round(snapshot.codex_totals.seconds_running));
      const workflowError = document.getElementById("workflow-error");
      workflowError.textContent = "";
      if (snapshot.workflow_error) {
        const strong = document.createElement("strong");
        strong.textContent = "Workflow error: ";
        workflowError.append(strong, snapshot.workflow_error);
      }
      const runningBody = document.getElementById("running-body");
      runningBody.replaceChildren(...snapshot.running.map((entry) => {
        const row = document.createElement("tr");
        [
          entry.issue_identifier,
          entry.state,
          entry.session_id || "-",
          entry.turn_count,
          entry.last_event || "-",
          entry.last_message || "-",
        ].forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        });
        return row;
      }));
      const retryingList = document.getElementById("retrying-list");
      retryingList.replaceChildren(...snapshot.retrying.map((entry) => {
        const item = document.createElement("li");
        item.textContent = entry.issue_identifier + " attempt " + entry.attempt + ", due " + entry.due_at + (entry.error ? " " + entry.error : "");
        return item;
      }));
    };
    render(initialSnapshot);
    if (window.EventSource) {
      const events = new EventSource("/api/v1/events");
      events.addEventListener("open", () => {
        statusEl.classList.add("live");
        statusEl.lastElementChild.textContent = "Live";
      });
      events.addEventListener("state", (event) => render(JSON.parse(event.data)));
      events.addEventListener("error", () => {
        statusEl.classList.remove("live");
        statusEl.lastElementChild.textContent = "Reconnecting";
      });
    } else {
      statusEl.lastElementChild.textContent = "Manual refresh";
    }
  </script>
</body>
</html>`;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[char]));
}
