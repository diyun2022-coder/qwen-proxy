import http from "node:http";
import { spawn, execSync } from "node:child_process";

const PORT = parseInt(process.env.PORT || "8000", 10);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "qwen3.6-plus";

// Resolve qwen binary to absolute path
const QWEN_BIN = (() => {
  if (process.env.QWEN_BIN) return process.env.QWEN_BIN;
  try {
    return execSync("which qwen").toString().trim();
  } catch {
    return "qwen";
  }
})();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function messagesToPrompt(system, messages) {
  let prompt = "";
  if (system) prompt += `<System>\n${system}\n</System>\n\n`;
  return prompt + messages
    .map((m) => {
      const role = m.role === "system" ? "System" : m.role === "user" ? "User" : "Assistant";
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.map(c => c.text || JSON.stringify(c)).join("\n");
      }
      return `<${role}>\n${content}\n</${role}>`;
    })
    .join("\n\n");
}

function genId() {
  return "msg_" + Math.random().toString(36).slice(2, 14);
}

function spawnQwen(prompt, model, streaming = false) {
  const args = streaming
    ? [prompt, "-m", model, "-y", "--output-format", "stream-json", "--include-partial-messages"]
    : ["-p", prompt, "-m", model, "-y"];
  return spawn(QWEN_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
}

function handleStreaming(prompt, model, req, res) {
  const t0 = Date.now();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const child = spawnQwen(prompt, model, true /* streaming */);

  let lineBuf = "";

  child.stdout.on("data", (chunk) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Qwen CLI directly embeds Anthropic-compatible SSE events inside msg.event!
      if (msg.type === "stream_event" && msg.event) {
        sendEvent(msg.event.type, msg.event);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    // console.log(`[STDERR] ${chunk.toString().trim()}`);
  });

  child.on("close", (code) => {
    if (lineBuf.trim()) {
      try {
        const msg = JSON.parse(lineBuf.trim());
        if (msg.type === "stream_event" && msg.event) {
          sendEvent(msg.event.type, msg.event);
        }
      } catch { /* ignore */ }
    }
    console.log(`[CLOSE +${Date.now() - t0}ms] exit code: ${code}`);
    res.end();
  });

  child.on("error", (err) => {
    console.log(`[ERROR +${Date.now() - t0}ms] ${err.message}`);
    sendEvent("error", { type: "error", error: { type: "server_error", message: err.message } });
    res.end();
  });

  res.on("close", () => {
    if (!child.killed) child.kill("SIGINT");
  });
}

function handleNonStreaming(prompt, model, req, res) {
  const id = genId();
  const child = spawnQwen(prompt, model);

  let output = "";
  let stderrBuf = "";

  child.stdout.on("data", (chunk) => output += chunk.toString());
  child.stderr.on("data", (chunk) => stderrBuf += chunk.toString());

  child.on("close", (code) => {
    if (code !== 0 && !output.trim()) {
      return json(res, 500, { type: "error", error: { type: "server_error", message: stderrBuf.trim() || `qwen exited with code ${code}` } });
    }
    json(res, 200, {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: output.trim() }],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    });
  });

  child.on("error", (err) => {
    json(res, 500, { type: "error", error: { type: "server_error", message: err.message } });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[REQUEST] ${req.method} ${url.pathname}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    // Some libraries fetch models first
    return json(res, 200, {
      object: "list",
      data: [{ id: DEFAULT_MODEL, object: "model", created: Date.now(), owned_by: "anthropic" }]
    });
  }

  // Support typical Anthropic path
  if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname.endsWith("/v1/messages"))) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } });
      }

      if (!payload.messages || !Array.isArray(payload.messages)) {
        return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Missing 'messages' array" } });
      }

      // Anthropic sometimes passes system prompt outside of messages array
      let systemPrompt = payload.system || "";
      if (Array.isArray(systemPrompt)) {
        systemPrompt = systemPrompt.map(s => s.text || JSON.stringify(s)).join("\n");
      }

      const prompt = messagesToPrompt(systemPrompt, payload.messages);
      const model = payload.model || DEFAULT_MODEL;
      const stream = payload.stream === true;

      if (stream) {
        handleStreaming(prompt, model, req, res);
      } else {
        handleNonStreaming(prompt, model, req, res);
      }
    });
    return;
  }

  console.log(`[404] Not found: ${url.pathname}`);
  json(res, 404, { type: "error", error: { type: "not_found_error", message: `Not found: ${url.pathname}` } });
});

server.listen(PORT, () => {
  console.log(`Anthropic-compatible proxy listening on http://localhost:${PORT}`);
});
