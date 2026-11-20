#!/usr/bin/env node
// Gemini key adapter: lets a Gemini-API client that sends its key the way
// Google's API expects (?key= or x-goog-api-key) talk to a gateway that only
// reads Authorization: Bearer, and answers the Gemini model list from the
// gateway's OpenAI-style /v1/models when the gateway has no /v1beta/models.
//
// It listens on 127.0.0.1 only, so nothing outside this device can use it.
// Keys pass through to the gateway and are never written to the log.
//
// Settings, all optional, as environment variables:
//   PORT      port to listen on              (default 8790)
//   UPSTREAM  the gateway's base URL          (default https://api.literouter.com)
//
// Requires Node 18 or newer. No packages to install.

"use strict";

const http = require("node:http");
const { Readable } = require("node:stream");

const PORT = Number(process.env.PORT) || 8790;
const HOST = "127.0.0.1";
const UPSTREAM = (process.env.UPSTREAM || "https://api.literouter.com").replace(/\/+$/, "");

// Headers that describe this hop or the old body rather than the request
// itself. fetch() decodes compressed responses, so content-encoding and
// content-length from upstream no longer match the bytes we send on.
const HOP_HEADERS = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "content-length",
  "accept-encoding", "content-encoding", "authorization", "x-goog-api-key",
]);

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function googleError(res, status, message) {
  const names = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 404: "NOT_FOUND", 502: "UNAVAILABLE" };
  sendJson(res, status, { error: { code: status, message, status: names[status] || "UNKNOWN" } });
}

// Pull the key from wherever a Gemini client put it, and remove it from the URL
// so it never travels upstream as a query parameter.
function takeKey(req, url) {
  const fromQuery = url.searchParams.get("key");
  url.searchParams.delete("key");
  const fromHeader = req.headers["x-goog-api-key"];
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return (fromQuery || fromHeader || (bearer && bearer[1]) || "").trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

function forwardHeaders(req) {
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) out[name] = value;
  }
  return out;
}

// Gemini clients list models with GET /v1beta/models. Build that answer from
// the gateway's /v1/models, keeping only models its Gemini endpoint serves.
async function listModels(key, res, signal) {
  const upstream = await fetch(`${UPSTREAM}/v1/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal,
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
    res.end(text);
    return upstream.status;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    googleError(res, 502, "Gateway returned a model list that is not JSON");
    return 502;
  }
  const models = (Array.isArray(data && data.data) ? data.data : [])
    .filter((m) => {
      const gc = m && m.endpoints && m.endpoints.generate_content;
      // Gateways that do not describe their endpoints get every model listed.
      if (!m || !m.endpoints) return Boolean(m && m.id);
      return gc && gc.status !== "unsupported";
    })
    .map((m) => ({
      name: `models/${m.id}`,
      displayName: m.display_name || m.name || m.id,
      ...(Number.isFinite(m.context_window) ? { inputTokenLimit: m.context_window } : {}),
      ...(Number.isFinite(m.max_output_tokens) ? { outputTokenLimit: m.max_output_tokens } : {}),
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    }));
  sendJson(res, 200, { models });
  return 200;
}

async function proxy(req, res, url, key, signal) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
    method: req.method,
    headers: { ...forwardHeaders(req), authorization: `Bearer ${key}` },
    body,
    signal,
  });
  const headers = {};
  upstream.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
  } else {
    // Streamed so a streamGenerateContent reply reaches the client token by token.
    Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
  }
  return upstream.status;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const controller = new AbortController();
  // A client that hangs up (a stopped generation) cancels the upstream request too.
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });

  let status = 0;
  try {
    const key = takeKey(req, url);
    if (!key) {
      googleError(res, 401, "No API key: send it as ?key=, x-goog-api-key or Authorization: Bearer");
      status = 401;
    } else if (req.method === "GET" && url.pathname.replace(/\/+$/, "") === "/v1beta/models") {
      status = await listModels(key, res, controller.signal);
    } else {
      status = await proxy(req, res, url, key, controller.signal);
    }
  } catch (err) {
    if (controller.signal.aborted) { status = 499; return; }
    status = 502;
    if (!res.headersSent) googleError(res, 502, `Could not reach ${UPSTREAM}: ${err && err.message ? err.message : err}`);
    else res.destroy();
  } finally {
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} -> ${status}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Gemini key adapter on http://${HOST}:${PORT} -> ${UPSTREAM}`);
  console.log("Leave this running while you chat. Ctrl+C stops it.");
});
