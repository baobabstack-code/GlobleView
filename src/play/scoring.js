/**
 * Pure scoring and selection rules for the camera guessing game. Shared by
 * the /api/play server route, which owns the answers, and the browser.
 */

export const ROUNDS_PER_GAME = 5;
export const MAX_ROUND_SCORE = 5000;
/** Distance at which a round is worth 1/e of the maximum. */
const SCORE_FALLOFF_KM = 1500;
const EARTH_RADIUS_KM = 6371.0088;

const D2R = Math.PI / 180;

/** Great-circle distance in kilometres between two `{ lat, lon }` points. */
export function greatCircleKm(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Points for a guess `km` away: full marks on the spot, ~0 a hemisphere off. */
export function scoreForDistance(km) {
  if (!Number.isFinite(km) || km < 0) return 0;
  const score = Math.round(MAX_ROUND_SCORE * Math.exp(-km / SCORE_FALLOFF_KM));
  return Math.max(0, Math.min(MAX_ROUND_SCORE, score));
}

/** Whether a value is a usable latitude/longitude pair. */
export function isValidLatLon(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** The UTC calendar date a daily challenge belongs to, as YYYY-MM-DD. */
export function dailyDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** A 32-bit seed derived from a string, so a date names one daily game. */
export function seedFromString(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy of `items`, in an order fixed by `random`. */
export function shuffle(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Order candidates so consecutive picks come from different groups (camera
 * packs), which spreads a game across regions. Within a group the shuffled
 * order is kept.
 */
export function interleaveByGroup(items, groupOf) {
  const groups = new Map();
  for (const item of items) {
    const key = groupOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const queues = [...groups.values()];
  const out = [];
  while (queues.some((q) => q.length)) {
    for (const q of queues) if (q.length) out.push(q.shift());
  }
  return out;
}

/** Plain-text result line for sharing a finished game. */
export function formatResult({ mode, date, total, rounds }) {
  const label = mode === 'daily' ? `GEV Daily ${date}` : 'GEV Random';
  const max = MAX_ROUND_SCORE * (rounds?.length || ROUNDS_PER_GAME);
  const bars = (rounds || [])
    .map((r) =>
      r.score >= 4000
        ? '🟩'
        : r.score >= 2000
          ? '🟨'
          : r.score > 0
            ? '🟧'
            : '⬛',
    )
    .join('');
  return `${label} — ${total.toLocaleString('en-US')}/${max.toLocaleString('en-US')} ${bars}`.trim();
}
