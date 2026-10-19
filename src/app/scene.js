import { createApplicationOperations } from './operations.js';
import {
  createApplicationViewer,
  installTrackpadPinchZoom,
} from '../app/viewer.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { initLogoGaze } from '../logoGaze.js';
import {
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { t } from '../i18n/index.js';

/** Construct the application globe using the caller's local configuration. */
export async function createApplicationScene({
  requestServices,
  googleApiKey,
  googleTokens = null,
  cesiumToken,
  credits,
  MapController = MapStackController,
  mapOptions = {},
  loaderStatus,
  signal,
  defer,
}) {
  const operations = createApplicationOperations({
    requests: requestServices,
    signal,
  });
  defer(initLogoGaze());
  const previousKey = window.__GOOGLE_MAPS_API_KEY__;
  if (googleApiKey) {
    window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;
    defer(() => {
      if (window.__GOOGLE_MAPS_API_KEY__ !== googleApiKey) return;
      if (previousKey === undefined) delete window.__GOOGLE_MAPS_API_KEY__;
      else window.__GOOGLE_MAPS_API_KEY__ = previousKey;
    });
  }
  loaderStatus.textContent = t('Configuring viewer...');
  // Provider attribution stays visible, including clean-view and recording.
  const creditContainer = document.createElement('div');
  creditContainer.id = 'cesium-credits';
  document.body.appendChild(creditContainer);
  defer(() => creditContainer.remove());
  const viewer = createApplicationViewer({
    container: 'cesiumContainer',
    creditContainer,
  });
  defer(() => {
    uninstallRenderGovernor(viewer);
    if (!viewer.isDestroyed()) viewer.destroy();
  });
  defer(installTrackpadPinchZoom(viewer));
  registerDataCredits(viewer, credits);
  configureCreditKeyboardAccess(document);
  const canStartPhotoreal = Boolean(
    googleApiKey || googleTokens || cesiumToken,
  );
  const initialStack = canStartPhotoreal ? 'photoreal' : 'esri-imagery';
  const mapStackController = new MapController(viewer, {
    requestRender: governorRequestRender,
    ...mapOptions,
    googleTokens,
    lazyPhotorealistic: true,
    cesiumToken,
    initialStack,
    // Task 5 (height-datum fix): rebroadcast stack changes as a window
    // CustomEvent so data layers (CCTV per-regime ground resolution) can
    // react without coupling MapStackController to layer modules. Fires on
    // 'switching'/'ready'/'error'; listeners derive the surface regime from
    // live scene state, so intermediate emissions are harmless.
    onChange: (state) => {
      window.dispatchEvent(
        new CustomEvent('gev:map-stack-changed', { detail: state }),
      );
    },
    onError: (message) => console.warn('[MapStack]', message),
  });
  defer(() => mapStackController.destroy());
  loaderStatus.textContent = canStartPhotoreal
    ? t('Opening the globe while 3D tiles load...')
    : t('Opening the keyless globe...');
  const tilesetReady = mapStackController
    .setStack(initialStack, {
      silent: true,
    })
    .then((state) => {
      if (signal.aborted) return null;
      if (state?.activeId === 'photoreal')
        console.info('[Init] Google 3D Tiles are ready.');
      else if (canStartPhotoreal && state?.lastError) {
        console.warn(
          '[Init] Google 3D Tiles unavailable, using the globe imagery:',
          state.lastError,
        );
        loaderStatus.textContent = t(
          'Google 3D Tiles unavailable ({detail}). Loading globe imagery...',
          { detail: state.lastError },
        );
      }
      return mapStackController.getImageryHostTileset();
    })
    .catch((error) => {
      if (!signal.aborted)
        console.warn('[Init] Initial map source failed:', error);
      return mapStackController.getImageryHostTileset();
    });

  signal.throwIfAborted();
  return {
    viewer,
    tileset: mapStackController.getImageryHostTileset(),
    tilesetReady,
    mapStackController,
    operations,
  };
}
