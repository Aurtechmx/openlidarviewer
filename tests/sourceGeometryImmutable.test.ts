/**
 * Source geometry is immutable: the positions a file decoded to must remain
 * byte-identical through everything the app can do with the cloud.
 *
 * This is acceptance criterion #1 of the v0.6 stable cycle, and it is now
 * TRUE by construction, not merely by reachability: the one writer
 * (`rebaseOrigin`, the in-place Float32 mount rebase) was removed in step 5
 * of docs/architecture/float64-transform.md. Mounting is a Float64 placement
 * held beside the cloud, applied at read time. These tests are the complete
 * immutability proof — every path on the class leaves the buffer
 * byte-identical, and the API surface is pinned so a writer cannot come back
 * without failing here.
 */
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { toXyz, toPly, toObj, toCsv } from '../src/io/exporters';
import { cloudToGlobal } from '../src/convert/globalPoints';

/** A deterministic little survey cloud on a UTM-scale origin. */
function cloud(): PointCloud {
  const n = 500;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = Math.fround(Math.sin(i) * 40);
    positions[i * 3 + 1] = Math.fround(Math.cos(i) * 40);
    positions[i * 3 + 2] = Math.fround((i % 23) * 0.5);
  }
  return new PointCloud({
    positions,
    origin: [516_000, 4_644_000, 70],
    sourceFormat: 'las',
    name: 'immutability-fixture',
  });
}

/** Stable byte hash of the positions buffer. */
function hashPositions(c: PointCloud): string {
  const bytes = new Uint8Array(
    c.positions.buffer,
    c.positions.byteOffset,
    c.positions.byteLength,
  );
  // FNV-1a — cheap, deterministic, and byte-sensitive; a test helper, not crypto.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

describe('source geometry stays byte-identical', () => {
  it('through every read path: bounds, worldXYZ, exports, the global lift', () => {
    const c = cloud();
    const before = hashPositions(c);

    c.bounds();
    const w: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < c.pointCount; i++) c.worldXYZ(i, w);
    toXyz(c);
    toCsv(c);
    toPly(c);
    toObj(c);
    cloudToGlobal(c);

    expect(hashPositions(c)).toBe(before);
  });

  it('through derived-classification attachment', () => {
    const c = cloud();
    const before = hashPositions(c);
    c.attachDerivedClassification(new Uint8Array(c.pointCount));
    expect(hashPositions(c)).toBe(before);
  });

  it('the API surface contains no method that mutates positions', () => {
    // This case used to DOCUMENT THE DEFECT: it asserted that `rebaseOrigin`
    // really did rewrite the buffer, so the defect could not be forgotten.
    // The writer is gone, so the case flips as its comment always said it
    // must: pin the whole method surface, call every member on it, and show
    // the buffer never changes. A future method that writes positions has to
    // add itself to this list to compile a call here — and then fails the
    // hash below.
    const surface = Object.getOwnPropertyNames(PointCloud.prototype)
      .filter((n) => n !== 'constructor')
      .sort();
    expect(surface).toEqual([
      'attachDerivedClassification',
      'bounds',
      'classification',
      'classificationIsDerived',
      'pointCount',
      'projectXYZ',
      'rebaseQuantum',
      'worldXYZ',
    ]);

    const c = cloud();
    const before = hashPositions(c);
    c.attachDerivedClassification(new Uint8Array(c.pointCount));
    c.bounds();
    void c.classification;
    void c.classificationIsDerived;
    void c.pointCount;
    c.projectXYZ(0, { sourceToProject: [1_000, -2_000, 30] });
    c.rebaseQuantum([616_000, 4_644_000, 70]);
    c.worldXYZ(0);
    expect(hashPositions(c)).toBe(before);
  });
});
