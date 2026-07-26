/**
 * runtime.test.ts — the three measurement sources: clock, memory, environment.
 *
 * These are the modules that touch the machine, so they are also the ones that
 * would be tempted to invent a number when the runtime cannot supply one. Each
 * is asserted to either produce a real measurement or say plainly that it could
 * not — and `captureEnvironment` is additionally asserted never to throw, since
 * a benchmark run must not die because `git` is missing.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { startStageClock, elapsedMs, CLOCK_UNAVAILABLE_REASON } from '../../benchmarks/framework/clock';
import { startMemorySampler, MEMORY_UNAVAILABLE_REASON } from '../../benchmarks/framework/memory';
import { captureEnvironment, hashArtifactNode, nodeSha256Hex } from '../../benchmarks/framework/node';
import { hashArtifact } from '../../benchmarks/framework/artifacts';
import { sha256Hex } from '../../src/terrain/export/sha256';
import { isMeasured, isUnavailable, type EnvValue } from '../../benchmarks/framework/types';

describe('the stage clock', () => {
  test('measures a positive duration in ms from a monotonic source', () => {
    const stop = startStageClock();
    let acc = 0;
    for (let i = 0; i < 200_000; i++) acc += i % 7;
    const m = stop();
    expect(acc).toBeGreaterThan(0); // keep the loop from being optimised away
    expect(m.status).toBe('measured');
    if (!isMeasured(m)) throw new Error('expected a measured duration');
    expect(m.unit).toBe('ms');
    expect(m.value).toBeGreaterThan(0);
    expect(m.runtime).toBe('node');
    // A duration is never reproducible run to run; the flag must say so, or a
    // downstream table would present it as a fixed property of the software.
    expect(m.deterministic).toBe(false);
  });

  test('is monotonic — a second reading of the same clock never goes backwards', () => {
    const stop = startStageClock();
    const a = stop();
    const b = stop();
    if (!isMeasured(a) || !isMeasured(b)) throw new Error('expected measured durations');
    expect(b.value).toBeGreaterThanOrEqual(a.value);
  });

  test('reports unavailable, not 0, when the runtime has no monotonic clock', () => {
    const m = elapsedMs(null, null);
    expect(isUnavailable(m)).toBe(true);
    if (!isUnavailable(m)) throw new Error('expected an unavailable duration');
    expect(m.value).toBeNull();
    expect(m.reason).toBe(CLOCK_UNAVAILABLE_REASON);
  });
});

describe('the memory sampler', () => {
  test('reports peak RSS in bytes across the stage', () => {
    const sampler = startMemorySampler();
    const hold = new Uint8Array(8 * 1024 * 1024).fill(1);
    sampler.sample();
    const m = sampler.stop();
    expect(hold[0]).toBe(1); // keep the allocation alive until after the sample
    if (!isMeasured(m)) throw new Error('expected a measured peak RSS');
    expect(m.unit).toBe('bytes');
    expect(m.value).toBeGreaterThan(0);
    expect(Number.isInteger(m.value)).toBe(true);
    expect(m.runtime).toBe('node');
    expect(m.deterministic).toBe(false);
  });

  test('the peak is the largest sample seen, not the last one', () => {
    const sampler = startMemorySampler({ readRss: fakeReader([100, 900, 300]) });
    sampler.sample();
    sampler.sample();
    const m = sampler.stop();
    if (!isMeasured(m)) throw new Error('expected a measured peak RSS');
    expect(m.value).toBe(900);
  });

  test('reports unavailable with a reason when RSS cannot be read', () => {
    const sampler = startMemorySampler({ readRss: () => null });
    sampler.sample();
    const m = sampler.stop();
    expect(isUnavailable(m)).toBe(true);
    if (!isUnavailable(m)) throw new Error('expected an unavailable peak RSS');
    expect(m.value).toBeNull();
    expect(m.reason).toBe(MEMORY_UNAVAILABLE_REASON);
  });

  test('a reader that throws is unavailable, not zero', () => {
    const sampler = startMemorySampler({
      readRss: () => {
        throw new Error('sandboxed');
      },
    });
    const m = sampler.stop();
    expect(isUnavailable(m)).toBe(true);
  });
});

/** A stub RSS reader returning a fixed series, then repeating the last value. */
function fakeReader(series: readonly number[]): () => number {
  let i = 0;
  return () => series[Math.min(i++, series.length - 1)];
}

