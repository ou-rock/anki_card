import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const HOST = process.env.LAN_SERVER_HOST || "0.0.0.0";
const PORT = Number(process.env.LAN_SERVER_PORT || 8000);
const ROOT = resolve(process.env.LAN_SERVER_ROOT || process.cwd());
const ANKI_CONNECT_URL = process.env.ANKI_CONNECT_URL || "http://127.0.0.1:8765";
const OMNIFOCUS_BRIDGE_URL = process.env.OMNIFOCUS_BRIDGE_URL || "http://127.0.0.1:3479";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/anki") {
      await proxyJson(request, response, ANKI_CONNECT_URL);
      return;
    }
    if (url.pathname.startsWith("/omnifocus/")) {
      await proxyJson(request, response, `${OMNIFOCUS_BRIDGE_URL}${url.pathname.slice("/omnifocus".length)}`);
      return;
    }
    await serveStatic(url, response);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LAN server listening at http://${HOST}:${PORT}`);
  console.log(`Static root: ${ROOT}`);
  console.log(`Anki proxy: /anki -> ${ANKI_CONNECT_URL}`);
  console.log(`OmniFocus proxy: /omnifocus/* -> ${OMNIFOCUS_BRIDGE_URL}`);
});

async function proxyJson(request, response, targetUrl) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  if (request.method !== "POST" && request.method !== "GET") {
    response.writeHead(405, corsHeaders({ "Content-Type": "application/json; charset=utf-8" }));
    response.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const body = await readBody(request);
  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: request.method === "POST" ? { "Content-Type": "application/json" } : {},
    body: request.method === "POST" ? body : undefined,
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, corsHeaders({ "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8" }));
  response.end(text);
}

async function serveStatic(url, response) {
  const decoded = decodeURIComponent(url.pathname);
  const safePath = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    response.writeHead(404);
    response.end("not found");
    return;
  }

  if (info.isDirectory()) {
    filePath = join(filePath, "index.html");
    try {
      info = await stat(filePath);
    } catch {
      response.writeHead(404);
      response.end("not found");
      return;
    }
  }

  response.writeHead(200, {
    "Content-Length": info.size,
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extra,
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
