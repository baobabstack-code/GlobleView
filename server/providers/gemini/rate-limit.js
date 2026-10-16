import { makeCostRateLimiter } from '../common/rate-limit.js';

/** Requests/min/IP when GEV_RATELIMIT_GEMINI_PER_MIN is unset (as OpenAI). */
export const GEMINI_DEFAULT_PER_MIN = 30;

// Built on first request, after .env has reached process.env (see
// openai/rate-limit.js for why this can't run at import time).
let _geminiRateLimiter;

/** Gemini cost endpoints (voice token + HUD summary). Null only when set to 0. */
export function geminiRateLimiter() {
  if (_geminiRateLimiter === undefined)
    _geminiRateLimiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_GEMINI_PER_MIN,
      GEMINI_DEFAULT_PER_MIN,
    );
  return _geminiRateLimiter;
}
