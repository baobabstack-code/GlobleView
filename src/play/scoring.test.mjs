import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyDate,
  formatResult,
  greatCircleKm,
  interleaveByGroup,
  isValidLatLon,
  MAX_ROUND_SCORE,
  scoreForDistance,
  seededRandom,
  seedFromString,
  shuffle,
} from './scoring.js';

test('great-circle distance matches known city pairs', () => {
  const london = { lat: 51.5074, lon: -0.1278 };
  const paris = { lat: 48.8566, lon: 2.3522 };
  const sydney = { lat: -33.8688, lon: 151.2093 };
  assert.ok(Math.abs(greatCircleKm(london, paris) - 344) < 5);
  assert.ok(Math.abs(greatCircleKm(london, sydney) - 16994) < 30);
  assert.equal(greatCircleKm(paris, paris), 0);
});

test('score is full on the spot, falls steadily and bottoms out at the antipode', () => {
  assert.equal(scoreForDistance(0), MAX_ROUND_SCORE);
  let previous = MAX_ROUND_SCORE;
  for (const km of [10, 100, 500, 1500, 5000, 10000]) {
    const score = scoreForDistance(km);
    assert.ok(score < previous, `${km} km`);
    previous = score;
  }
  assert.equal(scoreForDistance(20015), 0);
  assert.equal(scoreForDistance(Number.NaN), 0);
  assert.equal(scoreForDistance(-1), 0);
});

test('lat/lon validation rejects out-of-range and non-numeric values', () => {
  assert.ok(isValidLatLon(0, 0));
  assert.ok(isValidLatLon(-90, 180));
  assert.ok(!isValidLatLon(91, 0));
  assert.ok(!isValidLatLon(0, -181));
  assert.ok(!isValidLatLon('1', 2));
});

test('a daily seed gives the same shuffle every time and differs by date', () => {
  const items = Array.from({ length: 40 }, (_, i) => i);
  const day = (d) => shuffle(items, seededRandom(seedFromString(d)));
  assert.deepEqual(day('2026-10-16'), day('2026-10-16'));
  assert.notDeepEqual(day('2026-10-16'), day('2026-10-17'));
  assert.deepEqual(
    [...day('2026-10-16')].sort((a, b) => a - b),
    items,
  );
  assert.equal(dailyDate(new Date('2026-10-16T23:59:59Z')), '2026-10-16');
});

test('interleaving spreads consecutive picks across groups', () => {
  const items = ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'];
  assert.deepEqual(
    interleaveByGroup(items, (s) => s[0]),
    ['a1', 'b1', 'c1', 'a2', 'b2', 'a3'],
  );
});

test('result line names the mode and total', () => {
  const rounds = [
    { score: 4500 },
    { score: 2500 },
    { score: 10 },
    { score: 0 },
  ];
  const line = formatResult({
    mode: 'daily',
    date: '2026-10-16',
    total: 7010,
    rounds,
  });
  assert.match(line, /^GEV Daily 2026-10-16 — 7,010\/20,000 /);
  assert.ok(line.endsWith('🟩🟨🟧⬛'));
  assert.match(
    formatResult({ mode: 'random', total: 0, rounds: [] }),
    /^GEV Random/,
  );
});
