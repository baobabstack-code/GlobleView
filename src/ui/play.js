/**
 * "Where's this camera?" — the ?mode=play game. The server owns every answer
 * (server/providers/play.js); this module shows a round's live frame, takes a
 * pin on the globe, and reveals the answer the server returns for it.
 *
 * Play mode hides everything that would name the place: the HUD and its AI
 * summary, the location bar and search, every panel, and the share hash that
 * would otherwise carry the camera's coordinates.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';
import { announceNavigationAuthority } from '../navigationPolicy.js';
import { createGame, submitGuess } from '../play/client.js';
import { PLAY_HOME_URL } from '../play/mode.js';
import {
  dailyDate,
  formatResult,
  greatCircleKm,
  MAX_ROUND_SCORE,
  ROUNDS_PER_GAME,
} from '../play/scoring.js';

const POINTER_OWNER = 'play';
const FRAME_REFRESH_MS = 10_000;
const GLOBE_ALTITUDE_M = 20_000_000;
const BEST_KEY = 'gev-play-best';

/** Best scores: `{ random: n, daily: { 'YYYY-MM-DD': n } }`. */
function readBest(storage) {
  try {
    return JSON.parse(storage?.getItem(BEST_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function writeBest(storage, best) {
  try {
    storage?.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // Storage unavailable: best scores just aren't remembered.
  }
}

/** Spherical midpoint of two `{ lat, lon }` points. */
function midpoint(a, b) {
  const r = Math.PI / 180;
  const [la1, lo1, la2] = [a.lat * r, a.lon * r, b.lat * r];
  const dLon = (b.lon - a.lon) * r;
  const bx = Math.cos(la2) * Math.cos(dLon);
  const by = Math.cos(la2) * Math.sin(dLon);
  const lat = Math.atan2(
    Math.sin(la1) + Math.sin(la2),
    Math.sqrt((Math.cos(la1) + bx) ** 2 + by ** 2),
  );
  const lon = lo1 + Math.atan2(by, Math.cos(la1) + bx);
  return { lat: lat / r, lon: ((lon / r + 540) % 360) - 180 };
}

function formatKm(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

/**
 * Install play mode. Returns a cleanup that restores the console.
 * @param {{shell: object, viewer: object, annotations: object, signal?: AbortSignal}} input
 */
export function installPlayMode({
  shell,
  viewer,
  annotations,
  signal,
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
}) {
  const root = documentRef.getElementById('play-root');
  if (!root || !viewer) return () => {};
  const $ = (id) => documentRef.getElementById(id);
  const screens = [...root.querySelectorAll('.play-screen')];

  // ---- hide everything that names the place ------------------------------
  documentRef.body.classList.add('ui-play');
  shell?.setCleanView?.(true);
  shell?.shareLinkManager?.suspendHashUpdates?.(true);
  const hud = shell?.hud;
  const savedSummaryPolicy = hud?.summaryPolicy;
  if (hud) hud.summaryPolicy = { canRequest: () => false };
  root.hidden = false;

  let destroyed = false;
  let game = null;
  let roundIndex = 0;
  let results = [];
  let guess = null;
  let refreshTimer = 0;
  let lease = null;
  let handler = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  let busy = false;

  const show = (name) => {
    for (const screen of screens)
      screen.hidden = screen.dataset.screen !== name;
    root.dataset.screen = name;
  };

  const total = () => results.reduce((sum, r) => sum + r.score, 0);
  const setHeader = () => {
    $('play-progress').textContent = game
      ? `ROUND ${Math.min(roundIndex + 1, ROUNDS_PER_GAME)}/${ROUNDS_PER_GAME}`
      : '';
    $('play-total').textContent = game
      ? `${total().toLocaleString('en-US')} PTS`
      : '';
  };

  const flyTo = ({ lat, lon }, altitude, duration = 1.8) => {
    announceNavigationAuthority('play');
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, altitude),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      duration,
    });
  };
  const flyToGlobe = () => flyTo({ lat: 20, lon: 0 }, GLOBE_ALTITUDE_M);

  // ---- pin placement -----------------------------------------------------
  const onClick = (event) => {
    if (destroyed || root.dataset.screen !== 'round' || busy) return;
    const canvas = viewer.scene.canvas;
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    const picked = pickWorldFromScreen(
      viewer,
      event.position.x / w,
      event.position.y / h,
    );
    if (!picked) return;
    guess = { lat: picked.lat, lon: picked.lon };
    void annotations?.annotate(
      [
        {
          type: 'pin',
          latitude: guess.lat,
          longitude: guess.lon,
          label: 'Your guess',
          color: 'cyan',
        },
      ],
      { clearPrevious: true },
    );
    $('play-guess').disabled = false;
    $('play-hint').textContent =
      'Happy with that? Hit Guess — or click again to move the pin.';
  };

  const bindPointer = () => {
    if (handler) return true;
    lease = claimPointer(POINTER_OWNER);
    if (!lease) {
      $('play-hint').textContent =
        `${pointerOwner()} is using the pointer — close it first.`;
      return false;
    }
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // Borrow the Viewer's stock select/track clicks so a pin dropped on a
    // contact doesn't also select it (same as the draw tool).
    const stock = viewer.screenSpaceEventHandler;
    savedSingleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
    savedDoubleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
      null;
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    return true;
  };

  const releasePointerHandler = () => {
    handler?.destroy();
    handler = null;
    const stock = viewer.screenSpaceEventHandler;
    if (savedSingleClick)
      stock?.setInputAction(
        savedSingleClick,
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
    if (savedDoubleClick)
      stock?.setInputAction(
        savedDoubleClick,
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    savedSingleClick = savedDoubleClick = null;
    releasePointer(lease);
    lease = null;
  };

  // ---- the live frame ------------------------------------------------------
  const frame = $('play-frame');
  const shot = $('play-frame-shot');
  const frameError = $('play-frame-error');
  const loadFrame = () => {
    const round = game?.rounds[roundIndex];
    if (!round) return;
    const next = new Image();
    next.onload = () => {
      if (destroyed || game?.rounds[roundIndex] !== round) return;
      frame.src = next.src;
      shot.hidden = false;
      frameError.hidden = true;
    };
    next.onerror = () => {
      if (destroyed || game?.rounds[roundIndex] !== round) return;
      // Keep the last good frame; only say so when there never was one.
      if (!frame.getAttribute('src')) {
        shot.hidden = true;
        frameError.hidden = false;
      }
    };
    next.src = `${round.frameUrl}?t=${Date.now()}`;
  };
  const stopFrames = () => clearInterval(refreshTimer);

  // ---- game flow -----------------------------------------------------------
  const renderBest = () => {
    const best = readBest(storage);
    const today = best.daily?.[dailyDate()];
    $('play-daily-best').textContent =
      today != null
        ? `Today's best: ${today.toLocaleString('en-US')}`
        : 'Same 5 cameras for everyone today';
    $('play-random-best').textContent =
      best.random != null
        ? `Best: ${best.random.toLocaleString('en-US')}`
        : '5 random cameras';
  };

  const showUnavailable = () => {
    $('play-home-link').href = PLAY_HOME_URL;
    show('unavailable');
  };

  const startRound = () => {
    guess = null;
    busy = false;
    void annotations?.clear?.();
    frame.removeAttribute('src');
    shot.hidden = true;
    frameError.hidden = true;
    $('play-guess').disabled = true;
    $('play-hint').textContent = 'Click the globe to drop your pin.';
    $('play-feed-label').textContent =
      `FEED-${String(roundIndex + 1).padStart(2, '0')} // UNKNOWN`;
    setHeader();
    show('round');
    flyToGlobe();
    loadFrame();
    stopFrames();
    refreshTimer = setInterval(loadFrame, FRAME_REFRESH_MS);
  };

  const start = async (mode) => {
    if (busy) return;
    busy = true;
    const status = $('play-start-status');
    status.textContent = 'Finding live cameras…';
    const response = await createGame(mode);
    busy = false;
    if (destroyed) return;
    if (response.unavailable) return showUnavailable();
    if (!response.ok) {
      status.textContent =
        response.status === 503
          ? 'Not enough cameras are answering right now. Try again in a minute.'
          : response.status === 429
            ? 'Too many games started. Wait a moment.'
            : 'Could not start a game. Try again.';
      return;
    }
    status.textContent = '';
    game = response.data;
    roundIndex = 0;
    results = [];
    if (!bindPointer()) return;
    startRound();
  };

  const reveal = async (skip) => {
    if (busy || !game) return;
    if (!skip && !guess) return;
    busy = true;
    stopFrames();
    const response = await submitGuess(
      game.gameId,
      roundIndex,
      skip ? { skip: true } : guess,
    );
    if (destroyed) return;
    if (!response.ok) {
      busy = false;
      if (response.unavailable) return showUnavailable();
      $('play-hint').textContent =
        response.status === 404
          ? 'This game expired. Start a new one.'
          : 'Could not submit that guess. Try again.';
      return;
    }
    const { score, distanceKm, answer, skipped } = response.data;
    results.push({ score, distanceKm, answer, skipped });
    setHeader();

    $('play-reveal-tag').textContent =
      `[ ROUND ${roundIndex + 1} OF ${ROUNDS_PER_GAME} ]`;
    $('play-round-score').textContent = score.toLocaleString('en-US');
    $('play-distance').textContent = skipped
      ? 'Skipped — here is where it was.'
      : `Your pin was ${formatKm(distanceKm)} away.`;
    $('play-answer-name').textContent = answer.name || 'Unnamed camera';
    $('play-answer-city').textContent = answer.city || '—';
    $('play-answer-credit').textContent =
      answer.credit || answer.provider || '—';
    $('play-next').textContent =
      roundIndex + 1 < ROUNDS_PER_GAME ? 'Next round' : 'See results';
    show('reveal');

    const specs = [
      {
        type: 'pin',
        latitude: answer.lat,
        longitude: answer.lon,
        label: 'Camera',
        color: 'green',
      },
    ];
    if (guess && !skipped) {
      specs.push(
        {
          type: 'pin',
          latitude: guess.lat,
          longitude: guess.lon,
          label: 'Your guess',
          color: 'cyan',
        },
        {
          type: 'arrow',
          latitude: guess.lat,
          longitude: guess.lon,
          toLatitude: answer.lat,
          toLongitude: answer.lon,
          color: 'amber',
        },
      );
    }
    void annotations?.annotate(specs, { clearPrevious: true });
    // Frame both points: altitude grows with how far apart they are.
    const span = guess && !skipped ? greatCircleKm(guess, answer) : 0;
    const centre = guess && !skipped ? midpoint(guess, answer) : answer;
    flyTo(
      centre,
      Math.min(GLOBE_ALTITUDE_M, Math.max(60_000, span * 1800)),
      2.2,
    );
  };

  const finish = () => {
    const sum = total();
    const best = readBest(storage);
    let line = '';
    if (game.mode === 'daily') {
      const previous = best.daily?.[game.date];
      line =
        previous == null || sum > previous
          ? 'New best for today!'
          : `Today's best: ${previous.toLocaleString('en-US')}`;
      // Keep only recent days.
      const daily = Object.fromEntries(
        Object.entries({
          ...best.daily,
          [game.date]: Math.max(sum, previous ?? 0),
        })
          .sort()
          .slice(-14),
      );
      writeBest(storage, { ...best, daily });
    } else {
      line =
        best.random == null || sum > best.random
          ? 'New best!'
          : `Best: ${best.random.toLocaleString('en-US')}`;
      writeBest(storage, { ...best, random: Math.max(sum, best.random ?? 0) });
    }
    $('play-results-tag').textContent =
      game.mode === 'daily'
        ? `[ DAILY CHALLENGE · ${game.date} ]`
        : '[ RANDOM GAME ]';
    $('play-final-score').textContent = sum.toLocaleString('en-US');
    $('play-best').textContent = line;
    const list = $('play-rounds');
    list.replaceChildren(
      ...results.map((r) => {
        const li = documentRef.createElement('li');
        const place = documentRef.createElement('span');
        place.textContent = r.answer.city || r.answer.name || 'Camera';
        const pts = documentRef.createElement('b');
        pts.textContent = `${r.score.toLocaleString('en-US')}`;
        const km = documentRef.createElement('small');
        km.textContent = r.skipped ? 'Skipped' : formatKm(r.distanceKm);
        li.append(place, km, pts);
        return li;
      }),
    );
    show('results');
    $('play-progress').textContent = 'COMPLETE';
    void annotations?.clear?.();
    flyToGlobe();
  };

  const next = () => {
    roundIndex += 1;
    if (roundIndex >= ROUNDS_PER_GAME) finish();
    else startRound();
  };

  const copy = async () => {
    const text = formatResult({
      mode: game?.mode,
      date: game?.date,
      total: total(),
      rounds: results,
    });
    const button = $('play-copy');
    try {
      await navigator.clipboard.writeText(`${text}\n${PLAY_HOME_URL}`);
      button.textContent = 'Copied ✓';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = 'Copy result'), 1800);
  };

  // ---- wiring --------------------------------------------------------------
  const listeners = [];
  const on = (el, type, fn) => {
    el?.addEventListener(type, fn);
    listeners.push([el, type, fn]);
  };
  for (const button of root.querySelectorAll('[data-start]'))
    on(button, 'click', () => void start(button.dataset.start));
  on($('play-guess'), 'click', () => void reveal(false));
  on($('play-skip'), 'click', () => void reveal(true));
  on($('play-next'), 'click', next);
  on($('play-again'), 'click', () => {
    game = null;
    setHeader();
    renderBest();
    show('start');
  });
  on($('play-copy'), 'click', () => void copy());
  on(documentRef, 'keydown', (event) => {
    if (event.key !== 'Enter' || event.target?.closest?.('button, a, input'))
      return;
    if (root.dataset.screen === 'round' && guess) void reveal(false);
    else if (root.dataset.screen === 'reveal') next();
  });

  renderBest();
  show('start');
  setHeader();
  flyToGlobe();

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    stopFrames();
    releasePointerHandler();
    for (const [el, type, fn] of listeners) el?.removeEventListener(type, fn);
    void annotations?.clear?.();
    if (hud) hud.summaryPolicy = savedSummaryPolicy;
    shell?.shareLinkManager?.suspendHashUpdates?.(false);
    documentRef.body.classList.remove('ui-play');
    root.hidden = true;
  };
  signal?.addEventListener('abort', destroy, { once: true });
  return destroy;
}
