import { requireFeatureSource } from '../sources/featureSource.js';
import { createOverpassFeatureSource } from '../sources/overpassFeatures.js';
import { createSurfaceServices } from './surfaceServices.js';
import { searchAndFlyTo } from '../locations.js';

function createLazyAnnotationResolver(options) {
  let pending = null;
  const ensure = () => {
    if (options.signal?.aborted)
      return Promise.reject(
        options.signal.reason ||
          new DOMException('Application was stopped', 'AbortError'),
      );
    if (pending) return pending;
    pending = import('../annotations/resolver.js')
      .then(({ createAnnotationResolver }) => createAnnotationResolver(options))
      .catch((error) => {
        pending = null;
        throw error;
      });
    return pending;
  };
  const call =
    (name) =>
    (...args) =>
      ensure().then((resolver) => resolver[name](...args));
  return Object.freeze({
    ready: ensure,
    placesNearViewRecovery: call('placesNearViewRecovery'),
    resolveAnnotationTarget: call('resolveAnnotationTarget'),
    resolveRegionRingForQuery: call('resolveRegionRingForQuery'),
  });
}

/** Assemble application operations from the caller's request services. */
export function createApplicationOperations({ requests, signal, eventTarget }) {
  for (const [name, method] of Object.entries({
    terrain: 'getHeights',
    regional: 'getBrief',
    weather: 'getConditions',
    summary: 'summarize',
  })) {
    if (typeof requests?.[name]?.[method] !== 'function')
      throw new TypeError(`Missing application request service: ${name}`);
  }
  const features = requireFeatureSource(
    requests.features ??
      createOverpassFeatureSource({
        boundarySource: requests.boundaries,
        signal,
      }),
  );
  const surface = createSurfaceServices({
    terrainSource: requests.terrain,
    signal,
    eventTarget,
  });
  const annotationResolver = createLazyAnnotationResolver({
    featureSource: features,
    signal,
  });
  return Object.freeze({
    requests,
    surface,
    annotationResolver,
    searchAndFlyTo: (viewer, query, options = {}) =>
      searchAndFlyTo(viewer, query, {
        ...options,
        features,
        ground: surface.groundFloor,
        signal:
          signal && options.signal
            ? AbortSignal.any([signal, options.signal])
            : signal || options.signal,
        recoverNearView: annotationResolver.placesNearViewRecovery,
      }),
  });
}
