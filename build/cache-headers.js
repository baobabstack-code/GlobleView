/**
 * Long-lived browser caching for `vite preview`, which otherwise sends every
 * file `Cache-Control: no-cache`, so each visit re-checks every file. On a
 * slow, high-latency connection those checks are seconds each.
 *
 * - `/assets/*` names carry a content hash, so a year and `immutable` is safe.
 * - `/cesium/*` and `/models/*` keep fixed names, so they get a day: after a
 *   Cesium upgrade, a visitor can run the old engine copy for up to that long.
 *
 * Documents (`/`, `/app`, `/landing/*`) and `/api/*` are untouched.
 */

const HASHED = 'public, max-age=31536000, immutable';
const STABLE = 'public, max-age=86400';

/** The Cache-Control a request path gets, or null to leave it as served. */
export function cacheControlFor(url) {
  const path = String(url || '/').split(/[?#]/)[0];
  if (path.startsWith('/assets/')) return HASHED;
  if (path.startsWith('/cesium/') || path.startsWith('/models/')) return STABLE;
  return null;
}

/** Vite plugin applying cacheControlFor on the preview server. */
export function cacheHeadersPlugin() {
  return {
    name: 'cache-headers',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const policy = cacheControlFor(req.url);
        if (!policy) return next();
        // sirv writes its own Cache-Control after this runs, so swap it on
        // the way out rather than setting ours first.
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) =>
          String(name).toLowerCase() === 'cache-control'
            ? setHeader(name, policy)
            : setHeader(name, value);
        setHeader('Cache-Control', policy);
        next();
      });
    },
  };
}
