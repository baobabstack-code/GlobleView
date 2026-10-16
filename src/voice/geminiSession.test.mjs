import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiSession, fetchGeminiToken } from './geminiSession.js';
import {
  base64ToFloat32,
  floatToPcm16,
  openGeminiSocket,
  parseServerFrame,
  pcm16ToBase64,
} from './geminiLiveConnection.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A Gemini session wired to fakes; returns handles to inspect. */
function harness({ runAction, captureViewport } = {}) {
  const events = [];
  const sockets = [];
  const tokens = [];
  const played = [];
  let flushes = 0;
  const mic = { started: false, stopped: false };
  const session = createGeminiSession({
    emit: (e) => events.push(e),
    runAction: runAction || (async (name, args) => ({ ok: true, name, args })),
    ui: { root: { dataset: {} } },
    fetchToken: async () => {
      tokens.push(tokens.length);
      return {
        token: `t${tokens.length}`,
        wsUrl: 'wss://example/live',
        setup: { setup: { model: 'models/m', sessionResumption: {} } },
        anyValuePaths: { analyst_query: ['filters.[].value'] },
      };
    },
    openSocket: async (options) => {
      const socket = {
        options,
        sent: [],
        closed: false,
        send(p) {
          this.sent.push(p);
        },
        close() {
          this.closed = true;
        },
      };
      sockets.push(socket);
      return socket;
    },
    createMic: ({ onChunk }) => ({
      async start() {
        mic.started = true;
        mic.onChunk = onChunk;
      },
      stop() {
        mic.stopped = true;
      },
    }),
    createPlayer: () => ({
      enqueue: (d) => played.push(d),
      flush: () => (flushes += 1),
      close() {},
    }),
    captureViewport: captureViewport || (async () => null),
  });
  const server = (message) => sockets.at(-1).options.onMessage(message);
  return {
    session,
    events,
    sockets,
    tokens,
    played,
    mic,
    server,
    flushes: () => flushes,
  };
}

test('start opens the mic, connects with the token and setup, and reports listening', async () => {
  const h = harness();
  await h.session.start();
  assert.ok(h.mic.started);
  assert.equal(h.sockets[0].options.token, 't1');
  assert.equal(h.sockets[0].options.setup.setup.model, 'models/m');
  assert.equal(h.events.at(-1).state, 'listening');
  // Microphone chunks stream as 16 kHz PCM.
  h.mic.onChunk(new Int16Array([0, 1000, -1000]));
  assert.deepEqual(Object.keys(h.sockets[0].sent[0].realtimeInput.audio), [
    'mimeType',
    'data',
  ]);
  assert.equal(
    h.sockets[0].sent[0].realtimeInput.audio.mimeType,
    'audio/pcm;rate=16000',
  );
  assert.equal(h.session.capabilities.costControls, false);
});

test('transcripts become captions, and a finished turn is completed', async () => {
  const h = harness();
  await h.session.start();
  h.server({ serverContent: { inputTranscription: { text: 'Take me ' } } });
  h.server({ serverContent: { inputTranscription: { text: 'to Tokyo' } } });
  h.server({
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } },
        ],
      },
    },
  });
  h.server({ serverContent: { outputTranscription: { text: 'Flying ' } } });
  h.server({ serverContent: { outputTranscription: { text: 'to Tokyo.' } } });
  h.server({ serverContent: { turnComplete: true } });
  const captions = h.events.filter((e) => e.type === 'transcript');
  assert.deepEqual(
    captions.map((c) => [c.role, c.text, c.final]),
    [
      ['user', 'Take me to Tokyo', true],
      ['assistant', 'Flying ', false],
      ['assistant', 'to Tokyo.', false],
      ['assistant', 'Flying to Tokyo.', true],
    ],
  );
  assert.deepEqual(h.played, ['AAA=']);
  assert.equal(h.events.at(-1).type, 'completion');
});

test('a tool call runs the action with decoded arguments and answers with its id', async () => {
  const seen = [];
  const h = harness({
    runAction: async (name, args, options) => {
      seen.push({ name, args, callId: options.callId });
      return { ok: true, count: 12 };
    },
  });
  await h.session.start();
  h.server({
    toolCall: {
      functionCalls: [
        {
          id: 'call-1',
          name: 'analyst_query',
          args: { filters: [{ field: 'altitude', op: 'gt', value: '40000' }] },
        },
      ],
    },
  });
  await tick();
  await tick();
  assert.deepEqual(seen, [
    {
      name: 'analyst_query',
      args: { filters: [{ field: 'altitude', op: 'gt', value: 40000 }] },
      callId: 'call-1',
    },
  ]);
  const reply = h.sockets[0].sent.find((m) => m.toolResponse);
  assert.deepEqual(reply, {
    toolResponse: {
      functionResponses: [
        {
          id: 'call-1',
          name: 'analyst_query',
          response: { output: { ok: true, count: 12 } },
        },
      ],
    },
  });
  assert.ok(h.events.some((e) => e.state === 'executing'));
});

