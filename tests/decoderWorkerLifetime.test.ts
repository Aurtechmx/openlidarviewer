/**
 * decoderWorkerLifetime.test.ts — the COPC / EPT decoder is created once and
 * kept.
 *
 * The decode worker is expensive to start and is shared by every streaming
 * scan, so the composition root holds one and hands it out. Two properties
 * carry that: the opener creates a client only when there is none, and nothing
 * terminates it when a scan closes. Reversing either one turns a warm decoder
 * into a per-scan cost, or lets the population grow with the number of opens,
 * which is what the long-session checklist in docs/disposal-contracts.md is
 * there to catch.
 *
 * Read from source rather than driven through a browser: the behaviour is a
 * two-line ownership rule, and the browser path needs a COPC fixture this
 * suite does not carry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('the decode worker client is session-cached', () => {
  it('the streaming opener reuses the held client and only builds one when there is none', () => {
    const src = read('src/app/openStreaming.ts');
    expect(src).toMatch(/const copcDecoder = deps\.getCopcDecoder\(\)|let copcDecoder = deps\.getCopcDecoder\(\)/);
    // The construction is guarded by the absence of a held client, and the new
    // one is handed back to the owner so the next scan finds it.
    const guarded = /if \(!copcDecoder\) \{\s*copcDecoder = new CopcWorkerClient\(\);\s*deps\.setCopcDecoder\(copcDecoder\);\s*\}/;
    expect(src).toMatch(guarded);
  });

  it('no scan-close path terminates it', () => {
    let readAny = 0;
    for (const file of ['src/main.ts', 'src/app/openStreaming.ts', 'src/app/closeScan.ts']) {
      let src: string;
      try {
        src = read(file);
      } catch {
        continue; // a renamed or removed file is covered by the count below
      }
      readAny++;
      for (const line of src.split('\n')) {
        if (!/terminate\s*\(/.test(line)) continue;
        expect(line, `${file} terminates a worker on a scan path: ${line.trim()}`).not.toMatch(
          /copcDecoder|laszipDecoder|CopcWorkerClient/,
        );
      }
    }
    // A rename that emptied the candidate list would otherwise pass this test
    // by reading nothing at all.
    expect(readAny, 'at least one scan path was read').toBeGreaterThan(0);
  });
});
