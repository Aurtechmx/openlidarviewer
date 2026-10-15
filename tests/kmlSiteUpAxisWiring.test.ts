/**
 * The resolved spatial context is built without a placement, so its up-axis is
 * 'unknown' for every scan. A frame gate that reads it raw refuses an ordinary
 * Z-up LAS (the Site KML button stayed disabled with "up-axis was not
 * determined"). The shell must resolve the axis through `sourceUpAxis`, the one
 * format/frame policy every export boundary uses: LAS/LAZ and LAS-derived
 * streams settle to z, an ambiguous mesh frame stays unknown and is refused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceUpAxis } from '../src/io/sniffFormat';
import { lonLatUpAxisRefusal } from '../src/export/scanFootprint';

const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

describe('shell up-axis wiring for frame gates', () => {
  it('never hands the raw context up-axis to a gate', () => {
    const raw = main.match(/crsService\.context\(\)\.upAxis/g) ?? [];
    const viaPolicy = main.match(/sourceUpAxis\(crsService\.context\(\)\.upAxis/g) ?? [];
    expect(raw.length).toBe(viaPolicy.length);
  });

  it('the Site KML deps and the coordinate HUD read the policy-resolved axis', () => {
    const kmlDeps = main.slice(main.indexOf('const kmlDeps: KmlActionDeps'), main.indexOf('loadKmlExport,', main.indexOf('const kmlDeps: KmlActionDeps')));
    expect(kmlDeps).toMatch(/upAxis: activeUpAxis/);
    const hud = main.slice(main.indexOf('onHoverInfo: lazyCoordinateHud'), main.indexOf('onHoverInfo: lazyCoordinateHud') + 300);
    expect(hud).toMatch(/upAxis: activeUpAxis/);
  });

  it('the policy admits a Z-up LAS and a streamed source, and still refuses an ambiguous mesh', () => {
    expect(lonLatUpAxisRefusal(sourceUpAxis('unknown', 'las', false))).toBeNull();
    expect(lonLatUpAxisRefusal(sourceUpAxis('unknown', 'laz', false))).toBeNull();
    expect(lonLatUpAxisRefusal(sourceUpAxis('unknown', undefined, true))).toBeNull();
    expect(lonLatUpAxisRefusal(sourceUpAxis('unknown', 'ply', false))).toMatch(/up-axis was not determined/);
    expect(lonLatUpAxisRefusal(sourceUpAxis('y', 'las', false))).toMatch(/Y-up/);
  });
});
