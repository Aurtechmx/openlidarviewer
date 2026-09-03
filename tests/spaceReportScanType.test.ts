/**
 * spaceReportScanType.test.ts
 *
 * The Space / Object report must state the scan type it was actually built
 * for. A real export of a 1 km² airborne terrain tile printed "Scan type:
 * Object" while the on-screen "Treat scan as" pill read Terrain, and nothing
 * in the artifact explained the disagreement: the host collapsed the
 * three-valued SpaceKind to the report's two layouts (`effective ===
 * 'interior' ? 'interior' : 'object'`) and shipped the collapsed value as the
 * recorded scan type.
 *
 * These pin the separation: the layout still collapses (only two exist), the
 * RECORD keeps the real kind, the detector's verdict and the override travel
 * with it, and an object-envelope layout over a terrain-routed scan carries a
 * disclosure instead of a silent bounding box.
 */

import { describe, it, expect } from 'vitest';
import { scanTypeRecord, spaceLayoutKind } from '../src/terrain/scanRoute';
import {
  scanTypeProvenance,
  TERRAIN_ENVELOPE_DISCLOSURE,
} from '../src/terrain/space/scanTypeProvenance';
import { buildSpaceReportPdf } from '../src/render/measure/spaceReportPdf';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { objectMetrics } from '../src/terrain/objectMetrics';
import { extractTextOps } from './pdfTextOps';

/** The value of the `Key   Value` provenance line whose key is `key`. */
function lineFor(lines: ReadonlyArray<string>, key: string): string {
  const hit = lines.find((l) => l.startsWith(`${key} `));
  expect(hit, `no provenance line keyed "${key}" in ${JSON.stringify(lines)}`).toBeTruthy();
  return hit!.slice(key.length).trim();
}

function cubeShell(): Float32Array {
  const cube: number[] = [];
  for (let u = 0; u <= 4; u += 0.5)
    for (let w = 0; w <= 4; w += 0.5) {
      cube.push(u, w, 0, u, w, 4, u, 0, w, u, 4, w, 0, u, w, 4, u, w);
    }
  return Float32Array.from(cube);
}