describe('the environment capture', () => {
  const env = captureEnvironment();
  const fields: ReadonlyArray<readonly [string, EnvValue]> = Object.entries(env);

  test('every field is either captured with a non-empty value or unavailable with a reason', () => {
    for (const [name, field] of fields) {
      if (field.status === 'captured') {
        expect(field.value.length, name).toBeGreaterThan(0);
      } else {
        expect(field.value, name).toBeNull();
        expect(field.reason.length, name).toBeGreaterThan(0);
      }
    }
  });

  test('captures the running Node version and architecture in this runtime', () => {
    expect(env.nodeVersion).toEqual({ status: 'captured', value: process.version });
    expect(env.arch).toEqual({ status: 'captured', value: process.arch });
  });

  test('reads the release version from package.json, not from a hard-coded constant', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(env.releaseVersion).toEqual({ status: 'captured', value: pkg.version });
  });

  test('the short commit is a prefix of the full commit when both are captured', () => {
    if (env.gitCommitFull.status !== 'captured' || env.gitCommitShort.status !== 'captured') return;
    expect(env.gitCommitFull.value).toMatch(/^[0-9a-f]{40}$/);
    expect(env.gitCommitFull.value.startsWith(env.gitCommitShort.value)).toBe(true);
  });

  test('every field the schema declares is actually captured or refused', () => {
    // Object.entries above only sees what the capture returned, so this pins
    // that a field added to BenchmarkEnvironment is not quietly skipped here.
    const declared: (keyof typeof env)[] = [
      'os',
      'cpuModel',
      'arch',
      'nodeVersion',
      'gitCommitShort',
      'gitCommitFull',
      'gitDirty',
      'releaseVersion',
    ];
    for (const key of declared) expect(env[key], key).toBeDefined();
    expect(fields.length).toBe(declared.length);
  });

  test('says whether the working tree matched the commit it reports', () => {
    // A commit hash with no dirty flag asserts a provenance the run may not
    // have: a benchmark from a modified checkout would report a clean hash.
    // Coupled to the commit deliberately — both come from the same `git`, so a
    // captured commit beside an unavailable tree state means this field was
    // dropped rather than genuinely undeterminable. (A source tarball with no
    // .git makes BOTH unavailable, which stays honest.)
    if (env.gitCommitFull.status === 'captured') {
      expect(env.gitDirty.status).toBe('captured');
    }
    if (env.gitDirty.status !== 'captured') {
      expect(env.gitDirty.reason.length).toBeGreaterThan(0);
      return;
    }
    expect(['clean', 'dirty']).toContain(env.gitDirty.value);
  });

  test('never throws, even when pointed at a directory that is not a repo', () => {
    expect(() => captureEnvironment({ repoRoot: '/nonexistent-path-for-benchmark-test' })).not.toThrow();
    const broken = captureEnvironment({ repoRoot: '/nonexistent-path-for-benchmark-test' });
    expect(broken.gitCommitFull.status).toBe('unavailable');
    expect(broken.releaseVersion.status).toBe('unavailable');
    if (broken.releaseVersion.status !== 'unavailable') throw new Error('expected unavailable');
    expect(broken.releaseVersion.reason.length).toBeGreaterThan(0);
  });
});

describe('the Node digest', () => {
  test('agrees with the portable implementation on the published test vector', () => {
    // Same digest bit for bit, so a hash produced on either path is comparable
    // with the other — this is a throughput fix, not a correctness one.
    const abc = new Uint8Array([0x61, 0x62, 0x63]);
    expect(nodeSha256Hex(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(nodeSha256Hex(abc)).toBe(sha256Hex(abc));
  });

  test('agrees over a larger deterministic payload', () => {
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    expect(nodeSha256Hex(bytes)).toBe(sha256Hex(bytes));
  });

  test('hashArtifactNode produces the identical record to the portable path', () => {
    const payload = { suiteId: 'decode', n: 3 };
    expect(hashArtifactNode('metrics', payload)).toEqual(hashArtifact('metrics', payload));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(hashArtifactNode('raster', bytes)).toEqual(hashArtifact('raster', bytes));
  });

  test('an injected digest is actually used', () => {
    const rec = hashArtifact('metrics', { n: 1 }, { digest: () => 'f'.repeat(64) });
    expect(rec.hash).toBe('f'.repeat(64));
  });

  test('an explicit digest still wins over the Node default', () => {
    // The two real digests are bit-identical, so nothing else can prove which
    // one hashArtifactNode wired in. This pins the composition instead.
    const rec = hashArtifactNode('metrics', { n: 1 }, { digest: () => 'e'.repeat(64) });
    expect(rec.hash).toBe('e'.repeat(64));
  });
});
