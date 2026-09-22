/**
 * fieldSimulationOracleAgreement.test.ts: two implementations, one answer.
 *
 * `validation/field-simulation/oracle/flow_oracle.py` computes D8 direction
 * and flow accumulation for the frozen fixtures, in another language and by a
 * different algorithm: it walks downstream from every cell where the viewer
 * drains cells in dependency order. This compares the viewer against those
 * frozen records, field by field.
 *
 * What agreement buys is narrow and worth stating. It catches transcription
 * slips, a drifting tie-break, and an axis-scaling mistake, because those
 * would have to occur identically in two independently written routines to go
 * unnoticed. It is not external validation: both implementations were written
 * in this project, so a shared misreading of the published method survives
 * agreement. The fixtures are small enough to check by hand, which is the
 * backstop for that.
 *
 * The Python is not run here. The expectations are committed, so this test
 * needs no interpreter and the gate gains no dependency; regenerating them is
 * a deliberate act (`flow_oracle.py --write`) that shows up in the diff.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { flowAccumulation } from '../src/simulation/flowPulse/flowAccumulation';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'validation', 'field-simulation');
const FIXTURES = join(ROOT, 'fixtures');
const EXPECTED = join(ROOT, 'expected');

interface Fixture {
  readonly name: string;
  readonly why: string;
  readonly cellMetresX: number;
  readonly cellMetresY: number;
  readonly z: readonly (readonly (number | null)[])[];
}

interface Expected {
  readonly receiver: readonly number[];
  readonly direction: readonly number[];
  readonly status: readonly number[];
  readonly upstreamCells: readonly number[];
  readonly sinkCount: number;
  readonly flatCount: number;
  readonly outletCount: number;
}

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

function gridOf(f: Fixture): FlowGrid {
  const rows = f.z.length;
  const cols = f.z[0].length;
  const z = new Float32Array(cols * rows);
  const valid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = f.z[r][c];
      if (v === null) continue;
      z[r * cols + c] = v;
      valid[r * cols + c] = 1;
    }
  }
  return { z, valid, cols, rows, cellMetresX: f.cellMetresX, cellMetresY: f.cellMetresY };
}

const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();

describe('the fixture set is present', () => {
  it('has fixtures to compare, so the agreement below is not vacuous', () => {
    // A directory that quietly emptied would turn every it.each below into
    // zero assertions and this file would still report success.
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it('has a frozen expectation for every fixture', () => {
    const frozen = new Set(readdirSync(EXPECTED).filter((f) => f.endsWith('.json')));
    for (const n of names) expect(frozen.has(n)).toBe(true);
  });
});

describe.each(names)('%s', (name) => {
  const fixture = read<Fixture>(join(FIXTURES, name));
  const want = read<Expected>(join(EXPECTED, name));
  const grid = gridOf(fixture);
  const routed = d8Flow(grid);

  it('routes every cell to the same receiver', () => {
    expect([...routed.receiver]).toEqual([...want.receiver]);
  });

  it('takes the same neighbour, so tie-breaking agrees', () => {
    expect([...routed.direction]).toEqual([...want.direction]);
  });

  it('classifies every cell the same way', () => {
    expect([...routed.status]).toEqual([...want.status]);
  });

  it('counts the same sinks, flats and outlets', () => {
    expect({
      sink: routed.sinkCount, flat: routed.flatCount, outlet: routed.outletCount,
    }).toEqual({
      sink: want.sinkCount, flat: want.flatCount, outlet: want.outletCount,
    });
  });

  it('accumulates to the same upstream counts by a different algorithm', () => {
    const acc = flowAccumulation(grid, routed);
    expect([...acc.upstreamCells]).toEqual([...want.upstreamCells]);
  });
});