/** Every drawn string in draw order, joined so a wrapped sentence reads whole. */
async function flatText(bytes: Uint8Array): Promise<string> {
  const ops = await extractTextOps(bytes);
  return ops
    .map((o) => o.text)
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('scan-type record', () => {
  it('records a terrain-routed scan as terrain, never as object', () => {
    const record = scanTypeRecord('terrain', 'terrain', 'auto', true);
    expect(record.routed).toBe('terrain');
    // The report has two layouts, so terrain still RENDERS as the envelope.
    expect(record.layout).toBe('object');
    expect(spaceLayoutKind('terrain')).toBe('object');

    const scanType = lineFor(scanTypeProvenance(record).lines, 'Scan type');
    expect(scanType).toMatch(/^Terrain;/);
    expect(scanType).toContain('rendered as Object envelope');
  });

  it('distinguishes a forced override from a detected verdict', () => {
    const detected = lineFor(
      scanTypeProvenance(scanTypeRecord('object', 'object', 'auto', true)).lines,
      'Scan type',
    );
    const forced = lineFor(
      scanTypeProvenance(scanTypeRecord('object', 'terrain', 'object', false)).lines,
      'Scan type',
    );
    expect(detected).toBe('Object; detected Object; treat as Auto (settled, committed)');
    expect(forced).toBe('Object; detected Terrain; treat as Forced: Object');
    expect(detected).not.toBe(forced);
  });

  it('separates a settled commit from a provisional detection', () => {
    const of = (r: Parameters<typeof scanTypeProvenance>[0]): string =>
      lineFor(scanTypeProvenance(r).lines, 'Scan type');
    expect(of(scanTypeRecord('object', 'object', 'auto', true))).toContain('Auto (settled, committed)');
    expect(of(scanTypeRecord('object', 'object', 'auto', false))).toContain('Auto (provisional, uncommitted)');
    expect(of(scanTypeRecord('object', null, 'auto', false))).toContain('detected not determined');
  });

  it('discloses an object envelope rendered for a terrain-routed scan', () => {
    const forced = scanTypeProvenance(scanTypeRecord('terrain', 'terrain', 'terrain', false));
    expect(forced.disclosure).toBe(TERRAIN_ENVELOPE_DISCLOSURE);
    expect(forced.disclosure).toMatch(/bounding box/);

    // The route moved to terrain after the figures were computed as an object:
    // the report states both and still discloses the envelope.
    const raced = scanTypeProvenance(scanTypeRecord('object', 'object', 'auto', true), 'terrain');
    expect(raced.disclosure).toBe(TERRAIN_ENVELOPE_DISCLOSURE);
    expect(raced.lines).toHaveLength(1);
    expect(lineFor(raced.lines, 'Scan type')).toBe(
      'Object; detected Object; treat as Auto (settled, committed); route now Terrain',
    );
  });

  it('leaves a matching interior or object report undisclosed', () => {
    const interior = scanTypeProvenance(scanTypeRecord('interior', 'interior', 'auto', true));
    expect(interior.disclosure).toBeNull();
    expect(interior.lines).toHaveLength(1);
    expect(lineFor(interior.lines, 'Scan type')).toBe(
      'Interior; detected Interior; treat as Auto (settled, committed)',
    );
    expect(scanTypeProvenance(scanTypeRecord('object', 'object', 'auto', true), 'object').disclosure).toBeNull();
  });
});

describe('buildSpaceReportPdf scan-type block', () => {
  const pos = cubeShell();

  it('prints the routed scan type, the override and the disclosure', async () => {
    const space = spaceMetrics(pos, { upAxis: 'z', spaceKind: 'object', hasRgb: false });
    const bytes = await buildSpaceReportPdf({
      space,
      object: objectMetrics(pos),
      name: 'USGS tile',
      softwareVersion: '0.6.6',
      metricVersion: 'v0.4.1',
      scanType: {
        record: scanTypeRecord('object', 'object', 'auto', true),
        current: 'terrain',
      },
    });
    const flat = await flatText(bytes);
    // The routed kind REPLACES the layout's presentation-only "Scan type".
    expect(flat).toMatch(/Scan type\s+Object; detected Object; treat as Auto \(settled, committed\)/);
    expect(flat).not.toMatch(/Scan type\s+Object\s+Units/);
    expect(flat).toContain('route now Terrain');
    expect(flat).toContain('bounding box of the sampled points');
    // Every drawn string still lands on the page.
    for (const op of await extractTextOps(bytes)) {
      expect(op.y).toBeGreaterThanOrEqual(0);
      expect(op.y).toBeLessThanOrEqual(792);
    }
  });

  it('costs the tallest report no footer height', async () => {
    // The provenance stamp is bottom-anchored and grows upward. The interior
    // report with an embedded plan already reaches it: on this fixture the
    // lowest caveat sits ~2 pt above the footer rule. So the scan-type block
    // REPLACES the layout's `Scan type` line rather than joining it, and this
    // pins that the stamp does not grow and the body stays clear of it.
    const room: number[] = [];
    const [W, D, H, step] = [14, 29, 5, 0.1];
    for (let x = 0; x <= W; x += step)
      for (let y = 0; y <= D; y += step) { room.push(x, y, 0, x, y, H); }
    for (let z = 0; z <= H; z += step) {
      for (let x = 0; x <= W; x += step) { room.push(x, 0, z, x, D, z); }
      for (let y = 0; y <= D; y += step) { room.push(0, y, z, W, y, z); }
    }
    const pts = Float32Array.from(room);
    const space = spaceMetrics(pts, { upAxis: 'z', spaceKind: 'interior', hasRgb: true });
    const floorPlan = extractFloorPlan(pts, { upAxis: 'z' });
    expect(floorPlan.wallRings.length).toBeGreaterThan(0); // the plan IS embedded
    const base = {
      space,
      name: 'House 360',
      softwareVersion: '0.6.6',
      metricVersion: 'v0.4.1',
      generatedAt: '2026-01-02T03:04:05.000Z',
      floorPlan,
    };
    // The footer stamp is every 7.5 pt line drawn at the page margin (48) or
    // its hanging indent (72). The embedded plan's dimension line shares the
    // size but sits inside its own box at 54, so the x test excludes it.
    const stampOf = async (bytes: Uint8Array): Promise<Array<{ y: number }>> =>
      (await extractTextOps(bytes)).filter((o) => o.size === 7.5 && (o.x === 48 || o.x === 72));

    const before = await stampOf(await buildSpaceReportPdf(base));
    // The longest line this block can produce: a provisional detection whose
    // route moved out from under the report. It must still be ONE line.
    const stamped = await buildSpaceReportPdf({
      ...base,
      scanType: {
        record: scanTypeRecord('interior', 'interior', 'auto', false),
        current: 'terrain',
      },
    });
    const after = await stampOf(stamped);
    expect(after.length).toBe(before.length); // replaced, not appended
    expect(Math.max(...after.map((o) => o.y))).toBe(Math.max(...before.map((o) => o.y)));

    const ops = await extractTextOps(stamped);
    const bodyFloor = Math.min(...ops.filter((o) => o.size > 8).map((o) => o.y));
    expect(bodyFloor).toBeGreaterThan(Math.max(...after.map((o) => o.y)));
    for (const op of ops) expect(op.y).toBeGreaterThanOrEqual(48 - 4);
  });

  it('leaves the report untouched when no scan-type record is supplied', async () => {
    const space = spaceMetrics(pos, { upAxis: 'z', spaceKind: 'object', hasRgb: false });
    const input = {
      space,
      object: objectMetrics(pos),
      name: 'Sculpture',
      softwareVersion: '0.6.6',
      metricVersion: 'v0.4.1',
      generatedAt: '2026-01-02T03:04:05.000Z',
    };
    const flat = await flatText(await buildSpaceReportPdf(input));
    expect(flat).not.toContain('Routed as');
    expect(flat).not.toContain('bounding box of the sampled points');
    expect(flat).toMatch(/Scan type\s+Object/); // the existing line is unchanged
  });
});
