// God's Eye View landing page. Plain module, no dependencies; the app's CSP
// forbids inline script, so everything interactive lives here.

const root = document.documentElement;
root.classList.add('js');

// On hosts that serve this page at "/", share links and ?setup=1 still point
// there. Anything other than one of this page's section anchors belongs to
// the app, so hand it over with the query and hash intact.
const fragment = location.hash.slice(1);
const handoff =
  location.search !== '' ||
  (fragment !== '' && !document.getElementById(fragment));
if (handoff) location.replace(`/app${location.search}${location.hash}`);

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: the preference just isn't remembered */
    }
  },
  session(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      sessionStorage.setItem(key, value);
    } catch {
      return null;
    }
    return null;
  },
};

/* ------------------------------------------------------------------ boot */

function boot() {
  const el = document.getElementById('boot');
  const log = document.getElementById('boot-log');
  const fill = document.getElementById('boot-fill');
  if (!el) return;

  const finish = () => {
    el.classList.add('done');
    store.session('gev-landing-booted', '1');
    removeEventListener('keydown', finish);
  };

  if (reducedMotion || store.session('gev-landing-booted')) {
    el.classList.add('done');
    return;
  }

  el.addEventListener('click', finish);
  addEventListener('keydown', finish);

  const lines = [
    'GEV://BIOS 2090.10 — ORBITAL CONSOLE',
    '> handshake ............................ OK',
    '> mounting photoreal mesh .............. OK',
    '> ads-b transponders ................... 11,000+',
    '> ais beacons .......................... LINKED',
    '> celestrak tle catalog ................ 838 OBJ',
    '> usgs seismic / nasa firms ............ STREAMING',
    '> cctv mesh ............................ ~3,900 NODES',
    '> voice link ........................... STANDBY',
    '',
    'ALL SIGNALS PUBLIC. ALL DATA REAL.',
  ];
  let i = 0;
  const step = () => {
    if (el.classList.contains('done')) return;
    if (i < lines.length) {
      log.textContent += lines[i] + '\n';
      i += 1;
      fill.style.width = `${(i / lines.length) * 100}%`;
      setTimeout(step, i === lines.length ? 420 : 95 + Math.random() * 70);
    } else {
      finish();
    }
  };
  step();
}

/* ----------------------------------------------------------------- clock */

