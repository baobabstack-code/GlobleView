import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  buildGeminiSetup,
  createGeminiTokenHandler,
  createVoiceProvidersHandler,
  GEMINI_LIVE_MODEL_DEFAULT,
  geminiLiveProxy,
} from '../../server/providers/gemini.js';
import { standaloneVoiceTools } from '../../server/standalone/voiceTools.js';

/** Call a connect-style handler with a fake request and collect the reply. */
function call(handler, { method = 'POST', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    Object.assign(req, {
      method,
      url,
      headers: {
        host: 'localhost:4173',
        origin: 'http://localhost:4173',
        ...headers,
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return this.headers[name.toLowerCase()];
      },
      writeHead(status, h = {}) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
      },
      end(body = '') {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: body ? JSON.parse(body) : null,
        });
      },
    };
    Promise.resolve(handler(req, res, () => resolve({ status: 'next' }))).catch(
      reject,
    );
  });
}

const tools = standaloneVoiceTools();

test('no Gemini key: the token route refuses without calling Google', async () => {
  const handler = createGeminiTokenHandler({
    resolveApiKey: () => undefined,
    fetchImpl: () => assert.fail('must not fetch without a key'),
    tools,
  });
  const reply = await call(handler);
  assert.equal(reply.status, 503);
  assert.deepEqual(reply.body, { error: 'GEMINI_API_KEY is not set' });
  assert.equal((await call(handler, { method: 'DELETE' })).status, 405);
});

test('the token route mints a single-use token with the server key and returns the setup', async () => {
  let sent;
  const handler = createGeminiTokenHandler({
    resolveApiKey: () => 'server-key',
    now: () => Date.parse('2026-10-16T12:00:00Z'),
    tools,
    fetchImpl: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return Response.json({
        name: 'auth_tokens/abc',
        expireTime: '2026-10-16T12:30:00Z',
      });
    },
  });
  const reply = await call(handler);
  assert.equal(reply.status, 200);
  assert.equal(sent.init.headers['x-goog-api-key'], 'server-key');
  assert.deepEqual(sent.body, {
    uses: 1,
    expireTime: '2026-10-16T12:30:00.000Z',
    newSessionExpireTime: '2026-10-16T12:01:00.000Z',
  });
  const { token, model, wsUrl, setup, anyValuePaths } = reply.body;
  assert.equal(token, 'auth_tokens/abc');
  assert.equal(model, GEMINI_LIVE_MODEL_DEFAULT);
  assert.match(
    wsUrl,
    /^wss:\/\/generativelanguage\.googleapis\.com\/ws\/.*BidiGenerateContentConstrained$/,
  );
  assert.equal(setup.setup.model, `models/${GEMINI_LIVE_MODEL_DEFAULT}`);
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.ok(
    setup.setup.systemInstruction.parts[0].text.length > 200,
    'instructions included',
  );
  assert.equal(setup.setup.tools[0].functionDeclarations.length, tools.length);
  assert.deepEqual(anyValuePaths, { analyst_query: ['filters.[].value'] });
  // The browser never sees the server key.
  assert.ok(!JSON.stringify(reply.body).includes('server-key'));
});

test('an upstream refusal or network fault becomes a generic error', async () => {
  const refused = createGeminiTokenHandler({
    resolveApiKey: () => 'k',
    tools,
    fetchImpl: async () =>
      Response.json(
        { error: { message: 'API key not valid: k' } },
        { status: 400 },
      ),
  });
  const reply = await call(refused);
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.body, { error: 'Failed to create Gemini token' });
  const offline = createGeminiTokenHandler({
    resolveApiKey: () => 'k',
    tools,
    fetchImpl: async () => {
      throw new Error('ENOTFOUND generativelanguage.googleapis.com');
    },
  });
  assert.equal((await call(offline)).status, 502);
});

test('setup carries resumption, transcription and compression', () => {
  const { setup } = buildGeminiSetup({
    model: 'm',
    voice: 'Puck',
    instructions: 'hi',
    tools: [],
  });
  assert.deepEqual(setup.sessionResumption, {});
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  assert.equal(
    setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
      .voiceName,
    'Puck',
  );
});

test('the provider roster reports keys and picks a default', async () => {
  const roster = async (environment) =>
    (
      await call(createVoiceProvidersHandler({ environment }), {
        method: 'GET',
      })
    ).body;
  assert.deepEqual(await roster({}), {
    openai: false,
    gemini: false,
    default: 'openai',
  });
  assert.deepEqual(await roster({ GEMINI_API_KEY: 'g' }), {
    openai: false,
    gemini: true,
    default: 'gemini',
  });
  assert.deepEqual(await roster({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }), {
    openai: true,
    gemini: true,
    default: 'openai',
  });
  assert.equal(
    (
      await roster({
        GEMINI_API_KEY: 'g',
        OPENAI_API_KEY: 'o',
        GEV_VOICE_PROVIDER: 'Gemini',
      })
    ).default,
    'gemini',
  );
});

test('the plugin registers both routes behind the same-site gate', async () => {
  const routes = new Map();
  const plugin = geminiLiveProxy({ realtime: { tools } });
  assert.equal(
    plugin.configureServer({
      middlewares: { use: (route, fn) => routes.set(route, fn) },
    }),
    undefined,
  );
  assert.deepEqual(
    [...routes.keys()],
    ['/api/voice/gemini/token', '/api/voice/providers'],
  );
  const crossSite = await call(routes.get('/api/voice/providers'), {
    method: 'GET',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

/** Set an environment variable for one test. */
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

test('the HUD summary uses Gemini only when it is the only key', async (t) => {
  const { handleHudSummary } =
    await import('../../server/providers/openai/hud-summary.js');
  env(t, 'OPENAI_API_KEY', undefined);
  env(t, 'GEMINI_API_KEY', 'gemini-key');
  env(t, 'GEMINI_HUD_SUMMARY_MODEL', undefined);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({
      candidates: [
        {
          content: {
            parts: [{ text: 'Tokyo, flights over Shinjuku tonight!' }],
          },
        },
      ],
    });
  });
  const reply = await call(handleHudSummary);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, {
    summary: 'Tokyo flights over Shinjuku tonight',
    error: null,
  });
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].url,
    /\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/,
  );
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'gemini-key');
  assert.ok(
    calls[0].body.systemInstruction.parts[0].text.includes('five words'),
  );

  // With an OpenAI key, OpenAI keeps the HUD and Gemini is never called.
  env(t, 'OPENAI_API_KEY', 'openai-key');
  calls.length = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({
      output_text: 'Austin traffic flowing normally downtown',
    });
  });
  await call(handleHudSummary);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.openai\.com/);
});

test('a Gemini HUD failure never relays Google wording', async (t) => {
  const { handleHudSummary } =
    await import('../../server/providers/openai/hud-summary.js');
  env(t, 'OPENAI_API_KEY', undefined);
  env(t, 'GEMINI_API_KEY', 'gemini-key');
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { message: 'API key not valid. Please pass a valid API key.' } },
      { status: 400 },
    ),
  );
  const reply = await call(handleHudSummary);
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.body, {
    summary: null,
    error: 'Gemini HUD summary request failed',
  });
});
