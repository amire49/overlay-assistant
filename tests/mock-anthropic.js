// Minimal stand-in for POST /v1/messages that streams a canned answer as SSE.
// Records every request body so tests can assert on what the app sent.
const crypto = require("node:crypto");
const http = require("node:http");

const BINDING_BETA = "thinking-binding-controls-2026-08-01";

// Like the real API, each answer opens with a thinking block whose signature covers the conversation it
// was written in: the system prompt, the tools and every earlier message (thinking blocks aside).
function bind(body, messages) {
  const withoutThinking = messages.map((m) =>
    Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type !== "thinking") } : m);
  return crypto.createHash("sha256").update(JSON.stringify([body.system ?? null, body.tools ?? null, withoutThinking])).digest("base64");
}

// Paths of replayed thinking blocks whose conversation has changed since; the first mismatch takes
// every later block with it, as in the real API.
function staleThinking(body) {
  const stale = [];
  body.messages.forEach((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    m.content.forEach((b, j) => {
      if (b.type === "thinking" && (stale.length || b.signature !== bind(body, body.messages.slice(0, i)))) {
        stale.push(`messages.${i}.content.${j}`);
      }
    });
  });
  return stale;
}

// Set `mock.failNext = { status, message }` to make the next request fail like the real API,
// `mock.refuseNext = true` to have the next answer declined (stop_reason "refusal"), and
// `mock.delay` (ms) to hold each answer back, e.g. so a newer question can arrive mid-answer.
function startMockAnthropic(answer = "Mock **answer** from Claude.") {
  const requests = [];
  const mock = { requests, failNext: null, refuseNext: false, delay: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const request = { url: req.url, headers: req.headers, body: JSON.parse(body || "{}"), dropped: [] };
      requests.push(request);
      const fail = (status, message) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
      };
      if (mock.failNext) {
        const { status, message } = mock.failNext;
        mock.failNext = null;
        return fail(status, message);
      }
      const binding = request.body.thinking?.block_binding;
      if (binding && !String(req.headers["anthropic-beta"]).includes(BINDING_BETA)) {
        return fail(400, "thinking.block_binding: Extra inputs are not permitted");
      }
      const stale = staleThinking(request.body);
      if (stale.length && binding?.prefix_mismatch_behavior !== "drop_block") {
        return fail(400, `${stale[0]}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. ` +
          'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".');
      }
      request.dropped = stale;

      if (mock.delay) await new Promise((r) => setTimeout(r, mock.delay));
      if (req.socket.destroyed) return; // the app gave up on this answer
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", {
        message: {
          id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5-5",
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
          ...(binding && {
            input_transformations: stale.map((path) => ({ type: "thinking_dropped", path, reason: "prefix_binding_mismatch" })),
          }),
        },
      });
      if (mock.refuseNext) {
        mock.refuseNext = false;
        send("message_delta", { delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: null, explanation: null } }, usage: { output_tokens: 0 } });
        send("message_stop", {});
        return res.end();
      }
      send("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: bind(request.body, request.body.messages) } });
      send("content_block_stop", { index: 0 });
      send("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
      for (const piece of answer.match(/.{1,8}/gs)) {
        send("content_block_delta", { index: 1, delta: { type: "text_delta", text: piece } });
      }
      send("content_block_stop", { index: 1 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } });
      send("message_stop", {});
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(Object.assign(mock, { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })),
    ),
  );
}

module.exports = { startMockAnthropic };
