import test from 'node:test';
import assert from 'node:assert/strict';
import { meanSeaLevel } from 'egm96-universal';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import * as committed from './egm96Grid.js';
import { buildGeoidGridBytes } from '../../scripts/build-geoid-grid.mjs';

test('the committed grid is exactly what the generator produces', () => {
  assert.equal(committed.DATA, buildGeoidGridBytes().toString('base64'));
});

test('the 0.5° grid stays within 2.5 m of the full EGM96 model everywhere', async () => {
  await ensureGeoidReady();
  // A deterministic spread of points, area-weighted toward the equator.
  let worst = 0;
  let squares = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const lat = (Math.asin(2 * ((i * 0.618034) % 1) - 1) * 180) / Math.PI;
    const lon = ((i * 137.508) % 360) - 180;
    const error = Math.abs(geoidHeight(lat, lon) - meanSeaLevel(lat, lon));
    worst = Math.max(worst, error);
    squares += error * error;
  }
  assert.ok(worst < 2.5, `max error ${worst.toFixed(2)} m`);
  assert.ok(
    Math.sqrt(squares / n) < 0.3,
    `RMS ${Math.sqrt(squares / n).toFixed(2)} m`,
  );
  // Grid nodes and the poles reproduce the model to the centimetre.
  for (const [lat, lon] of [
    [90, 0],
    [-90, 0],
    [0, -180],
    [37.5, -122.5],
  ])
    assert.ok(
      Math.abs(geoidHeight(lat, lon) - meanSeaLevel(lat, lon)) < 0.006,
      `${lat},${lon}`,
    );
});
