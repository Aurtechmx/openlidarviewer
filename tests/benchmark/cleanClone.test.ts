/**
 * Unit cover for the pure predicates behind `npm run benchmark:clean-clone`,
 * and for the publication battery's tier arithmetic.
 *
 * Both scripts run as plain node for the reason `archivePortability.test.ts`
 * gives: importing an application module would pull in the Vite
 * `BUILD_IDENTITY` define and tie a check about what exists outside the working
 * tree to a build of that tree. What is testable in isolation is the deciding:
 * which paths count as missing, which tier omits what, and which set of
 * outcomes is a failure. Each case has a matching negative, because a predicate
 * that never says no cannot catch anything.
 */
import { describe, it, expect } from 'vitest';

// @ts-expect-error — plain .mjs tooling module, no type declarations
import { REQUIRED_PATHS, missingFrom, satisfiedByPrefix } from '../../scripts/verify-clean-clone.mjs';
// @ts-expect-error — plain .mjs tooling module, no type declarations
import { SUITES, suitesForTier, omittedByTier, batteryFailed, counts, renderBattery } from '../../scripts/publication-battery.mjs';

describe('missingFrom', () => {
  it('names the wanted paths a tree does not carry', () => {
    expect(missingFrom(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('names nothing when the tree carries everything', () => {
    expect(missingFrom(['a', 'b'], ['b', 'a', 'z'])).toEqual([]);
  });
});

describe('satisfiedByPrefix', () => {
  it('accepts a directory target that something lives under', () => {
    expect(satisfiedByPrefix('docs-site/', ['docs-site/index.md'])).toBe(true);
  });

  it('rejects a directory target with nothing under it, and any file target', () => {
    expect(satisfiedByPrefix('docs-site/', ['README.md'])).toBe(false);
    expect(satisfiedByPrefix('scripts/gate.sh', ['scripts/gate.sh'])).toBe(false);
  });
});

describe('REQUIRED_PATHS', () => {
  it('states why each path is required', () => {
    for (const [path, reason] of Object.entries(REQUIRED_PATHS) as [string, string][]) {
      expect(reason.length, path).toBeGreaterThan(10);
    }
  });

  /**
   * The specific regression the list exists for: an unanchored `build` pattern
   * in `.gitignore` once untracked `src/build/buildIdentity.ts`, so a clean
   * checkout would not typecheck while every working tree still built.
   */
  it('covers the file a gitignore pattern once untracked', () => {
    expect(Object.keys(REQUIRED_PATHS)).toContain('src/build/buildIdentity.ts');
  });

  it('covers the install and build leg the archive suite recorded as unrun', () => {
    expect(Object.keys(REQUIRED_PATHS)).toContain('package-lock.json');
    expect(Object.keys(REQUIRED_PATHS)).toContain('scripts/check-bundle-budget.mjs');
    expect(Object.keys(REQUIRED_PATHS)).toContain('scripts/check-dep-singletons.mjs');
  });
});

describe('the battery registry', () => {
  it('gives every suite a claim its evidence backs', () => {
    for (const s of SUITES) {
      expect(s.claim.length, s.id).toBeGreaterThan(20);
      expect(s.script, s.id).toMatch(/^benchmark:/);
    }
  });

  it('lets nothing skip without a reason', () => {
    for (const s of SUITES) {
      if (s.required) continue;
      expect(typeof s.requires, s.id).toBe('function');
      expect(s.requires({}), s.id).toBeTruthy();
    }
  });

  it('runs every registered suite in the verify tier', () => {
    expect(suitesForTier('verify').map((s: { id: string }) => s.id)).toEqual(
      SUITES.map((s: { id: string }) => s.id),
    );
  });

  it('makes quick a strict subset of verify', () => {
    const quick = suitesForTier('quick').map((s: { id: string }) => s.id);
    const verify = suitesForTier('verify').map((s: { id: string }) => s.id);
    expect(quick.length).toBeLessThan(verify.length);
    for (const id of quick) expect(verify).toContain(id);
  });

  it('names what quick omits, and omits nothing from verify', () => {
    const omitted = omittedByTier('quick').map((s: { id: string }) => s.id);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted).toContain('repro');
    expect(omitted).toContain('scaling');
    expect(omittedByTier('verify')).toEqual([]);
  });

  it('carries the seed-sensitivity and clean-clone suites', () => {
    const ids = SUITES.map((s: { id: string }) => s.id);
    expect(ids).toContain('seeds');
    expect(ids).toContain('clean-clone');
    expect(ids).toContain('archive-portability');
  });
});

describe('the verdict', () => {
  const outcome = (id: string, status: string) => ({ id, status });

  it('fails on any suite that ran and failed', () => {
    expect(batteryFailed([outcome('units', 'passed'), outcome('repro', 'failed')])).toBe(true);
  });

  it('fails when a required suite was skipped', () => {
    expect(batteryFailed([outcome('units', 'skipped')])).toBe(true);
  });

  it('does not fail when an optional suite was skipped', () => {
    expect(batteryFailed([outcome('units', 'passed'), outcome('backends-gpu', 'skipped')])).toBe(false);
  });

  it('passes only when everything that had to run did', () => {
    expect(batteryFailed(SUITES.map((s: { id: string }) => outcome(s.id, 'passed')))).toBe(false);
  });

  it('counts a skip and a not-run separately from a pass', () => {
    const c = counts([
      outcome('a', 'passed'),
      outcome('b', 'skipped'),
      outcome('c', 'not-run'),
      outcome('d', 'failed'),
    ]);
    expect(c).toEqual({ passed: 1, failed: 1, skipped: 1, 'not-run': 1 });
  });
});

describe('the rendered summary', () => {
  const report = {
    tier: 'quick',
    startedAt: '2000-01-01T00:00:00.000Z',
    node: 'v22.0.0',
    platform: 'linux-x64',
    counts: { passed: 1, failed: 0, skipped: 1, 'not-run': 0 },
    verdict: 'PASS',
    outcomes: [
      { id: 'units', script: 'benchmark:units', required: true, claim: 'units are units', status: 'passed', seconds: 1.5, note: null },
      {
        id: 'backends-gpu',
        script: 'benchmark:backends:gpu',
        required: false,
        claim: 'the WGSL path agrees',
        status: 'skipped',
        seconds: null,
        note: 'no WebGPU adapter here',
      },
    ],
    omitted: [{ id: 'repro', script: 'benchmark:repro', claim: 'ten identical runs' }],
  };

  it('prints a skipped suite as skipped, with its reason, never as passing', () => {
    const md = renderBattery(report);
    expect(md).toContain('| `backends-gpu` |');
    expect(md).toContain('**skipped**');
    expect(md).toContain('no WebGPU adapter here');
    expect(md).not.toMatch(/backends-gpu.*\*\*passed\*\*/);
  });

  it('names what the tier omitted', () => {
    const md = renderBattery(report);
    expect(md).toContain('What the `quick` tier omits');
    expect(md).toContain('`repro`');
    expect(md).toContain('is not a publication result');
  });

  it('lists a not-run suite as unknown rather than as a pass', () => {
    const md = renderBattery({
      ...report,
      outcomes: [
        ...report.outcomes,
        { id: 'contours', script: 'benchmark:contours', required: true, claim: 'contours are right', status: 'not-run', seconds: null, note: 'an earlier suite failed' },
      ],
    });
    expect(md).toContain('Not reached');
    expect(md).toContain('which is not a pass');
  });
});
