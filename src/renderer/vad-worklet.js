// Runs in a 16 kHz AudioContext. Splits the stream into speech segments with a
// simple adaptive energy VAD and posts each finished segment (Float32Array) to the port.

const FRAME_MS = 1000 * 128 / 16000; // 8 ms per render quantum
const PRE_ROLL_MS = 240;
const HANGOVER_MS = 700;
const MAX_SEGMENT_MS = 20000;
const MIN_SPEECH_MS = 350;

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
    this.port.onmessage = (e) => e.data === "flush" && this.finish();
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
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const frame = new Float32Array(input);

    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const voiced = rms > Math.max(0.008, this.noise * 3);
    // Track the noise floor only from quiet frames so speech doesn't raise it.
    if (!voiced) this.noise = this.noise * 0.995 + rms * 0.005;

    if (++this.levelTick % 12 === 0) this.port.postMessage({ type: "level", rms });

    if (!this.inSpeech) {
      this.preRoll.push(frame);
      if (this.preRoll.length * FRAME_MS > PRE_ROLL_MS) this.preRoll.shift();
      if (voiced) {
        this.inSpeech = true;
        this.chunks = this.preRoll;
        this.preRoll = [];
        this.segmentMs = this.chunks.length * FRAME_MS;
      }
      return true;
    }

    this.chunks.push(frame);
    this.segmentMs += FRAME_MS;
    if (voiced) {
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
    } else {
      this.silenceMs += FRAME_MS;
    }
    if (this.silenceMs >= HANGOVER_MS || this.segmentMs >= MAX_SEGMENT_MS) this.finish();
    return true;
  }
}

registerProcessor("vad", VadProcessor);
