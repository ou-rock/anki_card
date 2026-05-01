import { createServer } from "node:http";

export function startHttpServer(orchestrator, port, logger) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/v1/state") {
      sendJson(response, 200, orchestrator.snapshot());
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

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    logger.info("http server listening", { port: address.port });
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      logger.error("http server port is already in use", { port, address: "127.0.0.1" });
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

function renderDashboard(snapshot) {
  const rows = snapshot.running.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.issue_identifier)}</td>
      <td>${escapeHtml(entry.state)}</td>
      <td>${escapeHtml(entry.session_id || "-")}</td>
      <td>${entry.turn_count}</td>
      <td>${escapeHtml(entry.last_event || "-")}</td>
    </tr>
  `).join("");
  const retries = snapshot.retrying.map((entry) => `
    <li>${escapeHtml(entry.issue_identifier)} attempt ${entry.attempt}, due ${escapeHtml(entry.due_at)} ${escapeHtml(entry.error || "")}</li>
  `).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Symphony</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #17201b; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border-bottom: 1px solid #d7dfda; padding: 8px; text-align: left; }
    code, pre { background: #eef4ef; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Symphony</h1>
  <p>Generated at ${escapeHtml(snapshot.generated_at)}. Running: ${snapshot.counts.running}. Retrying: ${snapshot.counts.retrying}.</p>
  <p>Tokens: ${snapshot.codex_totals.total_tokens}. Runtime seconds: ${Math.round(snapshot.codex_totals.seconds_running)}.</p>
  ${snapshot.workflow_error ? `<p><strong>Workflow error:</strong> ${escapeHtml(snapshot.workflow_error)}</p>` : ""}
  <h2>Running</h2>
  <table><thead><tr><th>Issue</th><th>State</th><th>Session</th><th>Turns</th><th>Last event</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Retrying</h2>
  <ul>${retries}</ul>
</body>
</html>`;
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
