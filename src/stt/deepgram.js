// Main-process streaming STT via Deepgram's real-time WebSocket API.
// Sends raw 16 kHz mono PCM and receives interim + final transcripts with minimal latency.
const WebSocket = require("ws");

const DEEPGRAM_WS = "wss://api.deepgram.com/v1/listen";

class DeepgramSTT {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey    Deepgram API key
   * @param {string} [opts.model]   Deepgram model name (default: "nova-3")
   * @param {string} [opts.language] Language code (default: "en")
   * @param {function} [opts.onTranscript]  Called with { text, speaker, isFinal, speechFinal }
   * @param {function} [opts.onError]       Called on WebSocket errors
   * @param {function} [opts.onOpen]        Called when connection is ready
   * @param {function} [opts.onClose]       Called when connection closes
   */
  constructor({ apiKey, model = "nova-3", language = "en", onTranscript, onError, onOpen, onClose }) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.onOpen = onOpen;
    this.onClose = onClose;

    this.ws = null;
    this.keepAliveTimer = null;
    this.connected = false;
    this._pendingClose = null;
  }

  /** Open the streaming connection. Resolves when the socket is ready. */
  connect() {
    if (this.ws) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: this.model,
        language: this.language,
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        punctuate: "true",
        interim_results: "true",
        utterance_end_ms: "1000",
        vad_events: "true",
        smart_format: "true",
        // endpointing at 300ms for fast turn detection
        endpointing: "300",
      });

      const url = `${DEEPGRAM_WS}?${params}`;
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      this.ws.on("open", () => {
        this.connected = true;
        // Send keep-alive every 8 seconds to prevent timeout
        this.keepAliveTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, 8000);
        this.onOpen?.();
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data);
          this._handleMessage(msg);
        } catch (err) {
          this.onError?.(err);
        }
      });

      this.ws.on("error", (err) => {
        this.onError?.(err);
        if (!this.connected) reject(err);
      });

      this.ws.on("close", (code, reason) => {
        this._cleanup();
        this.onClose?.(code, String(reason));
        if (!this.connected) reject(new Error(`Deepgram WS closed: ${code}`));
      });
    });
  }

  _handleMessage(msg) {
    if (msg.type === "Results") {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;

      const text = alt.transcript?.trim();
      if (!text) return;

      this.onTranscript?.({
        text,
        isFinal: msg.is_final === true,
        speechFinal: msg.speech_final === true,
        confidence: alt.confidence ?? 0,
        start: msg.start ?? 0,
        duration: msg.duration ?? 0,
      });
    } else if (msg.type === "UtteranceEnd") {
      // Signals end of an utterance (silence detected)
      this.onTranscript?.({
        text: "",
        isFinal: true,
        speechFinal: true,
        isUtteranceEnd: true,
        confidence: 1,
        start: 0,
        duration: 0,
      });
    }
    // SpeechStarted, Metadata, etc. are ignored
  }

  /**
   * Send raw PCM audio samples to Deepgram.
   * @param {Float32Array} float32Samples  Mono 16 kHz float PCM (-1..1)
   */
  sendAudio(float32Samples) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Convert Float32 → Int16 PCM (what Deepgram expects for linear16)
    const int16 = new Int16Array(float32Samples.length);
    for (let i = 0; i < float32Samples.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Samples[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.ws.send(int16.buffer);
  }

  /** Gracefully close: tell Deepgram we're done, then close the socket. */
  async close() {
    if (!this.ws) return;
    if (this._pendingClose) return this._pendingClose;

    this._pendingClose = new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        // Send CloseStream so Deepgram flushes final results
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
        // Give it a moment to send final results, then close
        setTimeout(() => {
          this.ws?.close();
          resolve();
        }, 300);
      } else {
        this.ws?.close();
        resolve();
      }
    });
    return this._pendingClose;
  }

  _cleanup() {
    this.connected = false;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.ws = null;
    this._pendingClose = null;
  }

  get isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}

module.exports = { DeepgramSTT };

