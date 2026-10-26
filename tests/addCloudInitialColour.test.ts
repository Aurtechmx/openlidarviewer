/**
 * addCloudInitialColour.test.ts
 *
 * A scan is coloured once at load, in the mode the app recommends for it,
 * with the options a mode switch uses (height trim, coverage grid, up axis).
 * The colour buffer it ends with must equal the one the earlier two-pass open
 * produced (colour by the default mode, then switch to the recommended one).
 * And a scan opened after the height trim changed must be coloured with that
 * trim, the one the legend states. The shipped Viewer methods run against a
 * fake `this`; colours go through the real `toFloatColors` upload seam.
 */

import { describe, it, expect } from 'vitest';
import { Viewer } from '../src/render/Viewer';
import { PointCloud } from '../src/model/PointCloud';
import { colorForMode, type ColorMode } from '../src/render/colorModes';
import { recommendColorMode } from '../src/render/colorModeRecommend';
import { toFloatColors } from '../src/render/colorEncode';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
}

function cloud(kind: 'bare' | 'classified' | 'intensity', seed = 3): PointCloud {
  const rnd = prng(seed);
  const n = 4_000;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = rnd() * 100;
    positions[i * 3 + 1] = rnd() * 100;
    // A few tall outliers so the percentile trim moves the window.
    positions[i * 3 + 2] = i % 97 === 0 ? 400 + rnd() * 100 : rnd() * 30;
  }
  const extra =
    kind === 'classified'
      ? { classification: new Uint8Array(n).map(() => [1, 2, 2, 5, 6][Math.floor(rnd() * 5)]!), intensity: new Uint16Array(n).map(() => Math.floor(rnd() * 60_000)) }
      : kind === 'intensity'
        ? { intensity: new Uint16Array(n).map(() => Math.floor(rnd() * 60_000)) }
        : {};
  return new PointCloud({ positions, ...extra, origin: [10, 20, 30], sourceFormat: 'las', name: `${kind}.las` });
}

interface Entry { cloud: PointCloud; mode: ColorMode; colorAttr: { array: Float32Array; needsUpdate: boolean } }

function viewer() {
  const clouds = new Map<string, Entry>();
  const v = Object.assign(Object.create(Viewer.prototype) as object, {
    _clouds: clouds,
    _nextId: 0,
    _heightPercentileTrim: 5,
    _projectSharedElevation: false,
    _coverageGrid: null,
    _scene: { add: () => {} },
    _organized: { register: () => {} },
    _demand: { changed: () => {} },
    _resetGpuErrorHistory: () => {},
    _configureForClouds: () => {},
    _notifyColorContextChanged: () => {},
    buildPointMesh: (_p: Float32Array, colorsU8: Uint8Array) => ({
      mesh: {},
      material: {},
      colorAttr: { array: toFloatColors(colorsU8), needsUpdate: false },
      classAttr: null,
    }),
  }) as unknown as Viewer;
  return { v, clouds };
}

const bytes = (a: Float32Array): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

describe('addCloud colours once, in the recommended mode', () => {
  for (const kind of ['bare', 'classified', 'intensity'] as const) {
    it(`${kind}: the one-pass buffer equals the two-pass buffer`, () => {
      const c = cloud(kind);
      const mode = recommendColorMode(c).mode;
      expect(mode).toBe(kind === 'bare' ? 'elevation' : kind === 'classified' ? 'classification' : 'intensity');

      // The earlier open: colour by the default mode, then switch.
      const before = viewer();
      const idA = before.v.addCloud(c);
      before.v.setColorMode(idA, mode);
      const want = before.clouds.get(idA)!.colorAttr.array;

      // The same buffer, computed directly with the options a mode switch uses.
      const direct = toFloatColors(colorForMode(mode, c, { heightPercentileTrim: 5, coverageGrid: undefined, upAxis: 2 }));
      expect(Buffer.compare(bytes(want), bytes(direct))).toBe(0);

      // The one-pass open.
      const after = viewer();
      const idB = (after.v.addCloud as (cl: PointCloud, m?: ColorMode) => string)(c, mode);
      after.v.setColorMode(idB, mode);
      expect(after.clouds.get(idB)!.mode).toBe(mode);
      expect(Buffer.compare(bytes(after.clouds.get(idB)!.colorAttr.array), bytes(want))).toBe(0);
    });
  }

  it('with the project-wide height scale on, a non-elevation layer does not widen the shared window', () => {
    const { v, clouds } = viewer();
    (v as unknown as { _projectSharedElevation: boolean })._projectSharedElevation = true;
    const first = cloud('bare', 3);
    const idP = v.addCloud(first);
    const second = cloud('classified', 8);
    const mode = recommendColorMode(second).mode;
    const idN = (v.addCloud as (cl: PointCloud, m?: ColorMode) => string)(second, mode);
    v.setColorMode(idN, mode);
    // One elevation layer: no shared window, so it keeps its own, as the legend states.
    expect(v.projectSharedElevationRange()).toBeNull();
    const own = toFloatColors(colorForMode('elevation', first, { heightPercentileTrim: 5, upAxis: 2 }));
    expect(Buffer.compare(bytes(clouds.get(idP)!.colorAttr.array), bytes(own))).toBe(0);
  });

  it('a scan opened after the height trim changed is coloured with that trim', () => {
    const c = cloud('bare');
    const { v, clouds } = viewer();
    v.setHeightPercentileTrim(15);
    const id = v.addCloud(c);
    v.setColorMode(id, 'elevation');
    const got = clouds.get(id)!.colorAttr.array;
    const atUserTrim = toFloatColors(colorForMode('elevation', c, { heightPercentileTrim: 15, upAxis: 2 }));
    const atDefaultTrim = toFloatColors(colorForMode('elevation', c, { heightPercentileTrim: 5, upAxis: 2 }));
    expect(Buffer.compare(bytes(atUserTrim), bytes(atDefaultTrim))).not.toBe(0);
    expect(Buffer.compare(bytes(got), bytes(atUserTrim))).toBe(0);
  });
});
