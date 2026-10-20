import { resolveCatalogSources } from './sourceComposition.js';
import { createWeatherClock } from '../layers/weather/clock.js';
import { createWeatherLayer } from '../layers/weather/index.js';
import { createCyclonesLayer } from '../layers/cyclones/index.js';
import { createWindLayer } from '../layers/wind/index.js';
import { createLayerCatalog } from './catalog.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';
import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createApplicationCctv } from './layers/cctv.js';
import { createApplicationRadio } from './layers/radio.js';
import { createApplicationStreetLevel } from './layers/streetLevel.js';
import { createApplicationRecentImagery } from './layers/recentImagery.js';
import { createLazyLayer, ENSURE_LAZY_LAYER } from './lazyLayer.js';

/**
 * Hardware-local layers are registered like any other but never enter share
 * links or stored layer state: another browser cannot have this receiver.
 */
export const LOCAL_ONLY_LAYER_METADATA = Object.freeze([
  Object.freeze({ id: 'local-adsb', disposition: 'local-only' }),
]);

/** Serialization metadata for every layer the application catalog constructs. */
export const APPLICATION_LAYER_METADATA = Object.freeze([
  ...LAYER_STATE_REGISTRY,
  ...LOCAL_ONLY_LAYER_METADATA,
]);

const LAYER_ORDER = Object.freeze([
  'air-quality',
  'bhote-koshi-2026',
  'bhote-koshi-locator',
  'flights',
  'gnss-integrity',
  'military',
  'local-adsb',
  'earthquakes',
  'fire-perimeters',
  'alpr-cameras',
  'street-level',
  'satellites',
  'rocket-launches',
  'traffic',
  'cctv',
  'radio',
  'transit',
  'bikeshare',
  'directions',
  'recent-imagery',
  'ais-live-vessels',
  'military-installations',
  'military-awareness',
  'wind',
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
  'weather-cyclones',
  'local-datacenters',
  'local-dams',
  'telegeography-submarine-cables',
  'local-firms',
]);

