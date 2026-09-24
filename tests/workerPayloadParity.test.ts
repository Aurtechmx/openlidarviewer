/**
 * workerPayloadParity.test.ts: an attribute the decoder fills reaches the app.
 *
 * A worker-decoded cloud is rebuilt on the main thread from a payload object,
 * `new PointCloud(msg.cloud)`. That payload is written out field by field, so
 * an attribute the decoder produces and the payload omits is dropped in
 * silence: no error, no warning, and a cloud that looks complete because every
 * other attribute is present.
 *
 * `classificationFlags` was exactly that. The LAS decoder had filled it since
 * the flag byte was wired up, `PointCloud` carried it, and the LAS writer read
 * it back — but it appeared in neither the transfer list nor the payload, so
 * it survived a direct `parseBuffer` call and vanished on the worker path the
 * application actually uses. Nothing noticed because nothing consumed the
 * flags yet, which is the worst version of this: the gap would have been found
 * by whoever first tried to use them, long after the cause.
 *
 * Testing that one field would leave the class open. This derives the
 * expectation from `PointCloud`'s own option list, so an attribute added there
 * tomorrow and forgotten in the payload fails here rather than years later.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** The per-point typed-array attributes `PointCloud` accepts at construction. */
function pointCloudAttributes(): string[] {
  const src = read('model/PointCloud.ts');
  const start = src.indexOf('export interface PointCloudOptions');
  expect(start, 'PointCloudOptions not found — has the type been renamed?')
    .toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  const names = new Set<string>();
  for (const m of body.matchAll(/^\s{2}(\w+)\?:\s*(?:Uint8Array|Uint16Array|Uint32Array|Int8Array|Int16Array|Int32Array|Float32Array|Float64Array)\s*;/gm)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/** The fields the worker copies into the payload it posts back. */
function workerPayloadFields(): string[] {
  const src = read('io/parseWorker.ts');
  const start = src.indexOf('const payload = {');
  expect(start, 'the worker payload literal was not found').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n  };', start));
  const names = new Set<string>();
  for (const m of body.matchAll(/^\s{4}(\w+):\s*cloud\.\w+,/gm)) names.add(m[1]);
  return [...names].sort();
}

/** The fields the main thread's payload type declares. */
function cloudPayloadFields(): string[] {
  const src = read('io/loadFile.ts');
  const start = src.indexOf('interface CloudPayload');
  expect(start, 'CloudPayload not found').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  const names = new Set<string>();
  for (const m of body.matchAll(/^\s{2}(\w+)\??:/gm)) names.add(m[1]);
  return [...names].sort();
}

describe('the scan is read from something, so the lists are not empty', () => {
  // A parse that silently matched nothing would make every assertion below
  // pass on two empty sets, which is the failure this whole file guards.
  it('finds the attributes PointCloud accepts', () => {
    expect(pointCloudAttributes().length).toBeGreaterThanOrEqual(8);
  });

  it('finds the fields the worker posts', () => {
    expect(workerPayloadFields().length).toBeGreaterThanOrEqual(8);
  });
});

describe('every attribute survives the worker boundary', () => {
  it('is carried in the payload the worker posts back', () => {
    const missing = pointCloudAttributes().filter((a) => !workerPayloadFields().includes(a));
    expect(
      missing,
      `these attributes are decoded and then dropped on the worker path: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('is declared on the type the main thread rebuilds from', () => {
    const declared = cloudPayloadFields();
    const missing = pointCloudAttributes().filter((a) => !declared.includes(a));
    expect(
      missing,
      `CloudPayload omits: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('is transferred rather than copied, so a large scan does not clone', () => {
    // Every attribute the payload carries should also appear in the transfer
    // list. A field posted without transfer still ARRIVES, so correctness is
    // unaffected and no other test here would catch it; what it costs is a
    // structured clone of the whole array on every load.
    const src = read('io/parseWorker.ts');
    const transferred = new Set<string>();
    for (const m of src.matchAll(/transfer\.push\(cloud\.(\w+)\.buffer/g)) transferred.add(m[1]);
    const untransferred = pointCloudAttributes().filter((a) => !transferred.has(a));
    expect(
      untransferred,
      `carried but cloned rather than transferred: ${untransferred.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * The sidecars (OB-INT-02's `acquisitionStations`, and its sibling
 * `organizedRange`) are plain data, not typed arrays, so `pointCloudAttributes`
 * above never sees them — its regex matches only the eight typed-array kinds.
 * A field this shape could still be written into the worker payload literal
 * and left out of `CloudPayload`, or the reverse, with no test catching it:
 * that gap is exactly what let `classificationFlags` (a typed array) vanish
 * before this file existed, and a non-typed-array sidecar crosses the same
 * boundary the same way — structurally cloned, never transferred, since it
 * holds no `ArrayBuffer` of its own (`AcquisitionStation.pose` is plain
 * numbers, `AcquisitionPose.rotation` a plain object).
 */
describe('the non-typed-array sidecars also survive the worker boundary', () => {
  it.each(['organizedRange', 'acquisitionStations'])(
    '%s is declared on PointCloudOptions, posted by the worker, and declared on CloudPayload',
    (field) => {
      expect(read('model/PointCloud.ts'), 'PointCloudOptions').toMatch(
        new RegExp(`${field}\\?:\\s*\\w+`),
      );
      expect(read('io/parseWorker.ts'), 'the worker payload literal').toMatch(
        new RegExp(`${field}:\\s*cloud\\.${field}`),
      );
      expect(read('io/loadFile.ts'), 'CloudPayload').toMatch(new RegExp(`${field}\\?:\\s*\\w+`));
    },
  );

  it('acquisitionStations is not pushed to the transfer list (it carries no ArrayBuffer)', () => {
    const src = read('io/parseWorker.ts');
    expect(src).not.toMatch(/transfer\.push\(cloud\.acquisitionStations/);
  });
});
