import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createPlayService,
  isPlayableCamera,
  PLAY_GAME_TTL_MS,
  playProxy,
} from '../../server/providers/play.js';

const PACKS = ['tfl', 'caltrans', 'fintraffic', 'nsw', 'vegvesen', 'deldot'];

/** A fake catalog: 8 still cameras per pack, spread across the globe. */
function fixtureSources() {
  const sources = [];
  PACKS.forEach((pack, p) => {
    for (let i = 0; i < 8; i++) {
      sources.push({
        id: `${pack}-${i}`,
        pack,
        name: `${pack} Road ${i}`,
        city: `${pack} City`,
        provider: `${pack} provider`,
        credit: `${pack} credit`,
        lat: -40 + p * 15 + i * 0.01,
        lon: -120 + p * 40 + i * 0.01,
        feedType: 'image',
        url: `https://cams.example/${pack}/${i}.jpg`,
      });
    }
  });
  sources.push({
    id: 'video-1',
    pack: 'tfl',
    lat: 51,
    lon: 0,
    feedType: 'hls',
    url: 'https://v.example/a.m3u8',
  });
  sources.push({
    id: 'nowhere',
    pack: 'tfl',
    lat: Number.NaN,
    lon: 0,
    feedType: 'image',
    url: 'https://x.example/a.jpg',
  });
  return sources;
}

const okFrame = async () => ({
  ok: true,
  body: Buffer.from('jpg'),
  contentType: 'image/jpeg',
});

function service(overrides = {}) {
  let n = 0;
  return createPlayService({
    getSources: async () => fixtureSources(),
    fetchFrame: okFrame,
    newId: () => `game-${++n}`,
    now: () => Date.parse('2026-10-16T12:00:00Z'),
    ...overrides,
  });
}

test('only located still cameras outside excluded packs are playable', () => {
  const [first] = fixtureSources();
  assert.ok(isPlayableCamera(first));
  assert.ok(!isPlayableCamera({ ...first, pack: 'deldot' }));
  assert.ok(!isPlayableCamera({ ...first, feedType: 'hls' }));
  assert.ok(
    isPlayableCamera({
      ...first,
      feedType: 'hls',
      snapshotUrl: 'https://s.example/a.jpg',
    }),
  );
  assert.ok(!isPlayableCamera({ ...first, lat: 120 }));
});

test('a new game reveals nothing about its cameras', async () => {
  const game = await service().createGame('random');
  assert.equal(game.rounds.length, 5);
  const text = JSON.stringify(game);
  for (const leak of [
    'lat',
    'lon',
    'Road',
    'City',
    'provider',
    'credit',
    'pack',
    'cams.example',
  ])
    assert.ok(!text.includes(leak), leak);
  assert.deepEqual(game.rounds[2], {
    index: 2,
    frameUrl: `/api/play/frame/${game.gameId}/2`,
  });
});

test('rounds come from different packs, never DelDOT or video', async () => {
  const play = service();
  const game = await play.createGame('random');
  const packs = [];
  for (let i = 0; i < 5; i++) {
    const { body } = play.guess(game.gameId, i, { skip: true });
    packs.push(body.answer.provider.split(' ')[0]);
  }
  assert.equal(new Set(packs).size, 5);
  assert.ok(!packs.includes('deldot'));
});

test('everyone gets the same daily cameras, and random games differ', async () => {
  const answers = async (play, mode) => {
    const game = await play.createGame(mode);
    return [0, 1, 2, 3, 4].map(
      (i) => play.guess(game.gameId, i, { skip: true }).body.answer.name,
    );
  };
  const a = await answers(service(), 'daily');
  const b = await answers(service(), 'daily');
  assert.deepEqual(a, b);
  const seq = [0.11, 0.73, 0.42, 0.05, 0.91, 0.36];
  let k = 0;
  const r1 = await answers(
    service({ random: () => seq[k++ % seq.length] }),
    'random',
  );
  const r2 = await answers(service({ random: () => 0.5 }), 'random');
  assert.notDeepEqual(r1, r2);
});

