const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DeepgramSTT } = require("../src/stt/deepgram");

// Mock WebSocket class to test in standard sandbox without network sockets
class MockWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0; // CONNECTING
    this.sentData = [];

    process.nextTick(() => {
      this.readyState = 1; // OPEN
      this.emit("open");
    });
  }

  send(data) {
    this.sentData.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit("close", 1000, "Normal Closure");
  }
}
MockWebSocket.OPEN = 1;

(async () => {
  // Test constructor
  const transcripts = [];
  const errors = [];
  let opened = false;
  let closed = false;

  const dg = new DeepgramSTT({
    apiKey: "test-deepgram-key",
    model: "nova-3",
    language: "en",
    onTranscript: (t) => transcripts.push(t),
    onError: (e) => errors.push(e),
    onOpen: () => { opened = true; },
    onClose: () => { closed = true; },
  });

  // Inject MockWebSocket into the instance connect()
  const mockWs = new MockWebSocket("wss://api.deepgram.com/v1/listen", {
    headers: { Authorization: `Token ${dg.apiKey}` },
  });
  await new Promise((r) => mockWs.once("open", r));
  dg.ws = mockWs;
  dg.connected = true;
  opened = true;

  assert.ok(dg.isConnected, "connected flag is true");

  // Verify sendAudio converts Float32 to Int16 PCM correctly
  const floatSamples = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
  dg.sendAudio(floatSamples);

  assert.equal(mockWs.sentData.length, 1);
  const sentBuf = mockWs.sentData[0];
  assert.equal(sentBuf.byteLength, 5 * 2, "sent 10 bytes for 5 samples");
  const int16View = new Int16Array(sentBuf);
  assert.equal(int16View[0], 0);
  assert.equal(int16View[1], Math.floor(0.5 * 0x7fff));
  assert.equal(int16View[2], -16384);
  assert.equal(int16View[3], 0x7fff);
  assert.equal(int16View[4], -32768);

  // Test handling message: Results (interim)
  dg._handleMessage({
    type: "Results",
    is_final: false,
    speech_final: false,
    channel: {
      alternatives: [{ transcript: "hello there", confidence: 0.85 }],
    },
    start: 0.1,
    duration: 1.0,
  });
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].text, "hello there");
  assert.equal(transcripts[0].isFinal, false);
  assert.equal(transcripts[0].speechFinal, false);

  // Test handling message: Results (final segment)
  dg._handleMessage({
    type: "Results",
    is_final: true,
    speech_final: false,
    channel: {
      alternatives: [{ transcript: "hello there world", confidence: 0.95 }],
    },
    start: 0.1,
    duration: 1.5,
  });
  assert.equal(transcripts.length, 2);
  assert.equal(transcripts[1].text, "hello there world");
  assert.equal(transcripts[1].isFinal, true);
  assert.equal(transcripts[1].speechFinal, false);

  // Test handling message: Results (speech final - turn complete)
  dg._handleMessage({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: {
      alternatives: [{ transcript: "how are you today?", confidence: 0.98 }],
    },
    start: 1.6,
    duration: 1.2,
  });
  assert.equal(transcripts.length, 3);
  assert.equal(transcripts[2].text, "how are you today?");
  assert.equal(transcripts[2].isFinal, true);
  assert.equal(transcripts[2].speechFinal, true);

  // Test handling message: UtteranceEnd
  dg._handleMessage({
    type: "UtteranceEnd",
  });
  assert.equal(transcripts.length, 4);
  assert.equal(transcripts[3].isUtteranceEnd, true);

  // Test close() sends CloseStream
  const closePromise = dg.close();
  assert.ok(mockWs.sentData.some((d) => typeof d === "string" && JSON.parse(d).type === "CloseStream"), "sent CloseStream");
  await closePromise;
  assert.equal(dg.isConnected, false);

  console.log("DEEPGRAM STT UNIT TEST PASSED");
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
