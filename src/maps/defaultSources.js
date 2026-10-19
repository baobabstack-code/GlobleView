import * as Cesium from 'cesium';
import { MAP_STACKS } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { loadPhotorealisticTileset } from './google3d.js';
import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { t } from '../i18n/index.js';
import {
  createOsmImagery,
  createEsriImagery,
  createIonImagery,
  ESRI_ATTRIBUTION_HTML,
} from './imagery.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';

/** Select sources and setup guidance without putting provider branches in the controller. */
export function createDefaultMapSources({
  googleTileset = null,
  googleTokens = null,
  lazyPhotorealistic = false,
  cesiumToken = '',
  googleApiKey = '',
} = {}) {
  const ionToken = String(cesiumToken || '').trim();
  const hasIon = Boolean(ionToken);
  const hasGoogle = Boolean(String(googleApiKey || '').trim());
  const canLoadPhotorealistic = Boolean(
    googleTileset ||
    (lazyPhotorealistic && (hasIon || hasGoogle || googleTokens)),
  );
  const terrain = {
    id: hasIon ? 'world' : 'keyless',
    create: hasIon
      ? (request) => createWorldTerrain(ionToken, request)
      : createKeylessTerrain,
  };
  return {
    defaultId: canLoadPhotorealistic ? 'photoreal' : 'esri-imagery',
    unknownId: 'photoreal',
    recoveryId: googleTileset
      ? 'photoreal'
      : canLoadPhotorealistic
        ? 'esri-imagery'
        : null,
    state: { hasCesiumIonToken: hasIon },
    sources: MAP_STACKS.map((descriptor) => {
      const common = {
        descriptor,
        available: !descriptor.requiresIon || hasIon,
        unavailableReason: descriptor.requiresIon
          ? t('Needs {envVars} — add it in Provider Settings', {
              envVars: keySetupRequirementEnvVars('cesium-ion'),
            })
          : null,
      };
      if (descriptor.kind === 'photoreal')
        return {
          ...common,
          available: canLoadPhotorealistic,
          unavailableReason: photorealUnavailableReason(
            hasIon || hasGoogle || Boolean(googleTokens),
          ),
          tileset: googleTileset,
          ...(!googleTileset && lazyPhotorealistic && canLoadPhotorealistic
            ? {
                async createTileset({ signal } = {}) {
                  signal?.throwIfAborted();
                  const result = await loadPhotorealisticTileset(Cesium, {
                    googleApiKey,
                    googleTokens,
                    cesiumToken,
                  });
                  if (signal?.aborted) {
                    result.tileset?.destroy?.();
                    signal.throwIfAborted();
                  }
                  if (!result.tileset)
                    throw (
                      result.errors.at(-1) ||
                      new Error('Google 3D tiles are unavailable')
                    );
                  result.tileset.enableCollision = true;
                  return result.tileset;
                },
              }
            : {}),
        };
      const imagery =
        descriptor.kind === 'ion'
          ? () => createIonImagery(descriptor.style, ionToken)
          : descriptor.id === 'osm'
            ? createOsmImagery
            : createEsriImagery;
      return {
        ...common,
        imagery,
        terrain,
        ...(descriptor.id === 'esri-imagery'
          ? {
              credit: ESRI_ATTRIBUTION_HTML,
              constructionFallback: {
                id: 'osm',
                message: 'Esri Satellite is unavailable; using OSM',
              },
              tileFailureFallback: {
                id: 'osm',
                threshold: 2,
                message: 'Esri Satellite tile requests failed; using OSM',
              },
            }
          : {}),
      };
    }),
  };
}