test('a cancelled tool call is aborted and gets no reply', async () => {
  let aborted = false;
  const h = harness({
    runAction: (name, args, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('cancelled', 'AbortError'));
        }),
      ),
  });
  await h.session.start();
  h.server({
    toolCall: { functionCalls: [{ id: 'slow', name: 'fly_to', args: {} }] },
  });
  await tick();
  h.server({ toolCallCancellation: { ids: ['slow'] } });
  await tick();
  await tick();
  assert.ok(aborted);
  assert.equal(h.sockets[0].sent.filter((m) => m.toolResponse).length, 0);
});

test('a failing tool reports its error to the model', async () => {
  const h = harness({
    runAction: async () => {
      throw new Error('No such place');
    },
  });
  await h.session.start();
  h.server({
    toolCall: { functionCalls: [{ id: 'x', name: 'fly_to', args: {} }] },
  });
  await tick();
  await tick();
  const reply = h.sockets[0].sent.find((m) => m.toolResponse);
  assert.deepEqual(reply.toolResponse.functionResponses[0].response, {
    error: 'No such place',
  });
});

test('interruption silences playback and tells the session', async () => {
  const h = harness();
  await h.session.start();
  h.server({ serverContent: { interrupted: true } });
  assert.equal(h.flushes(), 1);
  assert.ok(h.events.some((e) => e.type === 'interruption'));
});

test('goAway reconnects with a fresh token and the latest resumption handle', async () => {
  const h = harness();
  await h.session.start();
  h.server({
    sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
  });
  h.server({
    sessionResumptionUpdate: { resumable: false, newHandle: 'not-resumable' },
  });
  h.server({ goAway: { timeLeft: '5s' } });
  await tick();
  await tick();
  assert.equal(h.sockets.length, 2);
  assert.ok(h.sockets[0].closed);
  assert.equal(h.sockets[1].options.token, 't2');
  assert.equal(h.sockets[1].options.resumeHandle, 'handle-1');
  assert.equal(h.events.at(-1).state, 'listening');
});

test('text and map events use clientContent; stop releases everything', async () => {
  const h = harness();
  await h.session.start();
  h.session.sendText('  How many flights are over Texas?  ');
  assert.equal(
    h.session.sendMapEvent({ type: 'map_annotation_outline', id: 1 }),
    true,
  );
  const [text, map] = h.sockets[0].sent;
  assert.deepEqual(text, {
    clientContent: {
      turns: [
        { role: 'user', parts: [{ text: 'How many flights are over Texas?' }] },
      ],
      turnComplete: true,
    },
  });
  assert.equal(map.clientContent.turnComplete, false);
  assert.match(
    map.clientContent.turns[0].parts[0].text,
    /^\[map event\] \{"type":"map_annotation_outline"/,
  );
  h.session.stop();
  assert.ok(h.sockets[0].closed);
  assert.ok(h.mic.stopped);
  assert.equal(h.session.sendMapEvent({}), false);
  assert.throws(() => h.session.sendText('hi'), /not connected/);
});

test('an entity-context result sends a viewport screenshot before the tool reply', async () => {
  const h = harness({
    runAction: async () => ({
      action: 'get_entity_context',
      scope: 'view',
      scene: { basemap: { viewScale: 'local' } },
    }),
    captureViewport: async () => 'data:image/jpeg;base64,SGVsbG8=',
  });
  await h.session.start();
  h.server({
    toolCall: {
      functionCalls: [{ id: 'ctx', name: 'get_entity_context', args: {} }],
    },
  });
  await tick();
  await tick();
  await tick();
  const kinds = h.sockets[0].sent.map((m) => Object.keys(m)[0]);
  assert.deepEqual(kinds, ['realtimeInput', 'toolResponse']);
  assert.deepEqual(h.sockets[0].sent[0].realtimeInput.video, {
    mimeType: 'image/jpeg',
    data: 'SGVsbG8=',
  });
});

test('the token request surfaces the server error', async () => {
  await assert.rejects(
    fetchGeminiToken({
      fetchImpl: async () =>
        Response.json({ error: 'GEMINI_API_KEY is not set' }, { status: 503 }),
    }),
    /GEMINI_API_KEY is not set/,
  );
});

test('PCM helpers round-trip and downsample', () => {
  const pcm = floatToPcm16(
    new Float32Array([0, 0.5, 0.5, -1, -1, 1]),
    48_000,
    16_000,
  );
  assert.deepEqual([...pcm], [10922, -10922]);
  const back = base64ToFloat32(
    pcm16ToBase64(new Int16Array([0, 16384, -32768])),
  );
  assert.deepEqual([...back], [0, 0.5, -1]);
});

test('the socket sends setup with the resumption handle and resolves on setupComplete', async () => {
  const instances = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      instances.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {}
  }
  const opening = openGeminiSocket({
    wsUrl: 'wss://example/live',
    token: 'auth_tokens/a b',
    setup: { setup: { model: 'models/m', sessionResumption: {} } },
    resumeHandle: 'h1',
    WebSocketImpl: FakeSocket,
  });
  await tick();
  const [socket] = instances;
  assert.equal(
    socket.url,
    'wss://example/live?access_token=auth_tokens%2Fa%20b',
  );
  assert.deepEqual(socket.sent[0].setup.sessionResumption, { handle: 'h1' });
  socket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  const handle = await opening;
  assert.equal(handle.open, true);
  assert.deepEqual(
    await parseServerFrame(new TextEncoder().encode('{"a":1}').buffer),
    { a: 1 },
  );
});
