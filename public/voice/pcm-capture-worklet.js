// AudioWorklet for Gemini Live voice: forwards each mono microphone block
// (Float32, at the AudioContext's own rate) to the main thread, which
// resamples it to 16 kHz PCM. Served from /voice/ so CSP 'self' allows it.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}

registerProcessor('gev-pcm-capture', PcmCaptureProcessor);
