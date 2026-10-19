import * as Cesium from 'cesium';
import { isPickedWorldPosition } from '../data/scenePick.js';

/** A distinct Overpass throttle result that must not enter the ordinary retry ladder. */
export function isRateLimitedOutcome(value) {
  return value?.rateLimited === true;
}

/** Return the current camera rectangle in the geocoder's compact bias format. */
export function viewportBias(viewer) {
  try {
    const rect = viewer?.camera?.computeViewRectangle?.();
    if (!rect) return null;
    const swLat = Cesium.Math.toDegrees(rect.south).toFixed(4);
    const swLng = Cesium.Math.toDegrees(rect.west).toFixed(4);
    const neLat = Cesium.Math.toDegrees(rect.north).toFixed(4);
    const neLng = Cesium.Math.toDegrees(rect.east).toFixed(4);
    if ([swLat, swLng, neLat, neLng].some((value) => value === 'NaN'))
      return null;
    return `${swLat},${swLng}|${neLat},${neLng}`;
  } catch {
    return null;
  }
}

/** Convert a normalized viewport point into its picked world coordinate. */
export function pickWorldFromScreen(viewer, nx, ny) {
  const scene = viewer?.scene;
  if (!scene) return null;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  if (!width || !height) return null;
  const px = Math.max(0, Math.min(1, nx)) * width;
  const py = Math.max(0, Math.min(1, ny)) * height;
  const position = new Cesium.Cartesian2(px, py);

  let cartesian = null;
  if (scene.pickPositionSupported && typeof scene.pickPosition === 'function') {
    try {
      cartesian = scene.pickPosition(position);
    } catch {
      cartesian = null;
    }
  }
  if (
    !isPickedWorldPosition(cartesian) &&
    typeof viewer.camera.pickEllipsoid === 'function'
  ) {
    try {
      cartesian = viewer.camera.pickEllipsoid(position, Cesium.Ellipsoid.WGS84);
    } catch {
      cartesian = null;
    }
  }
  if (
    !isPickedWorldPosition(cartesian) &&
    typeof viewer.camera.getPickRay === 'function'
  ) {
    try {
      const ray = viewer.camera.getPickRay(position);
      cartesian = ray ? scene.globe?.pick(ray, scene) || null : null;
    } catch {
      cartesian = null;
    }
  }
  if (!isPickedWorldPosition(cartesian)) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  if (!cartographic) return null;
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    height: Number.isFinite(cartographic.height) ? cartographic.height : 0,
  };
}

/** Sample a loaded 3D surface when possible, falling back to the globe. */
export function sampleGroundHeight(viewer, lon, lat) {
  const scene = viewer?.scene;
  if (!scene) return 0;
  try {
    if (
      scene.clampToHeightSupported &&
      typeof scene.clampToHeight === 'function'
    ) {
      const cartographic = Cesium.Cartographic.fromDegrees(lon, lat);
      const surface = Cesium.Cartographic.toCartesian(cartographic);
      const clamped = scene.clampToHeight(surface);
      if (clamped) {
        const height = Cesium.Cartographic.fromCartesian(clamped).height;
        if (Number.isFinite(height)) return height;
      }
    }
  } catch {
    /* tiles not ready — fall through */
  }
  const globeHeight = scene.globe?.getHeight?.(
    Cesium.Cartographic.fromDegrees(lon, lat),
  );
  return Number.isFinite(globeHeight) && globeHeight > 0 ? globeHeight : 0;
}
