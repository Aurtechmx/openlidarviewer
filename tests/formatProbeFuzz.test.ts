/**
 * formatProbeFuzz.test.ts: seeded fuzz of the format probe.
 *
 * Heads cut from the in-repo fixtures are truncated, bit-flipped, spliced
 * with random bytes, or replaced by pure noise, then probed. The probe must
 * never throw, must always report a level from the enum, and must never ask
 * its reader for more than 1 MiB even when the file claims to be 5 GB.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chooseFormat, extensionOf, type InterpretationLevel } from '../src/io/probe/formatProbes';
import { MAX_PROBE_BYTES, probeProgressively } from '../src/io/probe/progressiveProbe';

const LEVELS: ReadonlySet<InterpretationLevel> = new Set([
  'VERIFIED', 'COMPATIBLE', 'PROBABLE', 'RECOVERED', 'PREVIEW_ONLY', 'OPAQUE', 'NOT_POINT_CLOUD',
]);
const CASES = 2400;
const HUGE = 5e9;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dir = resolve(__dirname, 'fixtures');
const fixtures = readdirSync(dir)
  .map((n) => join(dir, n))
  .filter((p) => statSync(p).isFile())
  .map((p) => ({ name: p.split('/').pop() as string, head: new Uint8Array(readFileSync(p)).subarray(0, 64 * 1024) }));

function mutate(rng: () => number, src: Uint8Array): Uint8Array {
  const kind = Math.floor(rng() * 4);
  if (kind === 0) return src.slice(0, Math.floor(rng() * (src.length + 1)));
  if (kind === 3) return Uint8Array.from({ length: Math.floor(rng() * 20000) }, () => Math.floor(rng() * 256));
  const out = src.slice();
  if (kind === 1) {
    const flips = 1 + Math.floor(rng() * 32);
    for (let i = 0; i < flips && out.length > 0; i++) out[Math.floor(rng() * out.length)] ^= 1 << Math.floor(rng() * 8);
  } else {
    const at = Math.floor(rng() * out.length);
    for (let i = at; i < Math.min(out.length, at + 1 + Math.floor(rng() * 512)); i++) out[i] = Math.floor(rng() * 256);
  }
  return out;
}

describe('format probe fuzz', () => {
  it(`${CASES} mutated heads: no throw, a known level, never more than 1 MiB read`, async () => {
    expect(fixtures.length).toBeGreaterThan(10);
    const rng = mulberry32(0x5eed);
    const names = ['', 'scan', 'x.bin', 'x.dat', 'a.xyz', 'a.las', 'a.pts', 'a.ply', 'a.e57'];
    let furthest = 0;
    for (let c = 0; c < CASES; c++) {
      const f = fixtures[c % fixtures.length];
      const head = mutate(rng, f.head);
      const name = rng() < 0.5 ? f.name : names[Math.floor(rng() * names.length)];
      const direct = chooseFormat({ bytes: head, complete: rng() < 0.5, ext: extensionOf(name) });
      expect(LEVELS.has(direct.level)).toBe(true);
      const read = async (n: number): Promise<Uint8Array> => {
        furthest = Math.max(furthest, n);
        const out = new Uint8Array(n);
        out.set(head.subarray(0, n));
        return out;
      };
      const { decision } = await probeProgressively(read, HUGE, name, rng() < 0.5 ? head : undefined);
      expect(LEVELS.has(decision.level)).toBe(true);
    }
    expect(furthest).toBeLessThanOrEqual(MAX_PROBE_BYTES);
  });
});
