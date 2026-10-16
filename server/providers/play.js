import { randomUUID } from 'node:crypto';
import { createCctvCatalog } from './cctv/catalog.js';
import { isVideoFeedType, normalizeFeedType } from './cctv/normalize.js';
import {
  fetchCctvImageFromUpstream,
  fetchTxdotSnapshot,
} from './cctv/media.js';
import { readRequestBody } from './common/request.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import {
  dailyDate,
  greatCircleKm,
  interleaveByGroup,
  isValidLatLon,
  ROUNDS_PER_GAME,
  scoreForDistance,
  seededRandom,
  seedFromString,
  shuffle,
} from '../../src/play/scoring.js';

/** Games are abandoned after this long. */
export const PLAY_GAME_TTL_MS = 30 * 60_000;
/** Cap on games held in memory; the oldest is evicted first. */
export const PLAY_MAX_GAMES = 500;
/** Cameras probed per game before giving up on filling every round. */
const MAX_PROBES = 40;
/** Cameras probed at once while building a game. */
const PROBE_BATCH = 8;
const GUESS_BODY_MAX_BYTES = 2048;

/**
 * Packs left out of the game. DelDOT's public availability is not a licence
 * to redistribute (DATA_SOURCES.md), and a game serves its frames to others.
 */
const EXCLUDED_PACKS = new Set(['deldot']);

/** Whether a catalog camera can be a round: a still image with a position. */
export function isPlayableCamera(source) {
  if (!source || EXCLUDED_PACKS.has(source.pack)) return false;
  if (!isValidLatLon(Number(source.lat), Number(source.lon))) return false;
  if (source.snapshotUrl) return true;
  return (
    Boolean(source.url) && !isVideoFeedType(normalizeFeedType(source.feedType))
  );
}

/** Fetch a camera's current still frame from its registered upstream only. */
async function fetchUpstreamFrame(source) {
  const url =
    source?.snapshotUrl ||
    (!isVideoFeedType(normalizeFeedType(source?.feedType)) ? source?.url : '');
  if (!url) return null;
  return source.sourceKind === 'txdot-its'
    ? fetchTxdotSnapshot(url)
    : fetchCctvImageFromUpstream(url);
}

/** The answer a round reveals once it has been guessed. */
function answerOf(source) {
  return {
    lat: Number(source.lat),
    lon: Number(source.lon),
    name: String(source.name || ''),
    city: String(source.city || ''),
    provider: String(source.provider || ''),
    credit: String(source.credit || ''),
  };
}

/**
 * Game state and rules, independent of HTTP. Answers stay here: a client only
 * ever holds a game id and round indexes until it guesses.
 */
export function createPlayService({
  getSources,
  fetchFrame = fetchUpstreamFrame,
  now = () => Date.now(),
  newId = randomUUID,
  random = Math.random,
} = {}) {
  /** @type {Map<string, {id:string, mode:string, date:string, createdAt:number, rounds:Array<{source:object, guessed:boolean}>}>} */
  const games = new Map();
  /** Daily camera ids per date, so every player of a day gets the same set. */
  const dailyPicks = new Map();

  const sweep = () => {
    const cutoff = now() - PLAY_GAME_TTL_MS;
    for (const [id, game] of games)
      if (game.createdAt < cutoff) games.delete(id);
    while (games.size >= PLAY_MAX_GAMES)
      games.delete(games.keys().next().value);
  };

  const getGame = (id) => {
    const game = games.get(String(id || ''));
    if (!game) return null;
    if (game.createdAt < now() - PLAY_GAME_TTL_MS) {
      games.delete(game.id);
      return null;
    }
    return game;
  };

  /** Probe candidates in small batches and keep the first that answer. */
  async function pickLive(candidates) {
    const picked = [];
    const queue = candidates.slice(0, MAX_PROBES);
    while (picked.length < ROUNDS_PER_GAME && queue.length) {
      const batch = queue.splice(0, PROBE_BATCH);
      const results = await Promise.all(
        batch.map(async (source) => {
          try {
            return (await fetchFrame(source))?.ok ? source : null;
          } catch {
            return null;
          }
        }),
      );
      for (const source of results) {
        if (source && picked.length < ROUNDS_PER_GAME) picked.push(source);
      }
    }
    return picked;
  }

  async function createGame(mode) {
    const daily = mode === 'daily';
    const date = dailyDate(new Date(now()));
    const sources = (await getSources()).filter(isPlayableCamera);
    const byId = new Map(sources.map((s) => [s.id, s]));

    let picked = null;
    if (daily && dailyPicks.has(date)) {
      picked = dailyPicks
        .get(date)
        .map((id) => byId.get(id))
        .filter(Boolean);
      if (picked.length < ROUNDS_PER_GAME) picked = null;
    }
    if (!picked) {
      // Sort first so the daily order depends on the date, not on the order
      // the catalog happened to load its packs in.
      const ordered = [...sources].sort((a, b) => (a.id < b.id ? -1 : 1));
      const rng = daily
        ? seededRandom(seedFromString(`gev-daily:${date}`))
        : random;
      const candidates = interleaveByGroup(
        shuffle(ordered, rng),
        (s) => s.pack,
      );
      picked = await pickLive(candidates);
      if (daily && picked.length === ROUNDS_PER_GAME) {
        dailyPicks.clear(); // only today's set is ever needed
        dailyPicks.set(
          date,
          picked.map((s) => s.id),
        );
      }
    }
    if (picked.length < ROUNDS_PER_GAME) return null;

    sweep();
    const game = {
      id: newId(),
      mode: daily ? 'daily' : 'random',
      date,
      createdAt: now(),
      rounds: picked.map((source) => ({ source, guessed: false })),
    };
    games.set(game.id, game);
    return {
      gameId: game.id,
      mode: game.mode,
      date: game.date,
      rounds: game.rounds.map((_, index) => ({
        index,
        frameUrl: `/api/play/frame/${game.id}/${index}`,
      })),
    };
  }

  async function frame(gameId, index) {
    const round = getGame(gameId)?.rounds[index];
    if (!round) return { status: 404 };
    const image = await fetchFrame(round.source).catch(() => null);
    if (!image?.ok) return { status: 502 };
    return { status: 200, image };
  }

  function guess(gameId, index, { lat, lon, skip = false } = {}) {
    const round = getGame(gameId)?.rounds[index];
    if (!round) return { status: 404, body: { error: 'not_found' } };
    if (round.guessed)
      return { status: 409, body: { error: 'already_guessed' } };
    if (!skip && !isValidLatLon(lat, lon))
      return { status: 400, body: { error: 'invalid_guess' } };
    round.guessed = true;
    const answer = answerOf(round.source);
    if (skip)
      return {
        status: 200,
        body: { skipped: true, distanceKm: null, score: 0, answer },
      };
    const distanceKm = greatCircleKm({ lat, lon }, answer);
    return {
      status: 200,
      body: {
        skipped: false,
        distanceKm: Math.round(distanceKm * 10) / 10,
        score: scoreForDistance(distanceKm),
        answer,
      },
    };
  }

  return { createGame, frame, guess, size: () => games.size };
}

