/**
 * Gemini Live as a voice-session adapter (see session.js): turns Gemini's
 * messages into the provider-neutral events the voice card and runner use,
 * runs tool calls through `runAction`, and keeps the conversation alive
 * across Gemini's ~10 minute connections with session resumption.
 */
import {
  createMicCapture,
  createPcmPlayer,
  GEMINI_INPUT_MIME,
  openGeminiSocket,
  pcm16ToBase64,
} from './geminiLiveConnection.js';
import { createGeminiArgDecoder } from './geminiTools.js';
import {
  hasStructuredViewIdentity,
  shouldSendViewportImage,
} from './realtimeProtocol.js';
import {
  capturePointerCrop,
  captureViewportImage,
  POINTER_CROP_MAX_AGE_MS,
  POINTER_CROP_SCALES,
} from './realtimeViewport.js';

export const GEMINI_TOKEN_ENDPOINT = '/api/voice/gemini/token';
/** Reconnects allowed in a row before the session gives up. */
const MAX_RECONNECTS = 3;
/** Screenshots are throttled to Gemini's 1 frame/second guidance. */
const MIN_IMAGE_INTERVAL_MS = 1000;

/** Ask the server for a single-use token and the session setup. */
export async function fetchGeminiToken({
  endpoint = GEMINI_TOKEN_ENDPOINT,
  fetchImpl = (...args) => fetch(...args),
  signal,
} = {}) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.token)
    throw new Error(
      data?.error || `Gemini voice is unavailable (${response.status})`,
    );
  return data;
}

const dataUrlPayload = (dataUrl) => {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  return match ? { mimeType: match[1], data: match[2] } : null;
};

/** A JSON-safe copy of a tool result for `functionResponses[].response`. */
function responseFor(result) {
  try {
    return { output: JSON.parse(JSON.stringify(result ?? null)) };
  } catch {
    return { output: String(result) };
  }
}

