/**
 * Browser client for the /api/play routes. Every call resolves to
 * `{ ok, status, data }`; a host without the game server (a static deploy)
 * answers `ok: false, unavailable: true` rather than throwing.
 */

async function call(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`/api/play${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, unavailable: true, data: null };
  }
  const type = response.headers.get('content-type') || '';
  // A static host answers unknown paths with its HTML page, or 404/405.
  if (!type.includes('application/json')) {
    return {
      ok: false,
      status: response.status,
      unavailable: true,
      data: null,
    };
  }
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

/** Start a game: `mode` is 'daily' or 'random'. */
export function createGame(mode, options) {
  return call('/games', { ...options, method: 'POST', body: { mode } });
}

/** Submit a guess for one round, or skip it with `{ skip: true }`. */
export function submitGuess(gameId, index, guess, options) {
  return call('/guess', {
    ...options,
    method: 'POST',
    body: { gameId, index, ...guess },
  });
}
