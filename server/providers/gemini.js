import { enforceRateLimit } from './openai/rate-limit.js';
import { realtimeInstructions } from './openai/instructions.js';
import { GEV_REALTIME_TOOLS } from './openai/tools.js';
import { geminiRateLimiter } from './gemini/rate-limit.js';
import { sameSiteGated } from './common/same-site.js';
import {
  anyValuePaths,
  toGeminiFunctionDeclarations,
} from '../../src/voice/geminiTools.js';

/** Current Live API model (ai.google.dev/gemini-api/docs/models). */
export const GEMINI_LIVE_MODEL_DEFAULT = 'gemini-3.8-live';
export const GEMINI_LIVE_VOICE_DEFAULT = 'Kore';
export const GEMINI_AUTH_TOKENS_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
/** The browser connects here with `?access_token=` (ephemeral token). */
export const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

/** A token may open one session within this window, then lives this long. */
const NEW_SESSION_WINDOW_MS = 60_000;
const TOKEN_LIFETIME_MS = 30 * 60_000;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * The Live session's first WebSocket message. The browser sends it as is,
 * adding `sessionResumption.handle` when it reconnects.
 */
export function buildGeminiSetup({ model, voice, instructions, tools }) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
      systemInstruction: { parts: [{ text: instructions }] },
      tools: [{ functionDeclarations: toGeminiFunctionDeclarations(tools) }],
      realtimeInputConfig: { automaticActivityDetection: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
    },
  };
}

/**
 * POST /api/voice/gemini/token — mint a single-use ephemeral token with the
 * server's GEMINI_API_KEY and return it with the session setup. The key
 * never leaves the server.
 */
export function createGeminiTokenHandler({
  annotationGuidance,
  endpoint = GEMINI_AUTH_TOKENS_ENDPOINT,
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.GEMINI_API_KEY,
  tools = GEV_REALTIME_TOOLS,
  now = () => Date.now(),
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' && req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    if (!enforceRateLimit(geminiRateLimiter(), req, res)) return;
    const apiKey = resolveApiKey();
    if (!apiKey)
      return sendJson(res, 503, { error: 'GEMINI_API_KEY is not set' });

    const model = process.env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODEL_DEFAULT;
    const voice = process.env.GEMINI_LIVE_VOICE || GEMINI_LIVE_VOICE_DEFAULT;
    let setup;
    try {
      setup = buildGeminiSetup({
        model,
        voice,
        instructions: realtimeInstructions(annotationGuidance),
        tools,
      });
    } catch (error) {
      console.warn('[gemini-token] tool conversion failed:', error.message);
      return sendJson(res, 500, { error: 'Voice tools could not be prepared' });
    }

    const issuedAt = now();
    const expiresAt = new Date(issuedAt + TOKEN_LIFETIME_MS).toISOString();
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          uses: 1,
          expireTime: expiresAt,
          newSessionExpireTime: new Date(
            issuedAt + NEW_SESSION_WINDOW_MS,
          ).toISOString(),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.name) {
        console.warn(`[gemini-token] upstream HTTP ${response.status}`);
        return sendJson(res, response.ok ? 502 : response.status, {
          error: 'Failed to create Gemini token',
        });
      }
      return sendJson(res, 200, {
        token: data.name,
        expiresAt: data.expireTime || expiresAt,
        model,
        wsUrl: process.env.GEMINI_LIVE_WS_URL || GEMINI_LIVE_WS_URL,
        setup,
        anyValuePaths: anyValuePaths(tools),
      });
    } catch {
      console.warn('[gemini-token] mint failed');
      return sendJson(res, 502, { error: 'Failed to create Gemini token' });
    }
  };
}

/**
 * GET /api/voice/providers — which voice providers this server has keys for,
 * and the one to use when the browser has no saved preference.
 */
export function createVoiceProvidersHandler({
  environment = process.env,
} = {}) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const openai = Boolean(environment.OPENAI_API_KEY);
    const gemini = Boolean(environment.GEMINI_API_KEY);
    const pinned = String(environment.GEV_VOICE_PROVIDER || '').toLowerCase();
    const preferred =
      pinned === 'gemini' || pinned === 'openai'
        ? pinned
        : gemini && !openai
          ? 'gemini'
          : 'openai';
    return sendJson(res, 200, { openai, gemini, default: preferred });
  };
}

/** Vite plugin: Gemini Live token and the voice provider roster. */
export function geminiLiveProxy({ annotationGuidance, realtime = {} } = {}) {
  const tools = realtime.tools || GEV_REALTIME_TOOLS;
  const install = (middlewares) => {
    middlewares.use(
      '/api/voice/gemini/token',
      sameSiteGated(createGeminiTokenHandler({ annotationGuidance, tools })),
    );
    middlewares.use(
      '/api/voice/providers',
      sameSiteGated(createVoiceProvidersHandler()),
    );
  };
  return {
    name: 'gemini-live-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
