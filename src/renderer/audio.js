// Hidden window: captures mic ("you") and system loopback ("them"),
// runs VAD at 16 kHz and ships speech segments to the main process.
const api = window.assistant;
let pipelines = [];

async function startPipeline(speaker, stream) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule("vad-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const vad = new AudioWorkletNode(ctx, "vad");
  vad.port.onmessage = ({ data }) => {
    if (data.type === "segment") api.sendSegment(speaker, data.samples);
    else api.sendLevel(speaker, data.rms);
  };
  source.connect(vad);
  return { speaker, ctx, vad, stream };
}

async function start({ mic, system }) {
  await stop();
  const errors = [];
  if (mic) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      pipelines.push(await startPipeline("you", stream));
    } catch (err) {
      errors.push(`Microphone: ${err.message}`);
    }
  }
  if (system) {
    try {
      // main's display-media handler answers with the primary screen + loopback audio
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) throw new Error("no loopback audio track");
      pipelines.push(await startPipeline("them", stream));
    } catch (err) {
      errors.push(`System audio: ${err.message}`);
    }
  }
  api.audioStatus({ running: pipelines.map((p) => p.speaker), errors });
}

async function stop() {
  for (const p of pipelines) {
    p.vad.port.postMessage("flush");
    p.stream.getTracks().forEach((t) => t.stop());
  }
  // give the flush a moment to post its final segment
  if (pipelines.length) await new Promise((r) => setTimeout(r, 50));
  for (const p of pipelines) await p.ctx.close();
  pipelines = [];
}

api.onAudioStart(start);
api.onAudioStop(async () => {
  await stop();
  api.audioStatus({ running: [], errors: [] });
});