function clocks() {
  const utc = document.getElementById('clock-utc');
  const loc = document.getElementById('clock-loc');
  const pad = (n) => String(n).padStart(2, '0');
  const tick = () => {
    const d = new Date();
    utc.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const off = -d.getTimezoneOffset() / 60;
    const sign = off >= 0 ? '+' : '−';
    loc.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${Math.abs(off)}`;
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------------------------------------------------------------- optics */

const MODES = ['normal', 'nvg', 'flir', 'crt', 'noir'];
const modeListeners = [];

function setMode(mode) {
  if (!MODES.includes(mode)) mode = 'normal';
  root.dataset.sensor = mode;
  for (const btn of document.querySelectorAll('.optics button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  }
  const hud = document.getElementById('hud-mode');
  if (hud) hud.textContent = mode.toUpperCase();
  store.set('gev-landing-optics', mode);
  for (const fn of modeListeners) fn(mode);
}

function optics() {
  for (const btn of document.querySelectorAll('.optics button')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (
      e.target instanceof HTMLElement &&
      e.target.closest('input, textarea, [contenteditable]')
    )
      return;
    const n = Number(e.key);
    if (n >= 1 && n <= MODES.length) setMode(MODES[n - 1]);
  });
  setMode(store.get('gev-landing-optics') || 'normal');
}

/* ----------------------------------------------------------------- globe */

// Rough continental masses as spherical caps [lat, lon, radius°]. Enough to
// read as Earth at dot-matrix resolution without shipping coastline data.
const LAND = [
  [60, -100, 18],
  [45, -100, 16],
  [40, -85, 12],
  [50, -120, 12],
  [65, -150, 10],
  [30, -100, 10],
  [20, -102, 7],
  [15, -88, 5],
  [72, -42, 9],
  [-5, -62, 15],
  [-20, -58, 13],
  [-35, -66, 9],
  [-48, -70, 5],
  [5, -70, 8],
  [50, 10, 10],
  [57, 20, 8],
  [45, 2, 6],
  [62, 15, 7],
  [42, 13, 4],
  [40, -4, 6],
  [54, -2, 4],
  [15, 10, 13],
  [15, 30, 12],
  [0, 22, 14],
  [-15, 25, 12],
  [-28, 25, 8],
  [22, -8, 9],
  [-19, 47, 4],
  [25, 45, 10],
  [60, 60, 18],
  [60, 100, 20],
  [65, 140, 14],
  [45, 85, 15],
  [35, 105, 14],
  [30, 115, 10],
  [22, 78, 10],
  [15, 102, 7],
  [40, 135, 4],
  [36, 138, 4],
  [-2, 110, 5],
  [-4, 120, 4],
  [-5, 140, 5],
  [-25, 135, 14],
  [-30, 145, 8],
  [-20, 125, 9],
  [-42, 173, 4],
  [-82, 0, 14],
  [-80, 90, 14],
  [-80, 180, 14],
  [-80, -90, 14],
];

const CITIES = {
  lax: [33.9, -118.4],
  jfk: [40.6, -73.8],
  lhr: [51.5, -0.5],
  cdg: [49, 2.5],
  dxb: [25.3, 55.4],
  sin: [1.4, 104],
  hnd: [35.5, 139.8],
  syd: [-33.9, 151.2],
  gru: [-23.4, -46.5],
  jnb: [-26.1, 28.2],
  nbo: [-1.3, 36.9],
  del: [28.6, 77.1],
  pek: [40.1, 116.6],
  scl: [-33.4, -70.8],
  anc: [61.2, -149.9],
};
const ROUTES = [
  ['lax', 'hnd'],
  ['jfk', 'lhr'],
  ['lhr', 'dxb'],
  ['dxb', 'sin'],
  ['sin', 'syd'],
  ['gru', 'jnb'],
  ['cdg', 'nbo'],
  ['del', 'pek'],
  ['jfk', 'gru'],
  ['lax', 'syd'],
  ['hnd', 'anc'],
  ['scl', 'lax'],
  ['jnb', 'dxb'],
  ['pek', 'cdg'],
];

const D2R = Math.PI / 180;

function vec(lat, lon) {
  const la = lat * D2R;
  const lo = lon * D2R;
  return [
    Math.cos(la) * Math.sin(lo),
    Math.sin(la),
    Math.cos(la) * Math.cos(lo),
  ];
}

function isLand(v) {
  for (const [lat, lon, r] of LAND) {
    const c = vec(lat, lon);
    if (v[0] * c[0] + v[1] * c[1] + v[2] * c[2] > Math.cos(r * D2R))
      return true;
  }
  return false;
}

function slerp(a, b, t) {
  const dot = Math.min(
    1,
    Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
  );
  const om = Math.acos(dot);
  if (om < 1e-6) return a;
  const s = Math.sin(om);
  const k1 = Math.sin((1 - t) * om) / s;
  const k2 = Math.sin(t * om) / s;
  return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
}

function globe() {
  const canvas = document.getElementById('globe');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Fibonacci sphere: even dot spacing with no polar pinching.
  const N = 9000;
  const dots = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    const v = [Math.cos(th) * r, y, Math.sin(th) * r];
    dots.push({ v, land: isLand(v), stipple: i % 4 === 0 });
  }
  const landDots = dots.filter((d) => d.land);

  const graticule = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 4) line.push(vec(lat, lon));
    graticule.push(line);
  }
  for (let lon = -180; lon < 180; lon += 30) {
    const line = [];
    for (let lat = -90; lat <= 90; lat += 4) line.push(vec(lat, lon));
    graticule.push(line);
  }

  const arcs = ROUTES.map(([a, b], i) => {
    const pa = vec(...CITIES[a]);
    const pb = vec(...CITIES[b]);
    const pts = [];
    for (let s = 0; s <= 48; s++) {
      const t = s / 48;
      const p = slerp(pa, pb, t);
      const lift = 1 + Math.sin(Math.PI * t) * 0.14;
      pts.push([p[0] * lift, p[1] * lift, p[2] * lift]);
    }
    return { pts, phase: i * 0.37, speed: 0.06 + (i % 4) * 0.015 };
  });

  const orbits = [
    { inc: 51.6, raan: 20, r: 1.18, speed: 0.42, phase: 0 },
    { inc: 98, raan: 110, r: 1.3, speed: 0.3, phase: 2 },
    { inc: 28, raan: 250, r: 1.48, speed: 0.2, phase: 4 },
    { inc: 70, raan: 300, r: 1.24, speed: 0.36, phase: 1 },
  ];

  const pings = [];

  let running = false;
  let visible = true;
  let last = performance.now();

  let w = 0;
  let h = 0;
  let dpr = 1;
  let cx = 0;
  let cy = 0;
  let R = 0;
  let rgbA = '0,246,255';
  let rgbB = '255,43,214';

  const readColors = () => {
    const cs = getComputedStyle(root);
    rgbA = cs.getPropertyValue('--a-rgb').trim().replace(/\s/g, '') || rgbA;
    rgbB = cs.getPropertyValue('--b-rgb').trim().replace(/\s/g, '') || rgbB;
  };
  readColors();
  modeListeners.push(() => {
    readColors();
    if (!running) draw(performance.now());
  });

  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mobile = w < 760;
    R = mobile ? Math.min(w * 0.46, h * 0.3) : Math.min(w * 0.3, h * 0.4);
    cx = mobile ? w * 0.5 : w * 0.64;
    cy = mobile ? h * 0.7 : h * 0.52;
    if (!running) draw(performance.now());
  };

  // View rotation: yaw spins the planet, pitch tilts it toward the viewer.
  let yaw = -1.2;
  let pitch = 0.32;
  let dragVel = 0.0012;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let cosY = 1;
  let sinY = 0;
  let cosP = 1;
  let sinP = 0;

  const project = (v, out) => {
    const x1 = v[0] * cosY + v[2] * sinY;
    const z1 = -v[0] * sinY + v[2] * cosY;
    const y2 = v[1] * cosP - z1 * sinP;
    const z2 = v[1] * sinP + z1 * cosP;
    out[0] = cx + x1 * R;
    out[1] = cy - y2 * R;
    out[2] = z2;
    out[3] = Math.hypot(x1, y2);
    return out;
  };
  const P = [0, 0, 0, 0];
  // Hidden when behind the planet's disk.
  const occluded = (p) => p[2] < 0 && p[3] < 1;

  const hudLat = document.getElementById('hud-lat');
  const hudLon = document.getElementById('hud-lon');
  let hudTick = 0;

  function draw(now) {
    const t = now / 1000;
    cosY = Math.cos(yaw);
    sinY = Math.sin(yaw);
    cosP = Math.cos(pitch);
    sinP = Math.sin(pitch);

    ctx.clearRect(0, 0, w, h);

    // Atmosphere
    const atm = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.35);
    atm.addColorStop(0, `rgba(${rgbA},0.22)`);
    atm.addColorStop(0.35, `rgba(${rgbA},0.07)`);
    atm.addColorStop(1, `rgba(${rgbA},0)`);
    ctx.fillStyle = atm;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.35, 0, Math.PI * 2);
    ctx.fill();

    const core = ctx.createRadialGradient(
      cx - R * 0.3,
      cy - R * 0.35,
      R * 0.1,
      cx,
      cy,
      R,
    );
    core.addColorStop(0, `rgba(${rgbA},0.10)`);
    core.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${rgbA},0.55)`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Graticule (front hemisphere only)
    ctx.strokeStyle = `rgba(${rgbA},0.10)`;
    ctx.beginPath();
    for (const line of graticule) {
      let pen = false;
      for (const v of line) {
        project(v, P);
        if (P[2] >= 0) {
          if (pen) ctx.lineTo(P[0], P[1]);
          else ctx.moveTo(P[0], P[1]);
          pen = true;
        } else pen = false;
      }
    }
    ctx.stroke();

    // Dots
    for (const d of dots) {
      project(d.v, P);
      if (P[2] < 0) continue;
      const depth = P[2];
      if (d.land) {
        ctx.fillStyle = `rgba(${rgbA},${0.3 + depth * 0.7})`;
        const s = 1 + depth * 1.3;
        ctx.fillRect(P[0] - s / 2, P[1] - s / 2, s, s);
      } else if (d.stipple) {
        // Sparse ocean stipple keeps the sphere's form without competing with land.
        ctx.fillStyle = `rgba(${rgbA},${0.04 + depth * 0.08})`;
        ctx.fillRect(P[0] - 0.5, P[1] - 0.5, 1, 1);
      }
    }

    // Seismic / fire pings on random land points
    if (!reducedMotion && Math.random() < 0.05 && pings.length < 10) {
      pings.push({
        v: landDots[(Math.random() * landDots.length) | 0].v,
        born: t,
      });
    }
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i];
      const age = t - p.born;
      if (age > 2.2) {
        pings.splice(i, 1);
        continue;
      }
      project(p.v, P);
      if (P[2] < 0.05) continue;
      const k = age / 2.2;
      ctx.strokeStyle = `rgba(${rgbB},${(1 - k) * 0.9})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(P[0], P[1], 2 + k * 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(${rgbB},${1 - k})`;
      ctx.fillRect(P[0] - 1.5, P[1] - 1.5, 3, 3);
    }

    // Flight arcs with travelling contacts
    ctx.lineWidth = 1;
    for (const arc of arcs) {
      ctx.strokeStyle = `rgba(${rgbA},0.28)`;
      ctx.beginPath();
      let pen = false;
      for (const v of arc.pts) {
        project(v, P);
        if (!occluded(P)) {
          if (pen) ctx.lineTo(P[0], P[1]);
          else ctx.moveTo(P[0], P[1]);
          pen = true;
        } else pen = false;
      }
      ctx.stroke();

      const f = (t * arc.speed + arc.phase) % 1;
      const idx = Math.floor(f * (arc.pts.length - 1));
      project(arc.pts[idx], P);
      if (!occluded(P)) {
        ctx.fillStyle = '#fff';
        ctx.shadowColor = `rgb(${rgbA})`;
        ctx.shadowBlur = 10;
        ctx.fillRect(P[0] - 1.6, P[1] - 1.6, 3.2, 3.2);
        ctx.shadowBlur = 0;
      }
    }

    // Orbits and satellites
    for (const o of orbits) {
      const inc = o.inc * D2R;
      const raan = o.raan * D2R;
      const ci = Math.cos(inc);
      const si = Math.sin(inc);
      const cr = Math.cos(raan);
      const sr = Math.sin(raan);
      const at = (a) => {
        const x = Math.cos(a);
        const z = Math.sin(a);
        const y = z * si;
        const z2 = z * ci;
        return [(x * cr - z2 * sr) * o.r, y * o.r, (x * sr + z2 * cr) * o.r];
      };
      ctx.strokeStyle = `rgba(${rgbA},0.16)`;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      let pen = false;
      for (let s = 0; s <= 96; s++) {
        project(at((s / 96) * Math.PI * 2), P);
        if (!occluded(P)) {
          if (pen) ctx.lineTo(P[0], P[1]);
          else ctx.moveTo(P[0], P[1]);
          pen = true;
        } else pen = false;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      project(at(t * o.speed + o.phase), P);
      if (!occluded(P)) {
        ctx.strokeStyle = `rgba(${rgbB},0.95)`;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(P[0] - 4, P[1] - 4, 8, 8);
        ctx.fillStyle = `rgb(${rgbB})`;
        ctx.fillRect(P[0] - 1, P[1] - 1, 2, 2);
        ctx.lineWidth = 1;
      }
    }

    // Sub-viewer point readout
    if (hudLat && now - hudTick > 120) {
      hudTick = now;
      const lon = ((((-yaw / D2R) % 360) + 540) % 360) - 180;
      const lat = pitch / D2R;
      hudLat.textContent = `${lat >= 0 ? '+' : '−'}${Math.abs(lat).toFixed(4)}°`;
      hudLon.textContent = `${lon >= 0 ? '+' : '−'}${Math.abs(lon).toFixed(4).padStart(8, '0')}°`;
    }
  }

  const frame = (now) => {
    if (!running) return;
    const dt = Math.min(now - last, 50);
    last = now;
    if (!dragging) {
      yaw += dragVel * dt;
      dragVel += (0.00012 - dragVel) * 0.02;
    }
    draw(now);
    requestAnimationFrame(frame);
  };
  const start = () => {
    if (running || reducedMotion || !visible || document.hidden) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
  };

  // Drag to spin the planet.
  const hero = canvas.parentElement;
  hero.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a, button')) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    dragVel = 0;
  });
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    yaw += dx * 0.006;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + dy * 0.004));
    dragVel = dx * 0.0004;
    if (!running) draw(performance.now());
  });
  addEventListener('pointerup', () => {
    dragging = false;
  });

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start();
    else stop();
  }).observe(canvas);
  document.addEventListener('visibilitychange', () =>
    document.hidden ? stop() : start(),
  );

  resize();
  start();
}

