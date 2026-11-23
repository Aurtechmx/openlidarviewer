/**
 * spaceReportEnglishFrozen.test.ts
 *
 * The English space and object reports, byte for byte. These digests were
 * taken before the report text moved into a language catalog, so English
 * output can never drift while other languages are added. A change to the
 * English report is a deliberate change: update the digests with it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSpaceReportPdf } from '../src/render/measure/spaceReportPdf';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { objectMetrics } from '../src/terrain/objectMetrics';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';

const loadFont = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const AT = '2026-06-05T12:00:00.000Z';

function room(W = 10, D = 8, H = 2.5, step = 0.1): Float32Array {
  const t: number[] = [];
  for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) t.push(x, y, 0, x, y, H);
  for (let z = 0; z <= H; z += step) for (let x = 0; x <= W; x += step) t.push(x, 0, z, x, D, z);
  for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) t.push(0, y, z, W, y, z);
  return Float32Array.from(t);
}
function cube(): Float32Array {
  const t: number[] = [];
  for (let u = 0; u <= 4; u += 0.25)
    for (let w = 0; w <= 4; w += 0.25) t.push(u, w, 0, u, w, 4, u, 0, w, u, 4, w, 0, u, w, 4, u, w);
  return Float32Array.from(t);
}

const roomPos = room();
const roomSpace = spaceMetrics(roomPos, { upAxis: 'z', spaceKind: 'interior', hasRgb: true });
const roomPlan = extractFloorPlan(roomPos, { upAxis: 'z' });
const cubePos = cube();
const cubeSpace = spaceMetrics(cubePos, { upAxis: 'z', spaceKind: 'object' });
const cubeObject = objectMetrics(cubePos);
const unknownSpace = spaceMetrics(roomPos, { upAxis: 'z', spaceKind: 'interior', unitKnown: false });

const SPACE_REPORT_CASES = {
  interior: { space: roomSpace, name: 'Room', softwareVersion: '0.4.3', metricVersion: 'v0.4.1', generatedAt: AT, floorPlan: roomPlan },
  object: { space: cubeSpace, object: cubeObject, name: 'Box', softwareVersion: '0.4.3', metricVersion: 'v0.4.1', generatedAt: AT },
  unknownUnit: { space: unknownSpace, name: 'Room', softwareVersion: '0.4.3', metricVersion: 'v0.4.1', generatedAt: AT },
  empty: { space: null, name: 'Nothing', softwareVersion: '0.4.3', metricVersion: 'v0.4.1', generatedAt: AT },
} as const;

const FROZEN: Record<string, string> = {
  'empty:classic': '42dc9b89913a3e75b63878b41b66c8836bd7be487659a2b14216faa89ec80199',
  'empty:dark': '29435dc268d4d55d6a15b5f971bd8d1efd109812841e58305b40a78ec53755ef',
  'empty:light': '67466e8f277528ea73066cfa244841a84de641824cbf7c2b5f75a7a211d90817',
  'interior:classic': '724030aae26cedc90ebdb8222af5a4f36753e5972c412dab7e8ffe3f11cba78e',
  'interior:dark': 'a21b02be67fba6ac782ddc8da6866ff04e8262955776bad6c40527f3a80a4c6a',
  'interior:light': 'a94d98aa926f03c3bf7be33c5ac77fa9e5b270a9b3fa10754f8bebb0ca471b02',
  'object:classic': 'e44762264775c3c190ae6fe1aeae2dc9fc2bab114636372a7ef26f1ced49b694',
  'object:dark': '479fad59afb420aa80af539e4d474b9e12f8fa58644bd1a1c3e9dc4eee700574',
  'object:light': 'a9de7e8434ccb36bcc3e69e7da3d554c1253c8cf1cf1da9e167d1a162854ca33',
  'unknownUnit:classic': '0b5950d8beb70030d333dd046ad4352c45b26a634a4f7af6ad098ed52b7ba23c',
  'unknownUnit:dark': '6bd49be874a1280126ab9d9164f299d71f94d56ed7f178db90b3b5c2ad5876f0',
  'unknownUnit:light': 'b8792d40924b47aa7c95e6b608cd58dd0a0d1ab895ff7e45eb9d232f62e03ffd',
};

describe('English space reports are unchanged', () => {
  for (const [name, input] of Object.entries(SPACE_REPORT_CASES)) {
    for (const style of ['classic', 'light', 'dark'] as const) {
      it(`${name} ${style}`, async () => {
        const bytes = await buildSpaceReportPdf(input as never, style === 'classic' ? {} : { style, loadFont });
        const key = `${name}:${style}`;
        if (process.env.OLV_PRINT_DIGESTS) console.log(`DIGEST ${key} ${sha(bytes)}`);
        expect(sha(bytes)).toBe(FROZEN[key]);
      }, 60_000);
    }
  }
});
