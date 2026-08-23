/**
 * profileSectionBuilder.test.ts
 *
 * Attribute integrity for the section builder.
 *
 * Every channel value is a distinct function of (slot, sourceIndex), so a
 * value read one index off, or read from the wrong source, produces a number
 * that cannot occur at that position. Checking a constant fill would not
 * separate those failures from a correct read.
 */
import { describe, it, expect } from 'vitest';
import {
  ProfileSectionBuilder,
  profileSectionHas,
  PROFILE_ATTRIBUTE_BIT,
  type ProfileSourceChannels,
} from '../src/render/measure/profileSectionBuilder';

/** Channel values keyed so a one-index shift changes every one of them. */
const intensityAt = (slot: number, i: number): number => 1000 * (slot + 1) + i * 7;
const classAt = (slot: number, i: number): number => (slot * 31 + i * 13) % 256;
const rgbAt = (slot: number, i: number, c: number): number => (slot * 17 + i * 5 + c * 61) % 256;
const gpsAt = (slot: number, i: number): number => slot * 1e6 + i * 0.001;
const retNumAt = (slot: number, i: number): number => ((i + slot * 2) % 5) + 1;
const retCntAt = (slot: number, i: number): number => ((i + slot) % 4) + 1;
const psidAt = (slot: number, i: number): number => 7000 + slot * 100 + (i % 90);
const normAt = (slot: number, i: number, c: number): number => slot + i * 0.25 + c * 0.125;

function channelsFor(slot: number, n: number, which: Set<string>): ProfileSourceChannels {
  const out: Record<string, unknown> = {};
  if (which.has('rgb')) {
    const a = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) a[i * 3 + c] = rgbAt(slot, i, c);
    out.rgb = a;
  }
  if (which.has('intensity')) {
    const a = new Uint16Array(n);
    for (let i = 0; i < n; i++) a[i] = intensityAt(slot, i);
    out.intensity = a;
  }
  if (which.has('classification')) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = classAt(slot, i);
    out.classification = a;
  }
  if (which.has('returnNumber')) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = retNumAt(slot, i);
    out.returnNumber = a;
  }
  if (which.has('returnCount')) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = retCntAt(slot, i);
    out.returnCount = a;
  }
  if (which.has('pointSourceId')) {
    const a = new Uint16Array(n);
    for (let i = 0; i < n; i++) a[i] = psidAt(slot, i);
    out.pointSourceId = a;
  }
  if (which.has('gpsTime')) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = gpsAt(slot, i);
    out.gpsTime = a;
  }
  if (which.has('normals')) {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) a[i * 3 + c] = normAt(slot, i, c);
    out.normals = a;
  }
  return out as ProfileSourceChannels;
}

