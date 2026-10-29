// Hidden window: captures mic ("you") and system loopback ("them"),
// runs VAD at 16 kHz and ships speech segments to the main process.
// In streaming mode (Deepgram), also forwards raw audio frames for real-time transcription.
// Includes acoustic echo gating so computer speaker audio doesn't bleed into the mic as "You".
const api = window.assistant;
let pipelines = [];
let lastThemVoiceTime = 0;
let echoCancellationActive = true;

async function startPipeline(speaker, stream, streaming, echoCancellation) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule("vad-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const vad = new AudioWorkletNode(ctx, "vad");

  vad.port.onmessage = ({ data }) => {
    if (data.type === "level") {
      if (speaker === "them") {
        if (data.rms > 0.006) {
          lastThemVoiceTime = performance.now();
        }
      }
      api.sendLevel(speaker, data.rms);
    } else if (data.type === "frame") {
      if (streaming) {
        if (speaker === "you" && echoCancellationActive) {
          // Acoustic echo suppression: if Them is playing audio on speakers, suppress mic
          if (performance.now() - lastThemVoiceTime < 500) return;
        }
        api.sendAudioFrame(speaker, data.samples);
      }
    } else if (data.type === "segment") {
      if (speaker === "you" && echoCancellationActive) {
        // Drop any segment from mic that occurred while Them was speaking
        if (performance.now() - lastThemVoiceTime < 600) return;
      }
      api.sendSegment(speaker, data.samples);
    }
  };

  vad.port.postMessage({ command: "set-streaming", streaming, speaker });
  source.connect(vad);
  return { speaker, ctx, vad, stream };
}

async function start({ mic, system, streaming = false, echoCancellation = true }) {
  await stop();
  echoCancellationActive = echoCancellation !== false;
  lastThemVoiceTime = 0;
  const errors = [];
  if (mic) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      pipelines.push(await startPipeline("you", stream, streaming, echoCancellationActive));
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
      pipelines.push(await startPipeline("them", stream, streaming, false));
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
