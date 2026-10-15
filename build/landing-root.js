/**
 * Hosted opt-in (`GEV_LANDING_ROOT=1`): serve the landing page at `/` and the
 * application at `/app`. Unset, `/` stays the application, which local runs,
 * Pinokio and the README depend on. A `/` request that carries a query
 * (`?setup=1`, `?embed=1`) is the application's, so it is served the app
 * directly; share-link hashes never reach the server, and the landing page
 * hands those to `/app` itself.
 */

const LANDING_DOCUMENT = '/landing/index.html';
const APPLICATION_DOCUMENT = '/index.html';

/** The URL to serve for a request, or `null` to leave it unchanged. */
export function landingRootRewrite(url) {
  const raw = String(url || '/');
  const queryAt = raw.indexOf('?');
  const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? '' : raw.slice(queryAt);
  if (pathname === '/' && query === '') return LANDING_DOCUMENT;
  if (pathname === '/' || pathname === '/app' || pathname === '/app/')
    return APPLICATION_DOCUMENT + query;
  return null;
}

/** Vite plugin applying the landing-root routes on dev and preview servers. */
export function landingRootPlugin({
  enabled = process.env.GEV_LANDING_ROOT === '1',
} = {}) {
  if (!enabled) return { name: 'landing-root' };
  const install = (server) => {
    server.middlewares.use((req, _res, next) => {
      const rewritten = landingRootRewrite(req.url);
      if (rewritten) req.url = rewritten;
      next();
    });
  };
  return {
    name: 'landing-root',
    configureServer: install,
    configurePreviewServer: install,
  };
}
