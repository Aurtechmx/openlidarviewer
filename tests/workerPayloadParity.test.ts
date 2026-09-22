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
