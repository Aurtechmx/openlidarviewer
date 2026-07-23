/**
 * Source geometry is immutable: the positions a file decoded to must remain
 * byte-identical through everything the app can do with the cloud.
 *
 * This is acceptance criterion #1 of the v0.6 stable cycle, and it is TRUE
 * today by reachability: the one write path (`rebaseOrigin`, the in-place
 * Float32 mount rebase) sits behind `MULTI_LAYER_MOUNT_ENABLED = false`, so
 * no reachable operation touches the buffer. These tests pin that state so
 * the Float64 transform work cannot regress it — when the destructive rebase
 * is finally removed, the explicit rebase cases below flip from "documents
 * the one remaining writer" to "proves there is none".
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

  it('a no-op rebase (target === current origin) touches nothing', () => {
    const c = cloud();
    const before = hashPositions(c);
    expect(c.rebaseOrigin([516_000, 4_644_000, 70])).toBe(false);
    expect(hashPositions(c)).toBe(before);
  });

  it('DOCUMENTS THE DEFECT: a real rebase still rewrites the buffer', () => {
    // The destructive in-place mount rebase is the ONE writer left, reachable
    // only through the disabled mount flag. This case asserts the current
    // (wrong) behaviour on purpose: when the Float64 transform removes the
    // rewrite, it MUST be updated to expect byte-identity — turning this file
    // into the complete immutability proof. If it starts failing because the
    // buffer stopped changing, that is the migration landing, not a bug.
    const c = cloud();
    const before = hashPositions(c);
    expect(c.rebaseOrigin([516_100, 4_644_000, 70])).toBe(true);
    expect(hashPositions(c)).not.toBe(before);
    // The world frame is preserved by the rewrite (that is its contract) —
    // restore returns to the source frame, but Float32 re-quantisation makes
    // the round trip inexact. Exactness is what the Float64 transform buys.
    c.restoreSourceFrame();
    expect(c.isRebased).toBe(false);
  });
});
