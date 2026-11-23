/**
 * floorPlanEnglishFrozen.test.ts
 *
 * The English floor plan sheet, byte for byte. These digests were taken before
 * the sheet's text moved into a language catalog, so English output can never
 * drift while other languages are added. A change to the English sheet is a
 * deliberate change: update the digests with it.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function room(W = 10, D = 8, H = 2.5, step = 0.1, partition = false): Float32Array {
  const t: number[] = [];
  for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) t.push(x, y, 0, x, y, H);
  for (let z = 0; z <= H; z += step) for (let x = 0; x <= W; x += step) t.push(x, 0, z, x, D, z);
  for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) t.push(0, y, z, W, y, z);
  if (partition) {
    // An interior wall at x = W/2 with a 1 m doorway.
    for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) if (y < 3 || y > 4) t.push(W / 2, y, z);
  }
  return Float32Array.from(t);
}
function flat(): Float32Array {
  const t: number[] = [];
  for (let x = 0; x <= 6; x += 0.1) for (let y = 0; y <= 6; y += 0.1) t.push(x, y, 0);
  return Float32Array.from(t);
}

const MODELS = {
  room: extractFloorPlan(room(), { upAxis: 'z' }),
  twoRooms: extractFloorPlan(room(10, 8, 2.5, 0.1, true), { upAxis: 'z' }),
  noWalls: extractFloorPlan(flat(), { upAxis: 'z' }),
};

const FROZEN: Record<string, string> = {
  'noWalls:imperial:classic': 'bade9c212e9d832e4f8e89f1650fbd2f3efc0fd8480f109aa043ebd890f40cb3',
  'noWalls:imperial:dark': '0fdf5213c5e7372596c450825be560742f204e46184a9ffdfb7ec3a1ff0abe70',
  'noWalls:imperial:light': '27cc6f0297a3b02757a25839173bae14f18e95a53f11213377ae4535295c4c0d',
  'noWalls:metric:classic': '608a109350c7aa88fd1194abf2fcee2cb5bc952f8acd2268bc784f69cf4b1842',
  'noWalls:metric:dark': '84a3100d81266f6cd72df32bb31ac6e8a72a4e80f656ccd3ba48674f608d233e',
  'noWalls:metric:light': '75e80fa6d48c14fdcc72f567fc076a66594db8ba8f4c901626d57879ede42d01',
  'room:imperial:classic': 'ecd55771e798185271d323526f1e34b49912796f6d15d856de1b31ea313117eb',
  'room:imperial:dark': 'e97c47da6e0a68f9455daf659c1a47f5a352e9db5b7d912ead41a5825ac5bc00',
  'room:imperial:light': '4d11c0ae4ed41f0cc93eceef44d33834aa9a7c3e13fc9cbf3272548827451f89',
  'room:metric:classic': '70360d9034f8dd631020fe6511ae24d1de9835876397bd63098983609d3de123',
  'room:metric:dark': '6a9d3badcc5bc1f3e220237377c6fa10df110e201051d14675d80dd7b27ddcde',
  'room:metric:light': '1e56d63264ba6695d85c0d61fb06c7b3d78e90425d7c704e0a76f8151ac58347',
  'twoRooms:imperial:classic': 'cca4647f15543ded79c9d845394a7dada70e6f40d77e0fdb2498eea8d58ad7f6',
  'twoRooms:imperial:dark': '9df1d22bb171002ba54ede4e959ba83b8f755293aa6433eb4c8233cdf2159cce',
  'twoRooms:imperial:light': '445d481a9b33e0bc8780d6332d63d02c1697f5d350086688b993a78be70327f8',
  'twoRooms:metric:classic': 'a4a8bd21053a1b7ccb0b6162a60f17a954bf2d601e43ca8d4a79e07e933de173',
  'twoRooms:metric:dark': '8c2a05ac17d1243bc7caabe9297e0c48fd2a7a841796617fd4970bdd62487da3',
  'twoRooms:metric:light': '04cc028683717bc380ba46eb16b08ab66e92c882f0b77277c5c95a00b1723117',
};

describe('English floor plan sheets are unchanged', () => {
  for (const [name, model] of Object.entries(MODELS)) {
    for (const unitSystem of ['metric', 'imperial'] as const) {
      for (const style of ['classic', 'light', 'dark'] as const) {
        const key = `${name}:${unitSystem}:${style}`;
        it(key, () => {
          const svg = floorPlanSvg(model, { title: 'Room', dateText: '2026-06-05', unitSystem, ...(style === 'classic' ? {} : { style }) });
          if (process.env.OLV_PRINT_DIGESTS) console.log(`DIGEST ${key} ${sha(svg)}`);
          expect(sha(svg)).toBe(FROZEN[key]);
        });
      }
    }
  }
});
