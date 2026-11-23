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
  'empty:dark': 'ca9afefb442a1eaa1cd6c327155287967891c08472a13a0adb4945ccc46c3943',
  'empty:light': '5f3d120c900abf5f5dfd40953f3994bee9e0333e3ea54acaa83773e52a94c5e7',
  'interior:classic': 'd00c46e2fc82b9857ffd0c27b1fa8a4ed6e27e33e57db1856fa65e9d0b388968',
  'interior:dark': '80f182e1ee2e59ab591ef4aa01cccbedfa42f434cc1517f9b247e7e4c6deea19',
  'interior:light': 'bc6bdedc8b47f005c5058eae1177cfc26db0262df7d480a6473eeb72934cad71',
  'object:classic': 'f9c6e99f369dd13075dd1af1cab01771c191dd2d3190a37ce81b254ae5a13a84',
  'object:dark': 'd329a1dda3f3b92061583f90fc2103577cbe58a635f54f8fbda36b88ce6cb4b2',
  'object:light': '9d7bb91f3af0f1ec44f412d95a0a3afc9aa974360b63c3c681512e37c921f16e',
  'unknownUnit:classic': '59dee66c7c96943d8f74083bd45ad40d69328fcc1e7d0de6d5cbdc68c48c037b',
  'unknownUnit:dark': '78ded2bc71cb78c9c0010f1bfc5ca685e45a66dc006e71b946d0a64ea59716fb',
  'unknownUnit:light': '0ed96e796bafdd859d4b2a3063a13a5b5b794f2697ba03296aabe1592966298a',
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