/* --------------------------------------------------------------- reticle */

function reticle() {
  const el = document.getElementById('reticle');
  if (!el || !finePointer || reducedMotion) return;
  let x = -100;
  let y = -100;
  let tx = x;
  let ty = y;
  addEventListener('pointermove', (e) => {
    tx = e.clientX;
    ty = e.clientY;
    el.classList.add('on');
    el.classList.toggle(
      'lock',
      !!e.target.closest?.('a, button, .feed, .monitor'),
    );
  });
  document.addEventListener('pointerleave', () => el.classList.remove('on'));
  const loop = () => {
    x += (tx - x) * 0.25;
    y += (ty - y) * 0.25;
    el.style.transform = `translate(${x}px, ${y}px)`;
    requestAnimationFrame(loop);
  };
  loop();
}

/* ------------------------------------------------- reveal and counters */

function reveals() {
  const items = document.querySelectorAll('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    document.querySelectorAll('[data-count]').forEach(finishCount);
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const siblings = [...el.parentElement.children].filter((c) =>
          c.classList.contains('reveal'),
        );
        el.style.transitionDelay = `${Math.min(siblings.indexOf(el), 8) * 60}ms`;
        el.classList.add('in');
        el.querySelectorAll('[data-count]').forEach(countUp);
        io.unobserve(el);
      }
    },
    { threshold: 0.12 },
  );
  items.forEach((el) => io.observe(el));
}

