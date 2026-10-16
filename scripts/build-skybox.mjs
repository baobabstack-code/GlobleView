// Generates src/app/skybox/*.jpg (bundled by Vite as hashed assets): Cesium's default Tycho-2 star skybox at
// 512 px instead of 1024 px. The stock six faces are ~870 KB, the largest
// startup download after the engine itself; at 512 px they are a fraction of
// that and the star field looks the same at globe distance.
//
// Run after upgrading cesium: node scripts/build-skybox.mjs
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const SIZE = 512;
const QUALITY = 90;
/** Cesium's face suffixes → the names src/app/viewer.js loads. */
export const SKYBOX_FACES = Object.freeze({
  positiveX: 'px',
  negativeX: 'mx',
  positiveY: 'py',
  negativeY: 'my',
  positiveZ: 'pz',
  negativeZ: 'mz',
});

const root = path.dirname(
  fileURLToPath(new URL('../package.json', import.meta.url)),
);
const cesiumRoot = path.dirname(
  createRequire(import.meta.url).resolve('cesium/package.json'),
);
const source = path.join(cesiumRoot, 'Build/Cesium/Assets/Textures/SkyBox');
const target = path.join(root, 'src/app/skybox');
mkdirSync(target, { recursive: true });

let total = 0;
for (const face of Object.values(SKYBOX_FACES)) {
  const out = path.join(target, `${face}.jpg`);
  await sharp(path.join(source, `tycho2t3_80_${face}.jpg`))
    .resize(SIZE, SIZE)
    .jpeg({ quality: QUALITY, chromaSubsampling: '4:4:4' })
    .toFile(out);
  total += statSync(out).size;
}
console.log(
  `Wrote ${Object.keys(SKYBOX_FACES).length} faces to src/app/skybox (${(total / 1024).toFixed(0)} KB)`,
);