const LAZY_LAYER_METADATA = Object.freeze([
  {
    id: 'air-quality',
    name: 'Air quality',
    icon: '\u25cd',
    source: 'ECCC MSC GeoMet',
    updateInterval: 1_200_000,
  },
  {
    id: 'bhote-koshi-2026',
    name: 'Bhote Koshi Flood',
    icon: '🌊',
    source: 'Vantor + GeoPera',
    showInTogglePanel: false,
    updateInterval: 0,
  },
  {
    id: 'bhote-koshi-locator',
    name: 'Bhote Koshi Locator',
    icon: '◎',
    source: 'OpenStreetMap + GeoPera',
    showInTogglePanel: false,
    updateInterval: 0,
  },
  {
    id: 'flights',
    name: 'Live Flights',
    icon: '✈️',
    source: 'Flights',
    updateInterval: 30_000,
  },
  {
    id: 'gnss-integrity',
    name: 'GNSS Integrity',
    icon: '\u{1F4E1}',
    source: 'adsb.lol',
    updateInterval: 60_000,
  },
  {
    id: 'military',
    name: 'Military Flights',
    icon: '🎖️',
    source: 'Military aircraft',
    updateInterval: 15_000,
  },
  {
    id: 'local-adsb',
    name: 'Local ADS-B',
    icon: '📡',
    source: 'RTL-SDR · WebUSB',
    updateInterval: 0,
    statsRefreshInterval: 1_000,
  },
  {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60_000,
  },
  {
    id: 'fire-perimeters',
    name: 'Fire Perimeters',
    icon: '🔥',
    source: 'NIFC WFIGS',
    updateInterval: 300_000,
  },
  {
    id: 'alpr-cameras',
    name: 'ALPR Cameras',
    icon: '📷',
    source: 'OpenStreetMap · community mapped',
    updateInterval: 0,
    statsRefreshInterval: 1_000,
  },
  {
    id: 'satellites',
    name: 'Satellites',
    icon: '🛰️',
    source: 'CelesTrak',
    updateInterval: 0,
    refreshInterval: 300_000,
  },
  {
    id: 'rocket-launches',
    name: 'Space Missions (30d)',
    icon: '🚀',
    source: 'Launch Library 2',
    updateInterval: 300_000,
  },
  {
    id: 'traffic',
    name: 'Street Traffic',
    icon: '🚗',
    source: 'OpenStreetMap / TomTom',
    updateInterval: 0,
  },
  {
    id: 'transit',
    name: 'Transit',
    icon: '🚌',
    source: 'GTFS-RT',
    updateInterval: 15_000,
  },
  {
    id: 'bikeshare',
    name: 'Bikeshare',
    icon: '🚲',
    source: 'GBFS',
    updateInterval: 60_000,
  },
  {
    id: 'directions',
    name: 'Directions',
    icon: '🧭',
    source: 'OSM routing',
    updateInterval: 0,
  },
  {
    id: 'ais-live-vessels',
    name: 'Live AIS Vessels',
    icon: '◭',
    source: 'Vessels',
    updateInterval: 60_000,
    statsRefreshInterval: 1_000,
  },
  {
    id: 'military-installations',
    name: 'Mapped Installations',
    icon: '⌖',
    source: 'OpenStreetMap + optional Google Maps Places',
    updateInterval: 0,
    statsRefreshInterval: 1_000,
  },
  {
    id: 'military-awareness',
    name: 'Global Context',
    icon: '◎',
    source: 'Open-source proximity context',
    showInTogglePanel: false,
    updateInterval: 0,
    statsRefreshInterval: 1_000,
  },
  { id: 'local-datacenters', name: 'Datacenters', icon: '▣', source: 'Local' },
  { id: 'local-dams', name: 'Dams', icon: '▰', source: 'USACE' },
  {
    id: 'telegeography-submarine-cables',
    name: 'Submarine Cables',
    icon: '≋',
    source: 'TeleGeography',
    updateInterval: 0,
    statsRefreshInterval: 500,
  },
  {
    id: 'local-firms',
    name: 'FIRMS Active Fires',
    icon: '▲',
    source: 'NASA FIRMS · LIVE',
    updateInterval: 600_000,
    requiresKeyId: 'firms',
  },
]);

const EMPTY = () => undefined;
const EMPTY_FALSE = () => false;
const EMPTY_NULL = () => null;
const LAZY_LAYER_FALLBACKS = Object.freeze({
  beginWorldJump: EMPTY,
  cancelPendingRestore: EMPTY,
  cancelPendingTrackingRestore: EMPTY,
  clearSelection: EMPTY,
  endWorldJump: EMPTY,
  focusTarget: EMPTY,
  getContextSnapshot: EMPTY_NULL,
  getTrackedInfo: EMPTY_NULL,
  navigateNext: EMPTY_FALSE,
  refocusTrackedById: EMPTY_FALSE,
  releaseCameraOwnership: EMPTY,
  stopTracking: EMPTY,
});

/**
 * Construct the current catalog without choosing any source provider.
 * High weight overlays are represented by synchronous metadata first, then
 * their implementation is imported on first activation. Scene-owned layers
 * and classification still live for the lifetime of this application.
 */
