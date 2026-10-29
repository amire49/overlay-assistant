// Runs in a 16 kHz AudioContext. Splits the stream into speech segments with a
// simple adaptive energy VAD and posts each finished segment (Float32Array) to the port.
// In streaming mode, forwards audio frames for cloud STT processing with voice gating.

const FRAME_MS = 1000 * 128 / 16000; // 8 ms per render quantum
const PRE_ROLL_MS = 200;     // 200ms pre-roll for fast onset
const HANGOVER_MS = 600;     // 600ms hangover for natural turn boundaries
const MAX_SEGMENT_MS = 20000;
const MIN_SPEECH_MS = 300;   // minimum duration to consider as real speech
const STREAM_BATCH_QUANTA = 6; // ~48 ms batches ≈ 768 samples

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noise = 0.003;
    this.preRoll = [];
    this.chunks = [];
    this.inSpeech = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.segmentMs = 0;
    this.levelTick = 0;
    this.streaming = false;
    this.speaker = "them";
    this.streamBatch = [];
    this.streamBatchCount = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.finish();
      } else if (e.data?.command === "set-streaming") {
        this.streaming = Boolean(e.data.streaming);
        if (e.data.speaker) this.speaker = e.data.speaker;
      }
    };
  }

  finish() {
    if (this.inSpeech && this.speechMs >= MIN_SPEECH_MS) {
      const total = this.chunks.reduce((n, c) => n + c.length, 0);
      const out = new Float32Array(total);
      let off = 0;
      for (const c of this.chunks) { out.set(c, off); off += c.length; }
      this.port.postMessage({ type: "segment", samples: out }, [out.buffer]);
    }
    this.inSpeech = false;
    this.chunks = [];
    this.silenceMs = this.speechMs = this.segmentMs = 0;
    this.flushStreamBatch();
  }

  flushStreamBatch() {
    if (this.streamBatch.length === 0) return;
    const total = this.streamBatch.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of this.streamBatch) { out.set(c, off); off += c.length; }
    this.port.postMessage({ type: "frame", samples: out }, [out.buffer]);
    this.streamBatch = [];
    this.streamBatchCount = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const frame = new Float32Array(input);

    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    // Voice activity threshold
    const minThreshold = this.speaker === "you" ? 0.010 : 0.007;
    const voiced = rms > Math.max(minThreshold, this.noise * 3);
    // Track noise floor from quiet frames
    if (!voiced) this.noise = this.noise * 0.995 + rms * 0.005;

    if (++this.levelTick % 12 === 0) this.port.postMessage({ type: "level", rms });

    if (!this.inSpeech) {
      this.preRoll.push(frame);
      if (this.preRoll.length * FRAME_MS > PRE_ROLL_MS) this.preRoll.shift();

      if (voiced) {
        this.inSpeech = true;
        this.chunks = this.preRoll;
        this.segmentMs = this.chunks.length * FRAME_MS;

        // In streaming mode, when speech begins, forward pre-roll so start of word isn't lost
        if (this.streaming) {
          for (const pr of this.preRoll) this.streamBatch.push(pr);
          this.streamBatchCount += this.preRoll.length;
        }
        this.preRoll = [];
      } else if (this.streaming && this.speaker === "them") {
        // For system audio, we can stream continuously
        this.streamBatch.push(new Float32Array(frame));
        this.streamBatchCount++;
        if (this.streamBatchCount >= STREAM_BATCH_QUANTA) this.flushStreamBatch();
      }
      return true;
    }

    // In speech
    this.chunks.push(frame);
    this.segmentMs += FRAME_MS;

    if (this.streaming) {
      this.streamBatch.push(new Float32Array(frame));
      this.streamBatchCount++;
      if (this.streamBatchCount >= STREAM_BATCH_QUANTA) {
        this.flushStreamBatch();
      }
    }

    if (voiced) {
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
    } else {
      this.silenceMs += FRAME_MS;
    }

    if (this.silenceMs >= HANGOVER_MS || this.segmentMs >= MAX_SEGMENT_MS) {
      this.finish();
    }

    return true;
  }
}

registerProcessor("vad", VadProcessor);
