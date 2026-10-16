// Minimal stand-in for POST /v1/messages that streams a canned answer as SSE.
// Records every request body so tests can assert on what the app sent.
const http = require("node:http");

// Set `mock.failNext = { status, message }` to make the next request fail like the real API.
function startMockAnthropic(answer = "Mock **answer** from Claude.") {
  const requests = [];
  const mock = { requests, failNext: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
      if (mock.failNext) {
        const { status, message } = mock.failNext;
        mock.failNext = null;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", {
        message: {
          id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5-5",
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      for (const piece of answer.match(/.{1,8}/gs)) {
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
      }
      send("content_block_stop", { index: 0 });
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