/**
 * Vite plugin: the camera guessing game.
 *
 *   POST /api/play/games            { mode: 'daily' | 'random' } -> game
 *   GET  /api/play/frame/:game/:i   the round's live frame, no fallbacks
 *   POST /api/play/guess            { gameId, index, lat, lon } or { skip: true }
 *
 * A frame is served only from the camera's own upstream, never the CCTV
 * proxy's Street View or labelled SVG fallbacks, and with no source header,
 * so nothing but the picture hints at the answer.
 */
export function playProxy({
  sourceRoot = process.cwd(),
  getSources = createCctvCatalog({ sourceRoot }),
  service = createPlayService({ getSources }),
} = {}) {
  const play = service;
  // Players behind one proxy share a key, so the per-key allowance is roomy.
  const allowGame = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 300,
  });

  const json = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  const readJson = async (req) => {
    try {
      return JSON.parse(
        (await readRequestBody(req, GUESS_BODY_MAX_BYTES)) || '{}',
      );
    } catch {
      return null;
    }
  };

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const frameMatch = url.pathname.match(/^\/frame\/([\w-]+)\/(\d+)$/);

      if (req.method === 'GET' && frameMatch) {
        const result = await play.frame(frameMatch[1], Number(frameMatch[2]));
        if (result.status !== 200)
          return json(res, result.status, { error: 'frame_unavailable' });
        res.writeHead(200, {
          'Content-Type': result.image.contentType,
          'Cache-Control': 'no-store',
        });
        return res.end(result.image.body);
      }

      if (req.method === 'POST' && url.pathname === '/games') {
        if (!allowGame(clientKey(req)))
          return json(res, 429, { error: 'rate_limited' });
        const body = (await readJson(req)) || {};
        const game = await play.createGame(
          body.mode === 'daily' ? 'daily' : 'random',
        );
        if (!game) return json(res, 503, { error: 'not_enough_cameras' });
        return json(res, 200, game);
      }

      if (req.method === 'POST' && url.pathname === '/guess') {
        const body = await readJson(req);
        if (!body) return json(res, 400, { error: 'invalid_body' });
        const result = play.guess(body.gameId, Number(body.index), {
          lat: body.lat,
          lon: body.lon,
          skip: body.skip === true,
        });
        return json(res, result.status, result.body);
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      console.error('[Play]', error?.message || String(error));
      return json(res, 500, { error: 'play_error' });
    }
  };

  // Block body on purpose: a function returned from configureServer is run
  // by Vite as a post hook, and `use()` returns the connect app.
  const install = (server) => {
    server.middlewares.use('/api/play', handle);
  };
  return {
    name: 'play-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
