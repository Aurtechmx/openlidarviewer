/**
 * observatoryO11Benchmark.test.ts: the O11 scenarios are deterministic, and
 * the decision rule is the one validation/protocols/observatory-o11-v1.md
 * fixes (instancing only when it is at least 10% faster with at most 1.5x the
 * upload bytes on all four scenarios; budgets at slicing + 20%).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildO11Scenarios, castO11Returns, buildO11StressStates, type O11RoomScenario } from '../scripts/generate-observatory-fixtures.mjs';
import { budgetsFromSlicing, decideO11, summariseArm, O11_SCENARIOS } from '../scripts/lib/observatoryO11.mjs';

const digest = (a: ArrayBufferView) => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

describe('O11 scenarios', () => {
  it('declares the four protocol scenarios with the declared sizes', () => {
    const s = buildO11Scenarios();
    expect(s.map((x) => x.id)).toEqual(O11_SCENARIOS);
    const room = (id: string) => s.find((x) => x.id === id) as O11RoomScenario;
    const returns = (r: O11RoomScenario) => r.stations.length * r.angularGrid.azimuthSteps * r.angularGrid.elevationSteps;
    expect(returns(room('small'))).toBe(99_856);
    expect(room('small').stations.length).toBe(1);
    expect(returns(room('medium'))).toBe(1_080_000);
    expect(room('medium').stations.length).toBe(3);
    expect(returns(room('large'))).toBe(2_000_000);
    expect(room('large').stride).toBe(4);
  });

  it('builds the same returns and stress states on every call', () => {
    const small = buildO11Scenarios()[0] as O11RoomScenario;
    const a = castO11Returns(small);
    const b = castO11Returns(buildO11Scenarios()[0] as O11RoomScenario);
    expect(digest(a.positions)).toBe(digest(b.positions));
    expect(a.recordRanges).toEqual([{ start: 0, end: 99_856 }]);
    // Every return lies inside the room.
    for (let i = 0; i < a.positions.length; i += 3 * 97) {
      for (let k = 0; k < 3; k++) {
        expect(a.positions[i + k]!).toBeGreaterThanOrEqual(small.room.minCorner[k]! - 1e-3);
        expect(a.positions[i + k]!).toBeLessThanOrEqual(small.room.maxCorner[k]! + 1e-3);
      }
    }
    const stress = buildO11Scenarios()[3]!;
    if (stress.kind !== 'synthetic') throw new Error('stress must be synthetic');
    const sa = buildO11StressStates({ ...stress, grid: { nx: 64, ny: 64, nz: 2 } }, 8);
    const sb = buildO11StressStates({ ...stress, grid: { nx: 64, ny: 64, nz: 2 } }, 8);
    expect(digest(sa)).toBe(digest(sb));
    expect(Math.max(...sa)).toBeLessThan(8);
  });
});

describe('O11 decision rule', () => {
  const slicing = Object.fromEntries(O11_SCENARIOS.map((id) => [id, { ok: true, p95Ms: 10, uploadBytes: 1_000_000 }]));

  it('fixes budgets at slicing + 20%', () => {
    const b = budgetsFromSlicing(slicing);
    expect(b.small!.frameMs).toBeCloseTo(12, 9);
    expect(b.small!.uploadMiB).toBeCloseTo((1_000_000 / 1048576) * 1.2, 9);
  });

  it('chooses instancing only when every scenario passes both tests', () => {
    const good = Object.fromEntries(O11_SCENARIOS.map((id) => [id, { ok: true, p95Ms: 9, uploadBytes: 1_500_000 }]));
    expect(decideO11(slicing, good).chosen).toBe('instancing');
    expect(decideO11(slicing, { ...good, large: { ok: true, p95Ms: 9.01, uploadBytes: 1 } }).chosen).toBe('slicing');
    expect(decideO11(slicing, { ...good, small: { ok: true, p95Ms: 1, uploadBytes: 1_500_001 } }).chosen).toBe('slicing');
    const failed = decideO11(slicing, { ...good, stress: { ok: false, error: 'device lost' } });
    expect(failed.chosen).toBe('slicing');
    expect(failed.scenarios.stress!.note).toContain('device lost');
  });

  it('summarises an arm as the median p95 of its runs, failed if any run failed', () => {
    expect(summariseArm([{ ok: true, p95Ms: 3, uploadBytes: 5 }, { ok: true, p95Ms: 1, uploadBytes: 5 }, { ok: true, p95Ms: 2, uploadBytes: 5 }])).toEqual({ ok: true, p95Ms: 2, uploadBytes: 5 });
    expect(summariseArm([{ ok: true, p95Ms: 3, uploadBytes: 5 }, { ok: false, error: 'x' }]).ok).toBe(false);
  });
});
