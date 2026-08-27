/**
 * streamingFrameProvenance.test.ts — a new streaming source cannot quietly
 * decline to say what its document established about up.
 *
 * `StreamingSource.frameProvenance` is optional in the type, and only because
 * three sources predate it: settling what a projected-CRS COPC, an EPT pyramid
 * or an OLV tile store declares is a separate question from the 3D Tiles one,
 * and answering it by guessing would put a fabricated vertical reference in
 * front of a user.
 *
 * Optional in the type means a source added tomorrow could omit the property
 * and nothing would complain — which is exactly the regression this whole area
 * is about, one level up. So the omission is a LIST, and the list is
 * shrink-only: adding a source without the record fails here, and teaching one
 * of the three to answer is a deletion from the list.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Sources that predate the record and are not covered by this change. Anything
 * ADDED here is a source whose vertical reference nobody can read, so this list
 * may shrink and never grow.
 */
const WITHOUT_RECORD = [
  'io/heavy/OlvTileSource.ts',
  'render/streaming/EptStreamingPointCloud.ts',
  'render/streaming/StreamingPointCloud.ts',
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every file declaring a class that implements the streaming contract. */
function implementers(): { path: string; text: string }[] {
  return tsFiles(SRC)
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter((f) => /class\s+\w+\s+implements\s+StreamingSource\b/.test(f.text))
    .map((f) => ({ path: relative(SRC, f.path).split('\\').join('/'), text: f.text }));
}

describe('every streaming source states its frame provenance', () => {
  it('finds the implementations at all, so a silent zero cannot pass', () => {
    expect(implementers().length).toBeGreaterThanOrEqual(4);
  });

  it('declares frameProvenance, unless it is on the shrink-only list', () => {
    const missing = implementers()
      .filter((f) => !/\bframeProvenance\b/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(
      missing,
      'a streaming source with no frame record is indistinguishable from one ' +
        'whose up axis was established; add the record rather than the file',
    ).toEqual([...WITHOUT_RECORD].sort());
  });

  it('keeps the exemption list shrink-only', () => {
    expect(
      WITHOUT_RECORD.length,
      'the list grew, which means a new source shipped without saying whether ' +
        'its heights are measured along a known up',
    ).toBeLessThanOrEqual(3);
  });
});