test('cameras whose frame fails are skipped when building a game', async () => {
  const dead = new Set(['tfl-0', 'caltrans-0', 'fintraffic-0']);
  const play = service({
    fetchFrame: async (s) => (dead.has(s.id) ? null : okFrame()),
  });
  const game = await play.createGame('daily');
  for (let i = 0; i < 5; i++) {
    const { body } = play.guess(game.gameId, i, { skip: true });
    assert.ok(!dead.has(body.answer.name.replace(' Road ', '-')));
  }
  const none = createPlayService({
    getSources: async () => fixtureSources(),
    fetchFrame: async () => null,
  });
  assert.equal(await none.createGame('random'), null);
});

test('a guess scores once, reveals the answer, and cannot be repeated', async () => {
  const play = service();
  const game = await play.createGame('random');
  const guess = play.guess(game.gameId, 0, { lat: 0, lon: 0 });
  assert.equal(guess.status, 200);
  assert.ok(guess.body.distanceKm > 0);
  assert.ok(guess.body.score >= 0 && guess.body.score <= 5000);
  assert.equal(typeof guess.body.answer.lat, 'number');
  assert.ok(guess.body.answer.name);
  assert.equal(play.guess(game.gameId, 0, { lat: 0, lon: 0 }).status, 409);
  assert.equal(play.guess(game.gameId, 1, { lat: 200, lon: 0 }).status, 400);
  assert.equal(play.guess(game.gameId, 9, { lat: 0, lon: 0 }).status, 404);
  const skipped = play.guess(game.gameId, 2, { skip: true }).body;
  assert.equal(skipped.score, 0);
  assert.equal(skipped.skipped, true);
});

test('a guess on the exact spot scores full marks', async () => {
  const play = service();
  const game = await play.createGame('daily');
  const peek = service();
  const same = await peek.createGame('daily');
  const { answer } = peek.guess(same.gameId, 0, { skip: true }).body;
  const result = play.guess(game.gameId, 0, {
    lat: answer.lat,
    lon: answer.lon,
  });
  assert.equal(result.body.distanceKm, 0);
  assert.equal(result.body.score, 5000);
});

test('expired and unknown games are not found', async () => {
  let clock = Date.parse('2026-10-16T12:00:00Z');
  const play = service({ now: () => clock });
  const game = await play.createGame('random');
  clock += PLAY_GAME_TTL_MS + 1;
  assert.equal(play.guess(game.gameId, 0, { lat: 0, lon: 0 }).status, 404);
  assert.equal((await play.frame(game.gameId, 0)).status, 404);
  assert.equal((await play.frame('missing', 0)).status, 404);
});

/** Drive the plugin's middleware with a fake request. */
async function request(plugin, method, url, body) {
  let handler;
  plugin.configurePreviewServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  const req = new EventEmitter();
  Object.assign(req, { method, url, socket: { remoteAddress: '127.0.0.1' } });
  const res = {
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(payload) {
      this.body = payload;
      this.done();
    },
  };
  const finished = new Promise((resolve) => (res.done = resolve));
  handler(req, res);
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  await finished;
  return res;
}

test('installing the plugin returns nothing, so Vite runs no post hook', () => {
  const plugin = playProxy({ service: service() });
  // connect's use() returns the app; returning it would make Vite call it.
  const server = { middlewares: { use: () => () => {} } };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
});

test('frames are proxied without fallbacks or source headers', async () => {
  let live = true;
  const play = service({ fetchFrame: async () => (live ? okFrame() : null) });
  const plugin = playProxy({ service: play });
  const created = await request(plugin, 'POST', '/games', { mode: 'daily' });
  const game = JSON.parse(created.body);
  const frame = await request(plugin, 'GET', `/frame/${game.gameId}/0`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers['Content-Type'], 'image/jpeg');
  assert.equal(frame.headers['Cache-Control'], 'no-store');
  assert.ok(!Object.keys(frame.headers).some((h) => /x-cctv/i.test(h)));
  live = false;
  assert.equal(
    (await request(plugin, 'GET', `/frame/${game.gameId}/0`)).status,
    502,
  );
  const guess = await request(plugin, 'POST', '/guess', {
    gameId: game.gameId,
    index: 0,
    lat: 10,
    lon: 10,
  });
  assert.equal(guess.status, 200);
  assert.ok('answer' in JSON.parse(guess.body));
  assert.equal((await request(plugin, 'GET', '/nope')).status, 404);
});
