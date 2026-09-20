/**
 * The renderer benchmark record's shape, and the one property that makes it
 * worth having before there is a record.
 *
 * A benchmark of a display feature is trivially favourable when whoever runs
 * it chooses the scenes, and the scenes that flatter gap closure are the flat
 * dense ones. So the corpus is the required set and the verifier refuses a
 * record that omits any of it. These tests hold the two lists together and
 * exercise the verifier against records built to be wrong.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTINUITY_SCENES } from './fixtures/continuityScenes';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'verify-renderer-benchmark.mjs');
const SCHEMA = join(ROOT, 'validation', 'renderer-benchmark', 'manifest.schema.json');

/** The scene list the verifier enforces, read out of its source. */
function requiredScenesInVerifier(): string[] {
  const src = readFileSync(SCRIPT, 'utf8');
  const block = /const REQUIRED_SCENES = \[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error('REQUIRED_SCENES not found in the verifier');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const measurement = (mode: string, over: Record<string, number> = {}) => ({
  mode,
  gpuFrameTimeMs: 4,
  cpuFrameTimeMs: 3,
  gpuAttributeBytes: 1024,
  directCoverage: mode === 'source' ? 0.6 : 0.5,
  // A source render reconstructs nothing, so its parts are the whole.
  reconstructedCoverage: mode === 'source' ? 0 : 0.1,
  finalCoverage: 0.6,
  edgeLeakage: mode === 'source' ? 0 : 0.01,
  temporalVariance: 0,
  settleMs: 40,
  ...over,
});

/** Every rung the verifier requires a record to measure. */
const TIERS = ['sizing', 'closure', 'full'] as const;

function record(scenes: readonly string[]) {
  return {
    schemaVersion: 1,
    commit: 'a'.repeat(40),
    environment: {
      browser: 'Test 1.0',
      backend: 'webgpu',
      gpu: 'Test Adapter',
      os: 'Test OS 1.0',
      devicePixelRatio: 2,
      viewportPx: { width: 1920, height: 1080 },
    },
    criteria: { maxEdgeLeakage: 0.05, maxFrameTimeRatio: 2, maxSettleMs: 200 },
    // Each scene at each rung: a record covering every scene at one rung says
    // nothing about whether the rung above it was worth the cost.
    cases: scenes.flatMap((scene) => TIERS.map((tier) => ({
      scene,
      dataset: 'a named dataset',
      pointCount: 1_000_000,
      cameraCase: 'parked',
      cameraPose: { position: [0, 0, 10], target: [0, 0, 0], fovDeg: 60 },
      baseline: measurement('source'),
      continuity: measurement(tier),
      verdict: 'pass',
    }))),
  };
}

/** Run the verifier against a directory holding exactly these records. */
function runVerifier(records: Record<string, unknown>[]): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'olv-bench-'));
  const target = join(dir, 'validation', 'renderer-benchmark');
  mkdirSync(target, { recursive: true });
  cpSync(SCHEMA, join(target, 'manifest.schema.json'));
  records.forEach((r, i) => writeFileSync(join(target, `run-${i}.json`), JSON.stringify(r)));
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'verify-renderer-benchmark.mjs')], {
      encoding: 'utf8',
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALL_SCENES = CONTINUITY_SCENES.map((s) => s.name);

describe('the required scenes are the corpus', () => {
  it('lists exactly the scenes the corpus defines', () => {
    expect(requiredScenesInVerifier().sort()).toEqual([...ALL_SCENES].sort());
  });

  it('includes the difficult ones rather than the flattering ones only', () => {
    const required = requiredScenesInVerifier();
    for (const hard of ['vegetation', 'silhouette edge', 'roof edge', 'near/far depth range']) {
      expect(required).toContain(hard);
    }
  });
});

describe('the verifier accepts a complete record', () => {
  it('passes a record covering every scene', () => {
    const { ok, out } = runVerifier([record(ALL_SCENES)]);
    expect(ok, out).toBe(true);
    expect(out).toContain(`all ${ALL_SCENES.length} corpus scenes`);
  });

  it('passes with no records at all, since nothing measured is not a failure', () => {
    const { ok, out } = runVerifier([]);
    expect(ok, out).toBe(true);
    expect(out).toContain('0 records');
  });
});

describe('the verifier refuses a record that chose its scenes', () => {
  it('fails when a difficult scene is dropped', () => {
    const cherry = ALL_SCENES.filter((s) => s !== 'vegetation');
    const { ok, out } = runVerifier([record(cherry)]);
    expect(ok).toBe(false);
    expect(out).toContain('vegetation');
  });

  it('fails when only the flattering scenes are kept', () => {
    const { ok, out } = runVerifier([record(['sparse flat plane', 'mixed-density terrain'])]);
    expect(ok).toBe(false);
    expect(out).toContain('required scene');
  });

  it('fails on a scene the corpus does not define', () => {
    const { ok, out } = runVerifier([record([...ALL_SCENES, 'a scene that flatters'])]);
    expect(ok).toBe(false);
    expect(out).toContain('unknown scene');
  });
});

describe('the verifier refuses a record that is not a comparison', () => {
  const withCase = (patch: Record<string, unknown>) => {
    const r = record(ALL_SCENES) as unknown as { cases: Record<string, unknown>[] };
    r.cases[0] = { ...r.cases[0], ...patch };
    return r as unknown as Record<string, unknown>;
  };

  it('fails when the baseline is not the source mode', () => {
    const { ok, out } = runVerifier([withCase({ baseline: measurement('closure') })]);
    expect(ok).toBe(false);
    expect(out).toContain('baseline mode must be source');
  });

  it('fails when both sides are the source mode', () => {
    const { ok, out } = runVerifier([withCase({ continuity: measurement('source') })]);
    expect(ok).toBe(false);
    expect(out).toContain('must not be source');
  });

  it('fails when a source render claims edge leakage', () => {
    const { ok, out } = runVerifier([
      withCase({ baseline: measurement('source', { edgeLeakage: 0.2 }) }),
    ]);
    expect(ok).toBe(false);
    expect(out).toContain('edge leakage is 0');
  });

  it('fails when continuity covered less than the baseline', () => {
    const { ok, out } = runVerifier([
      withCase({ continuity: measurement('closure', { finalCoverage: 0.1 }) }),
    ]);
    expect(ok).toBe(false);
    expect(out).toContain('covered less than the baseline');
  });

  it('fails a failing case that gives no reason', () => {
    const { ok, out } = runVerifier([withCase({ verdict: 'fail' })]);
    expect(ok).toBe(false);
    expect(out).toContain('states why');
  });
});

describe('the verifier refuses a malformed record', () => {
  it('fails on an abbreviated commit', () => {
    const r = record(ALL_SCENES) as unknown as Record<string, unknown>;
    r.commit = 'abc1234';
    const { ok, out } = runVerifier([r]);
    expect(ok).toBe(false);
    expect(out).toContain('commit');
  });

  it('fails on a backend the renderer does not have', () => {
    const r = record(ALL_SCENES) as unknown as { environment: Record<string, unknown> };
    r.environment = { ...r.environment, backend: 'metal' };
    const { ok, out } = runVerifier([r as unknown as Record<string, unknown>]);
    expect(ok).toBe(false);
    expect(out).toContain('backend');
  });

  it('fails on a property nobody defined', () => {
    const r = record(ALL_SCENES) as unknown as Record<string, unknown>;
    r.favourable = true;
    const { ok, out } = runVerifier([r]);
    expect(ok).toBe(false);
    expect(out).toContain('unexpected property');
  });
});

describe('the record carries what the phase asks for', () => {
  const withoutEnv = (key: string) => {
    const r = record(ALL_SCENES) as unknown as { environment: Record<string, unknown> };
    delete r.environment[key];
    return r as unknown as Record<string, unknown>;
  };

  it.each(['gpu', 'os'])('fails without the %s', (key) => {
    // A frame time without the machine that produced it says nothing that
    // transfers anywhere else.
    const { ok, out } = runVerifier([withoutEnv(key)]);
    expect(ok).toBe(false);
    expect(out).toContain(key);
  });

  it.each(['pointCount', 'cameraPose'])('fails without the %s', (key) => {
    const r = record(ALL_SCENES) as unknown as { cases: Record<string, unknown>[] };
    delete r.cases[0][key];
    const { ok, out } = runVerifier([r as unknown as Record<string, unknown>]);
    expect(ok).toBe(false);
    expect(out).toContain(key);
  });

  it('fails without the reconstructed share', () => {
    const r = record(ALL_SCENES) as unknown as { cases: Record<string, unknown>[] };
    const c = r.cases[0].continuity as Record<string, unknown>;
    delete c.reconstructedCoverage;
    const { ok, out } = runVerifier([r as unknown as Record<string, unknown>]);
    expect(ok).toBe(false);
    expect(out).toContain('reconstructedCoverage');
  });

  it('fails when the shares do not add up to what was drawn', () => {
    // Every pixel of the final coverage came from a sample or from a fill. A
    // record where the parts miss the whole is describing pixels from
    // somewhere else.
    const r = record(ALL_SCENES) as unknown as { cases: Record<string, unknown>[] };
    r.cases[0].continuity = measurement('sizing', { reconstructedCoverage: 0.3 });
    const { ok, out } = runVerifier([r as unknown as Record<string, unknown>]);
    expect(ok).toBe(false);
    expect(out).toContain('sum to the final coverage');
  });

  it('fails when a rung was never measured', () => {
    // A record covering every scene at one rung says nothing about whether the
    // rung above it was worth the cost.
    const r = record(ALL_SCENES) as unknown as { cases: Record<string, unknown>[] };
    r.cases = r.cases.filter((c) => (c.continuity as { mode: string }).mode !== 'full');
    const { ok, out } = runVerifier([r as unknown as Record<string, unknown>]);
    expect(ok).toBe(false);
    expect(out).toContain('no full case for the scene');
  });
});
