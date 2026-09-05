/**
 * A display sample is not full coverage.
 *
 * A large LAS/E57 is loaded with a stride (`chooseLoadMode` -> 'stride'), so the
 * resident points are a subset of the file. `signalsFromLive` emitted no
 * `coverage`, and `deriveScanFacts` defaults a static scan to 'full' — so a
 * 90M-point file rendered from 4M points reported "The whole cloud is available
 * to the operation."
 *
 * The classification verdict inherited the same error: it is computed from the
 * loaded class histogram, so a sample that happens to contain no class 0 or 1
 * was called a full classification. The skipped points were never looked at.
 *
 * `Coverage` already had 'sampled', and both `qaChecks` and `processCapabilities`
 * already act on it — only the producer was missing.
 */
import { describe, it, expect } from 'vitest';
import { deriveScanFacts } from '../src/process/scanFacts';

describe('deriveScanFacts respects a declared sample', () => {
  it('keeps a static scan full when nothing says otherwise', () => {
    expect(deriveScanFacts({ kind: 'static', pointCount: 1000 } as never).coverage).toBe('full');
  });

  it('honours an explicit sampled coverage rather than defaulting', () => {
    expect(deriveScanFacts({ kind: 'static', coverage: 'sampled', pointCount: 1000 } as never)
      .coverage).toBe('sampled');
  });

  it('still defaults streaming to resident-only', () => {
    expect(deriveScanFacts({ kind: 'streaming', pointCount: 1000 } as never)
      .coverage).toBe('resident-only');
  });
});

describe('the sampled verdict reaches the QA and capability layers', () => {
  it('QA downgrades coverage to review, naming the limit', async () => {
    const { runQaChecks } = await import('../src/qa/qaChecks');
    const facts = deriveScanFacts({ kind: 'static', coverage: 'sampled', pointCount: 1000 } as never);
    const checks = runQaChecks(facts as never);
    const coverage = checks.find((c) => c.label === 'Coverage');
    expect(coverage?.status, 'a sampled scan passed the coverage check').not.toBe('pass');
    expect(coverage?.reason).toMatch(/sampled subset/i);
  });
});

describe('the shell reports a strided load as sampled', () => {
  it('signalsFromLive reads the stride and the declared total', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/processStudioMount.ts', 'utf8'));
    expect(src).toMatch(/getActiveLoadStride/);
    expect(src).toMatch(/coverage: 'sampled'/);
    // And the classification verdict must be gated on it, not only coverage.
    const body = src.slice(src.indexOf('const classification = !hasClasses'));
    expect(body.slice(0, 600)).toMatch(/!sampled/);
  });

  it('the accessor is wired to the cloud, not left optional-and-unset', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/processStudioMount.ts', 'utf8'));
    expect(src).toMatch(/getActiveLoadStride: \(\) => shell\.getActiveCloud\(\)\?\.loadStride/);
  });
});