export function createGeminiSession({
  emit,
  runAction,
  signal,
  ui = null,
  pointer = null,
  fetchToken = fetchGeminiToken,
  openSocket = openGeminiSocket,
  createMic = createMicCapture,
  createPlayer = createPcmPlayer,
  captureViewport = captureViewportImage,
  capturePointer = capturePointerCrop,
  now = () => Date.now(),
}) {
  let socket = null;
  let mic = null;
  let player = null;
  let config = null;
  let decodeArgs = createGeminiArgDecoder();
  let resumeHandle = null;
  let reconnects = 0;
  let stopped = true;
  let reconnecting = null;
  let turn = 0;
  let userText = '';
  let assistantText = '';
  let lastImageAt = 0;
  const calls = new Map();

  const setSpeaker = (speaker) => {
    if (ui?.root?.dataset) ui.root.dataset.speaker = speaker;
  };

  const send = (payload) => socket?.send(payload);

  function flushUserCaption() {
    if (!userText.trim()) return;
    emit({
      type: 'transcript',
      role: 'user',
      text: userText.trim(),
      final: true,
      itemId: `gemini-user-${turn}`,
    });
    userText = '';
  }

  function finishTurn() {
    flushUserCaption();
    if (assistantText.trim())
      emit({
        type: 'transcript',
        role: 'assistant',
        text: assistantText.trim(),
        final: true,
        itemId: `gemini-${turn}`,
        responseId: `gemini-${turn}`,
      });
    emit({
      type: 'completion',
      responseId: `gemini-${turn}`,
      status: 'completed',
    });
    assistantText = '';
    turn += 1;
  }

  async function sendScreenshotFor(result) {
    if (result?.action !== 'get_entity_context') return;
    if (now() - lastImageAt < MIN_IMAGE_INTERVAL_MS) return;
    const viewScale = result.scene?.basemap?.viewScale;
    let dataUrl = null;
    if (result.scope === 'pointer') {
      // Point-and-ask on bare ground: the crop around the pointer.
      const snapshot = pointer?.activeSnapshot?.();
      if (
        result.selected ||
        !snapshot?.fresh ||
        snapshot.target !== 'ground' ||
        !snapshot.screenPx ||
        !POINTER_CROP_SCALES.has(viewScale) ||
        now() - (Number(snapshot.capturedAt) || 0) > POINTER_CROP_MAX_AGE_MS
      )
        return;
      dataUrl = await capturePointer(snapshot.screenPx);
    } else {
      if (
        !shouldSendViewportImage(viewScale) ||
        hasStructuredViewIdentity(result)
      )
        return;
      dataUrl = await captureViewport();
    }
    const image = dataUrlPayload(dataUrl);
    if (!image || stopped) return;
    lastImageAt = now();
    send({ realtimeInput: { video: image } });
  }

  async function runToolCalls(functionCalls = []) {
    emit({ type: 'state', state: 'executing', detail: 'Working' });
    const replies = await Promise.all(
      functionCalls.map(async ({ id, name, args }) => {
        const controller = new AbortController();
        calls.set(id, controller);
        try {
          const result = await runAction(name, decodeArgs(name, args), {
            callId: id,
            signal: controller.signal,
          });
          await sendScreenshotFor(result).catch(() => {});
          return { id, name, response: responseFor(result) };
        } catch (error) {
          // Cancelled calls get no reply: Gemini already dropped them.
          if (controller.signal.aborted || error?.name === 'AbortError')
            return null;
          return {
            id,
            name,
            response: { error: error?.message || String(error) },
          };
        } finally {
          calls.delete(id);
        }
      }),
    );
    const functionResponses = replies.filter(Boolean);
    if (!stopped && functionResponses.length)
      send({ toolResponse: { functionResponses } });
    if (!stopped)
      emit({ type: 'state', state: 'listening', detail: 'Listening' });
  }

  function handleServerContent(content) {
    if (content.inputTranscription?.text) {
      userText += content.inputTranscription.text;
      setSpeaker('user');
    }
    if (content.interrupted) {
      player?.flush();
      assistantText = '';
      emit({ type: 'interruption' });
    }
    for (const part of content.modelTurn?.parts || []) {
      if (
        part.inlineData?.mimeType?.startsWith('audio/') &&
        part.inlineData.data
      ) {
        flushUserCaption();
        player?.enqueue(part.inlineData.data);
      }
    }
    if (content.outputTranscription?.text) {
      flushUserCaption();
      assistantText += content.outputTranscription.text;
      emit({
        type: 'transcript',
        role: 'assistant',
        text: content.outputTranscription.text,
        final: false,
        itemId: `gemini-${turn}`,
        responseId: `gemini-${turn}`,
      });
    }
    if (content.turnComplete) finishTurn();
  }

  function handleMessage(message) {
    if (message.serverContent) handleServerContent(message.serverContent);
    if (message.toolCall) void runToolCalls(message.toolCall.functionCalls);
    if (message.toolCallCancellation)
      for (const id of message.toolCallCancellation.ids || [])
        calls.get(id)?.abort();
    if (
      message.sessionResumptionUpdate?.resumable &&
      message.sessionResumptionUpdate.newHandle
    )
      resumeHandle = message.sessionResumptionUpdate.newHandle;
    if (message.goAway) void reconnect('Gemini rotated the connection');
  }

  async function connect() {
    config = await fetchToken({ signal });
    decodeArgs = createGeminiArgDecoder(config.anyValuePaths || {});
    socket = await openSocket({
      wsUrl: config.wsUrl,
      token: config.token,
      setup: config.setup,
      resumeHandle,
      onMessage: handleMessage,
      onClose: () => {
        if (!stopped) void reconnect('Gemini connection dropped');
      },
    });
  }

  async function reconnect(reason) {
    if (stopped || reconnecting) return reconnecting;
    if (reconnects >= MAX_RECONNECTS) {
      emit({
        type: 'state',
        state: 'error',
        detail: `${reason}; could not reconnect`,
      });
      return null;
    }
    reconnects += 1;
    const old = socket;
    socket = null;
    player?.flush();
    emit({ type: 'state', state: 'connecting', detail: 'Reconnecting' });
    reconnecting = (async () => {
      try {
        old?.close();
      } catch {
        /* already closed */
      }
      try {
        await connect();
        if (stopped) return socket?.close();
        reconnects = 0;
        emit({ type: 'state', state: 'listening', detail: 'Listening' });
      } catch (error) {
        if (!stopped)
          emit({ type: 'state', state: 'error', detail: error.message });
      } finally {
        reconnecting = null;
      }
    })();
    return reconnecting;
  }

  return {
    capabilities: { costControls: false, pushToTalk: false },
    provider: 'gemini',
    async start() {
      stopped = false;
      reconnects = 0;
      resumeHandle = null;
      turn = 0;
      userText = assistantText = '';
      player = createPlayer({
        onSpeaking: (speaking) => setSpeaker(speaking ? 'assistant' : 'idle'),
      });
      mic = createMic({
        onChunk: (pcm) =>
          send({
            realtimeInput: {
              audio: { mimeType: GEMINI_INPUT_MIME, data: pcm16ToBase64(pcm) },
            },
          }),
      });
      emit({
        type: 'state',
        state: 'connecting',
        detail: 'Requesting microphone',
      });
      await mic.start();
      if (stopped) return;
      emit({
        type: 'state',
        state: 'connecting',
        detail: 'Connecting to Gemini',
      });
      await connect();
      if (stopped) return socket?.close();
      emit({ type: 'state', state: 'listening', detail: 'Listening' });
    },
    stop() {
      stopped = true;
      for (const controller of calls.values()) controller.abort();
      calls.clear();
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      socket = null;
      mic?.stop();
      mic = null;
      player?.close();
      player = null;
      setSpeaker('idle');
    },
    sendText(text) {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (!socket) throw new Error('GEV voice is not connected');
      player?.flush();
      send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: clean }] }],
          turnComplete: true,
        },
      });
    },
    sendMapEvent(payload) {
      if (!socket) return false;
      // Context only: the model reads it with the next turn, without replying.
      send({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: `[map event] ${JSON.stringify(payload)}` }],
            },
          ],
          turnComplete: false,
        },
      });
      return true;
    },
  };
}
