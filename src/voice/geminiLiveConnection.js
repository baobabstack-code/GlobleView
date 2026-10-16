/**
 * Gemini Live transport for voice: the WebSocket, microphone capture as
 * 16 kHz PCM, and 24 kHz PCM playback. Protocol meaning (transcripts, tools,
 * turns) belongs to geminiSession.js; this module only moves bytes.
 */

export const GEMINI_INPUT_RATE = 16_000;
export const GEMINI_OUTPUT_RATE = 24_000;
export const GEMINI_INPUT_MIME = `audio/pcm;rate=${GEMINI_INPUT_RATE}`;
const WORKLET_URL = '/voice/pcm-capture-worklet.js';
/** Microphone audio is sent in chunks of about this many samples (40 ms). */
const CHUNK_SAMPLES = GEMINI_INPUT_RATE / 25;

// ---- PCM helpers (pure) ----------------------------------------------------

/** Average-downsample mono Float32 audio to `outRate` as Int16 PCM. */
export function floatToPcm16(samples, inRate, outRate = GEMINI_INPUT_RATE) {
  const ratio = inRate / outRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor((i + 1) * ratio)),
    );
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

/** Little-endian Int16 PCM as base64. */
export function pcm16ToBase64(pcm) {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** base64 little-endian Int16 PCM as Float32 samples in [-1, 1). */
export function base64ToFloat32(base64) {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++)
    view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < out.length; i++)
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

// ---- Playback --------------------------------------------------------------

/**
 * Plays Gemini's audio chunks back to back. `flush()` silences everything
 * queued, for barge-in and `interrupted`.
 */
export function createPcmPlayer({
  AudioContextImpl = globalThis.AudioContext,
  onSpeaking = () => {},
} = {}) {
  let ctx = null;
  let nextAt = 0;
  const sources = new Set();
  const setSpeaking = () => onSpeaking(sources.size > 0);
  return {
    enqueue(base64) {
      const samples = base64ToFloat32(base64);
      if (!samples.length) return;
      ctx ||= new AudioContextImpl({ sampleRate: GEMINI_OUTPUT_RATE });
      if (ctx.state === 'suspended') void ctx.resume?.();
      const buffer = ctx.createBuffer(1, samples.length, GEMINI_OUTPUT_RATE);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const at = Math.max(ctx.currentTime, nextAt);
      source.onended = () => {
        sources.delete(source);
        setSpeaking();
      };
      source.start(at);
      nextAt = at + buffer.duration;
      sources.add(source);
      setSpeaking();
    },
    flush() {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
      }
      sources.clear();
      nextAt = 0;
      setSpeaking();
    },
    get playing() {
      return sources.size > 0;
    },
    close() {
      this.flush();
      void ctx?.close?.();
      ctx = null;
    },
  };
}

// ---- Microphone ------------------------------------------------------------

/**
 * Captures the microphone as 16 kHz PCM chunks. `enabled` gates sending
 * (mute) without releasing the device.
 */
export function createMicCapture({
  onChunk,
  getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
  AudioContextImpl = globalThis.AudioContext,
  workletUrl = WORKLET_URL,
} = {}) {
  let stream = null;
  let ctx = null;
  let node = null;
  let pending = new Float32Array(0);
  let enabled = true;
  return {
    async start() {
      // The same capture constraints as the OpenAI connection.
      stream = await getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      ctx = new AudioContextImpl();
      await ctx.audioWorklet.addModule(workletUrl);
      const input = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'gev-pcm-capture');
      node.port.onmessage = ({ data }) => {
        if (!enabled) return;
        const merged = new Float32Array(pending.length + data.length);
        merged.set(pending);
        merged.set(data, pending.length);
        const perChunk = Math.round(
          CHUNK_SAMPLES * (ctx.sampleRate / GEMINI_INPUT_RATE),
        );
        let offset = 0;
        for (; offset + perChunk <= merged.length; offset += perChunk)
          onChunk(
            floatToPcm16(
              merged.subarray(offset, offset + perChunk),
              ctx.sampleRate,
            ),
          );
        pending = merged.slice(offset);
      };
      input.connect(node);
    },
    set enabled(value) {
      enabled = Boolean(value);
      if (!enabled) pending = new Float32Array(0);
    },
    get enabled() {
      return enabled;
    },
    stop() {
      node?.port && (node.port.onmessage = null);
      node?.disconnect?.();
      for (const track of stream?.getTracks?.() || []) track.stop();
      void ctx?.close?.();
      stream = ctx = node = null;
      pending = new Float32Array(0);
    },
  };
}

// ---- Socket ----------------------------------------------------------------

/** Parse one server frame, which may arrive as text, a Blob or an ArrayBuffer. */
export async function parseServerFrame(data) {
  let text = data;
  if (typeof Blob !== 'undefined' && data instanceof Blob)
    text = await data.text();
  else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
    text = new TextDecoder().decode(data);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Open a Live session: connect with the ephemeral token, send `setup`
 * (with a resumption handle when reconnecting), and resolve once the server
 * answers `setupComplete`. Later frames go to `onMessage`.
 */
export function openGeminiSocket({
  wsUrl,
  token,
  setup,
  resumeHandle = null,
  onMessage,
  onClose,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 20_000,
}) {
  return new Promise((resolve, reject) => {
    const url = `${wsUrl}?access_token=${encodeURIComponent(token)}`;
    const socket = new WebSocketImpl(url);
    let ready = false;
    const timer = setTimeout(() => {
      fail(new Error('Gemini Live did not answer in time'));
      try {
        socket.close();
      } catch {
        /* closing */
      }
    }, timeoutMs);
    const fail = (error) => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      reject(error);
    };
    socket.onopen = () => {
      const message = structuredClone(setup);
      if (resumeHandle)
        message.setup.sessionResumption = {
          ...message.setup.sessionResumption,
          handle: resumeHandle,
        };
      socket.send(JSON.stringify(message));
    };
    socket.onmessage = async (event) => {
      const message = await parseServerFrame(event.data);
      if (!message) return;
      if (!ready) {
        if (message.setupComplete !== undefined) {
          ready = true;
          clearTimeout(timer);
          resolve({
            send: (payload) =>
              socket.readyState === 1 && socket.send(JSON.stringify(payload)),
            close: () => socket.close(1000, 'Voice off'),
            get open() {
              return socket.readyState === 1;
            },
          });
        }
        return;
      }
      onMessage?.(message);
    };
    socket.onerror = () => fail(new Error('Gemini Live connection failed'));
    socket.onclose = (event) => {
      if (!ready)
        fail(new Error(event.reason || `Gemini Live closed (${event.code})`));
      else onClose?.(event);
    };
  });
}