describe('section builder keeps every attribute on its own point', () => {
  it('carries a full channel set through unshifted, past a growth boundary', () => {
    // Accepting every third of 9000 gives 3000 returns, which crosses the
    // 1024 doubling threshold and then 2048, so the reallocation path runs
    // rather than only the initial buffer.
    const n = 9000;
    const all = new Set([
      'rgb',
      'intensity',
      'classification',
      'returnNumber',
      'returnCount',
      'pointSourceId',
      'gpsTime',
      'normals',
    ]);
    const b = new ProfileSectionBuilder();
    b.beginSource(0, channelsFor(0, n, all), n);
    // Accept every third point so source index and section index differ, which
    // a test accepting all points cannot distinguish from a correct read.
    const accepted: number[] = [];
    for (let i = 0; i < n; i += 3) {
      b.push(i, i * 0.5, i * 0.25, i % 7 === 0 ? 1.5 : -1.5);
      accepted.push(i);
    }
    const p = b.finish();
    expect(p.count).toBe(accepted.length);
    expect(p.count).toBeGreaterThan(1024);

    for (let k = 0; k < p.count; k++) {
      const src = accepted[k]!;
      expect(p.pointIndex[k]).toBe(src);
      expect(p.sourceSlot[k]).toBe(0);
      expect(p.chainage[k]).toBeCloseTo(src * 0.5, 4);
      expect(p.height[k]).toBeCloseTo(src * 0.25, 4);
      expect(p.intensity![k]).toBe(intensityAt(0, src));
      expect(p.classification![k]).toBe(classAt(0, src));
      expect(p.returnNumber![k]).toBe(retNumAt(0, src));
      expect(p.returnCount![k]).toBe(retCntAt(0, src));
      expect(p.pointSourceId![k]).toBe(psidAt(0, src));
      expect(p.gpsTime![k]).toBeCloseTo(gpsAt(0, src), 9);
      for (let c = 0; c < 3; c++) {
        expect(p.rgb![k * 3 + c]).toBe(rgbAt(0, src, c));
        expect(p.normals![k * 3 + c]).toBeCloseTo(normAt(0, src, c), 5);
      }
    }
  });

  it('keeps mixed sources apart and marks absence per point', () => {
    // A carries RGB and classification; B carries intensity and GPS time;
    // C carries nothing. Interleaved so a per-snapshot presence flag would
    // be wrong for two of the three.
    const nA = 40;
    const nB = 40;
    const nC = 40;
    const b = new ProfileSectionBuilder();

    b.beginSource(0, channelsFor(0, nA, new Set(['rgb', 'classification'])), nA);
    for (let i = 0; i < nA; i++) b.push(i, i, i, 0);
    b.beginSource(1, channelsFor(1, nB, new Set(['intensity', 'gpsTime'])), nB);
    for (let i = 0; i < nB; i++) b.push(i, i, i, 0);
    b.beginSource(2, null, nC);
    for (let i = 0; i < nC; i++) b.push(i, i, i, 0);

    const p = b.finish();
    expect(p.count).toBe(nA + nB + nC);

    for (let k = 0; k < p.count; k++) {
      const slot = p.sourceSlot[k]!;
      const src = p.pointIndex[k]!;
      if (slot === 0) {
        expect(profileSectionHas(p, k, 'rgb')).toBe(true);
        expect(profileSectionHas(p, k, 'classification')).toBe(true);
        expect(profileSectionHas(p, k, 'intensity')).toBe(false);
        expect(profileSectionHas(p, k, 'gpsTime')).toBe(false);
        expect(p.classification![k]).toBe(classAt(0, src));
        expect(p.rgb![k * 3]).toBe(rgbAt(0, src, 0));
      } else if (slot === 1) {
        expect(profileSectionHas(p, k, 'intensity')).toBe(true);
        expect(profileSectionHas(p, k, 'gpsTime')).toBe(true);
        expect(profileSectionHas(p, k, 'rgb')).toBe(false);
        expect(profileSectionHas(p, k, 'classification')).toBe(false);
        expect(p.intensity![k]).toBe(intensityAt(1, src));
        expect(p.gpsTime![k]).toBeCloseTo(gpsAt(1, src), 9);
      } else {
        expect(p.channelPresence[k]).toBe(0);
      }
    }
  });

  it('omits a channel no source carried rather than emitting zeros', () => {
    const b = new ProfileSectionBuilder();
    b.beginSource(0, channelsFor(0, 10, new Set(['intensity'])), 10);
    for (let i = 0; i < 10; i++) b.push(i, i, i, 0);
    const p = b.finish();
    expect(p.intensity).toBeDefined();
    expect(p.rgb).toBeUndefined();
    expect(p.gpsTime).toBeUndefined();
    expect(p.classification).toBeUndefined();
    expect(p.normals).toBeUndefined();
  });

  it('drops a misaligned channel for that source instead of shifting it', () => {
    // A classification array one element short cannot be index-aligned. The
    // sampler applies the same rule to its own classification input.
    const n = 20;
    const good = channelsFor(0, n, new Set(['classification', 'intensity']));
    const bad: ProfileSourceChannels = {
      classification: good.classification!.slice(0, n - 1),
      intensity: good.intensity,
    };
    const b = new ProfileSectionBuilder();
    b.beginSource(0, bad, n);
    for (let i = 0; i < n; i++) b.push(i, i, i, 0);
    const p = b.finish();

    expect(p.classification).toBeUndefined();
    for (let k = 0; k < p.count; k++) {
      expect(profileSectionHas(p, k, 'classification')).toBe(false);
      expect(profileSectionHas(p, k, 'intensity')).toBe(true);
      expect(p.intensity![k]).toBe(intensityAt(0, k));
    }
  });

  it('assigns one bit per attribute', () => {
    const bits = Object.values(PROFILE_ATTRIBUTE_BIT);
    expect(new Set(bits).size).toBe(bits.length);
    for (const v of bits) expect(v & (v - 1)).toBe(0);
    expect(bits.reduce((a, c) => a | c, 0)).toBe(0xff);
  });

  it('reports an empty section without allocating channels', () => {
    const p = new ProfileSectionBuilder().finish();
    expect(p.count).toBe(0);
    expect(p.chainage.length).toBe(0);
    expect(p.rgb).toBeUndefined();
  });
});