function label(el, n) {
  el.textContent = `${el.dataset.prefix || ''}${Math.round(n).toLocaleString('en-US')}${el.dataset.suffix || ''}`;
}
function finishCount(el) {
  label(el, Number(el.dataset.count));
}
function countUp(el) {
  const target = Number(el.dataset.count);
  const t0 = performance.now();
  const dur = 1600;
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    label(el, target * (1 - Math.pow(1 - k, 4)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ----------------------------------------------------------------- voice */

// Commands from the README's voice section (the product's test suite and playbook).
const VOICE = {
  direct: {
    ack: 'CAMERA',
    lines: [
      'Take me to Tokyo.',
      'Orbit around this area slowly.',
      'Draw the walking route from the Capitol to Zilker Park.',
      'Fly the route we just drew.',
      'Zoom out to a globe view.',
    ],
  },
  annotate: {
    ack: 'WHITEBOARD',
    lines: [
      'Outline the state of Texas.',
      'Annotate the Texas State Capitol and its grounds.',
      'How far is the Eiffel Tower from the Louvre?',
      'Clear the map.',
    ],
  },
  interrogate: {
    ack: 'ANALYST',
    lines: [
      'How many flights are over Texas right now?',
      'Which ships are headed to Oakland?',
      'What is the biggest fire near Los Angeles?',
      'Is anything flying above forty thousand feet?',
      'When does the ISS pass over next?',
    ],
  },
  operate: {
    ack: 'CONSOLE',
    lines: [
      'Switch to night vision and turn on the flights layer.',
      'Turn on the camera viewsheds.',
      'Play a news radio station near Austin.',
      'Track that plane.',
      'Enter Cockpit.',
    ],
  },
};

function voice() {
  const text = document.getElementById('voice-text');
  const ack = document.getElementById('voice-ack');
  const bars = [...document.querySelectorAll('.wave i')];
  const tabs = [...document.querySelectorAll('.voice-tabs button')];
  if (!text) return;

  let cat = 'direct';
  let idx = 0;
  let timer = 0;
  let speaking = false;

  const animateWave = () => {
    for (const [i, b] of bars.entries()) {
      const base = speaking
        ? 20 + Math.random() * 80
        : 8 + Math.sin(performance.now() / 300 + i) * 4;
      b.style.height = `${base}%`;
    }
  };
  if (!reducedMotion) setInterval(animateWave, 110);

  const select = (next) => {
    cat = next;
    idx = 0;
    for (const t of tabs)
      t.setAttribute('aria-selected', String(t.dataset.cat === cat));
    run();
  };

  const run = () => {
    clearTimeout(timer);
    const { lines, ack: tag } = VOICE[cat];
    const line = lines[idx % lines.length];
    text.textContent = '';
    ack.textContent = '';
    if (reducedMotion) {
      text.textContent = `“${line}”`;
      ack.textContent = `✓ ${tag} // ACTION CONFIRMED`;
      timer = setTimeout(() => {
        idx += 1;
        run();
      }, 4000);
      return;
    }
    speaking = true;
    let c = 0;
    const full = `“${line}”`;
    const type = () => {
      c += 1;
      text.textContent = full.slice(0, c);
      if (c < full.length) {
        timer = setTimeout(type, 28 + Math.random() * 40);
      } else {
        speaking = false;
        timer = setTimeout(() => {
          ack.textContent = `▸ reading scene context …`;
          timer = setTimeout(() => {
            ack.textContent = `✓ ${tag} // ACTION CONFIRMED`;
            timer = setTimeout(() => {
              idx += 1;
              run();
            }, 2000);
          }, 650);
        }, 300);
      }
    };
    type();
  };

  for (const t of tabs) {
    t.addEventListener('click', () => select(t.dataset.cat));
    t.addEventListener('keydown', (e) => {
      if (
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowRight' &&
        e.key !== 'ArrowLeft'
      )
        return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(tabs.indexOf(t) + dir + tabs.length) % tabs.length];
      next.focus();
      select(next.dataset.cat);
    });
  }

  // Only start typing once the terminal is on screen.
  new IntersectionObserver(([entry], obs) => {
    if (entry.isIntersecting) {
      run();
      obs.disconnect();
    }
  }).observe(text);
}

/* ------------------------------------------------------------------ copy */

function copyButtons() {
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const src = document.getElementById(btn.dataset.copy);
      const value = src.textContent.replace(/^\$ /gm, '').trim();
      try {
        await navigator.clipboard.writeText(value);
        btn.textContent = 'COPIED ✓';
      } catch {
        btn.textContent = 'SELECT + COPY';
      }
      setTimeout(() => (btn.textContent = 'COPY'), 1800);
    });
  }
}

if (!handoff) {
  boot();
  clocks();
  optics();
  globe();
  reticle();
  reveals();
  voice();
  copyButtons();
}