export function createApplicationCatalog({
  surface,
  sources,
  signal,
  metadata = APPLICATION_LAYER_METADATA,
  vesselOptions,
  resolveAsset,
  nepalBoundaryResolver,
  streetLevelProviders,
}) {
  if (!signal?.addEventListener)
    throw new TypeError('An application lifetime signal is required');
  signal.throwIfAborted();
  if (!surface?.groundFloor || !surface?.terrain)
    throw new TypeError('Application surface services are required');

  const sourceComposition = resolveCatalogSources(sources);
  sources = sourceComposition.sources;
  const militaryRegistry = createMilitaryRegistry();
  const weatherClock = createWeatherClock();
  const dispose = () => {
    signal.removeEventListener('abort', dispose);
    militaryRegistry.dispose();
    weatherClock.destroy();
  };
  signal.addEventListener('abort', dispose, { once: true });

  try {
    if (sourceComposition.isConfigured('military'))
      militaryRegistry.configureSource(sources.military, { signal });

    // These implementations are small or expose synchronous controls read
    // during shell construction. The costly overlay families below are lazy.
    const eager = new Map([
      [
        'street-level',
        createApplicationStreetLevel({
          surface,
          sources: { mapillary: sources.mapillary },
          providers: streetLevelProviders,
        }),
      ],
      ['cctv', createApplicationCctv({ surface, source: sources.cctv })],
      ['radio', createApplicationRadio({ surface, source: sources.radio })],
      [
        'recent-imagery',
        createApplicationRecentImagery({ source: sources['recent-imagery'] }),
      ],
      ['wind', createWindLayer({ feed: sources.wind, clock: weatherClock })],
      [
        'weather-radar',
        createWeatherLayer({
          feed: sources.weather,
          id: 'weather-radar',
          clock: weatherClock,
        }),
      ],
      [
        'weather-satellite',
        createWeatherLayer({
          feed: sources.weather,
          id: 'weather-satellite',
          clock: weatherClock,
        }),
      ],
      [
        'weather-lightning',
        createWeatherLayer({
          feed: sources.weather,
          id: 'weather-lightning',
          clock: weatherClock,
        }),
      ],
      ['weather-cyclones', createCyclonesLayer({ feed: sources.cyclones })],
    ]);

    const lazyById = new Map();
    const ensureLazy = async (id) => {
      const layer = lazyById.get(id);
      if (!layer) return eager.get(id);
      return layer[ENSURE_LAZY_LAYER]();
    };

    let infrastructurePromise;
    const loadInfrastructure = () => {
      infrastructurePromise ||= Promise.all([
        import('../data/infrastructure.js'),
        import('./localGeojsonServices.js'),
      ]).then(([infrastructure, local]) =>
        infrastructure.createInfrastructureLayers(local.localGeoJsonServices),
      );
      infrastructurePromise.catch(() => {
        infrastructurePromise = null;
      });
      return infrastructurePromise;
    };

    const definitions = [
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'air-quality'),
        supportsRowControls: true,
        load: async () =>
          (
            await import('./layers/airQuality.js')
          ).createApplicationAirQuality({ source: sources['air-quality'] }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'bhote-koshi-2026',
        ),
        load: async () =>
          (
            await import('../data/bhoteKoshiEvent.js')
          ).createBhoteKoshiEventLayer(),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'bhote-koshi-locator',
        ),
        supportsRowControls: true,
        load: async () =>
          (
            await import('../data/bhoteKoshiLocator.js')
          ).createBhoteKoshiLocatorLayer({
            boundaryResolver: nepalBoundaryResolver,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'flights'),
        load: async () => {
          const { createApplicationFlights } =
            await import('./layers/flights.js');
          return createApplicationFlights({
            surface,
            source: sources.flights,
            militaryRegistry,
            resolveAsset,
          });
        },
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'gnss-integrity',
        ),
        supportsRowControls: true,
        load: async () =>
          (
            await import('./layers/gnss.js')
          ).createApplicationGnssIntegrity({
            source: sources['gnss-integrity'],
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'military'),
        load: async () => {
          const { createApplicationMilitary } =
            await import('./layers/militaryFlights.js');
          return createApplicationMilitary({
            surface,
            source: sources.military,
            militaryRegistry,
            resolveAsset,
          });
        },
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'local-adsb'),
        load: async () => {
          const [flights, { createApplicationLocalAdsb }] = await Promise.all([
            ensureLazy('flights'),
            import('./layers/localAdsb.js'),
          ]);
          return createApplicationLocalAdsb({
            surface,
            enrichment: sources.flights,
            displayParams: () => flights.getParams(),
            ...(resolveAsset ? { resolveAsset } : {}),
          });
        },
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'earthquakes'),
        load: async () =>
          (
            await import('./layers/earthquakes.js')
          ).createApplicationEarthquakes({
            source: sources.earthquakes,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'fire-perimeters',
        ),
        supportsRowControls: true,
        load: async () =>
          (
            await import('./layers/perimeters.js')
          ).createApplicationFirePerimeters({
            source: sources['fire-perimeters'],
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'alpr-cameras'),
        supportsRowControls: true,
        load: async () =>
          (await import('./layers/alprCameras.js')).createApplicationAlpr({
            surface,
            source: sources.alpr,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'satellites'),
        supportsRowControls: true,
        load: async () =>
          (await import('./layers/satellites.js')).createApplicationSatellites({
            source: sources.satellites,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'rocket-launches',
        ),
        load: async () => {
          const [satellites, { createApplicationLaunches }] = await Promise.all(
            [ensureLazy('satellites'), import('./layers/rocketLaunches.js')],
          );
          return createApplicationLaunches({
            source: sources.launches,
            satellites,
          });
        },
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'traffic'),
        supportsRowControls: true,
        load: async () =>
          (await import('./layers/traffic.js')).createApplicationTraffic({
            source: sources.traffic,
            surface,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'transit'),
        load: async () =>
          (await import('./layers/transit.js')).createApplicationTransit({
            surface,
            source: sources.transit,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'bikeshare'),
        load: async () =>
          (await import('./layers/bikeshare.js')).createApplicationBikeshare({
            source: sources.bikeshare,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'directions'),
        supportsRowControls: true,
        load: async () =>
          (await import('./layers/directions.js')).createApplicationDirections({
            source: sources.directions,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'ais-live-vessels',
        ),
        load: async () =>
          (await import('./layers/aisLiveVessels.js')).createApplicationVessels(
            {
              source: sources.vessels,
              options: vesselOptions,
            },
          ),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'military-installations',
        ),
        load: async () =>
          (
            await import('./layers/militaryInstallations.js')
          ).createApplicationInstallations({
            surface,
            source: sources.installations,
          }),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'military-awareness',
        ),
        load: async () => {
          const [
            flights,
            military,
            vessels,
            installations,
            { createApplicationAwareness },
          ] = await Promise.all([
            ensureLazy('flights'),
            ensureLazy('military'),
            ensureLazy('ais-live-vessels'),
            ensureLazy('military-installations'),
            import('./layers/militaryAwareness.js'),
          ]);
          return createApplicationAwareness({
            flights,
            military,
            vessels,
            installations,
          });
        },
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'local-datacenters',
        ),
        load: async () =>
          (await loadInfrastructure()).find(
            ({ id }) => id === 'local-datacenters',
          ),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'local-dams'),
        load: async () =>
          (await loadInfrastructure()).find(({ id }) => id === 'local-dams'),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(
          ({ id }) => id === 'telegeography-submarine-cables',
        ),
        load: async () =>
          (await import('./layers/submarineCables.js')).createApplicationCables(
            {
              source: sources.cables,
            },
          ),
      },
      {
        metadata: LAZY_LAYER_METADATA.find(({ id }) => id === 'local-firms'),
        load: async () =>
          (await import('./layers/firms.js')).createApplicationFirms({
            surface,
            id: 'local-firms',
            name: 'FIRMS Active Fires',
            icon: '▲',
            source: 'NASA FIRMS · LIVE',
            feed: sources.firms,
          }),
      },
    ];

    for (const definition of definitions) {
      const layer = createLazyLayer({
        metadata: definition.metadata,
        load: definition.load,
        fallbacks: LAZY_LAYER_FALLBACKS,
        supportsRowControls: definition.supportsRowControls,
      });
      lazyById.set(definition.metadata.id, layer);
    }

    const layers = LAYER_ORDER.map((id) => {
      const layer = eager.get(id) || lazyById.get(id);
      if (!layer) throw new Error(`Application layer is not configured: ${id}`);
      return layer;
    });
    const catalog = createLayerCatalog(layers, metadata);
    return Object.freeze({
      ...catalog,
      getSourceAvailability: sourceComposition.createAvailabilityLookup(
        catalog.layers,
      ),
      militaryRegistry,
      surface,
      weatherClock,
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
