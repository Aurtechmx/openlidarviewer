import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { deriveObservationState } from '../src/observation/stateTable';
import type { ObservationState, SourceObservationRecord } from '../src/observation/types';

/**
 * OB-ST-01 exhaustive-lattice test. The lattice itself is enumerated once, in
 * Python, by validation/observatory/oracle/state_table.py (an independent
 * restatement of docs/observatory/SPEC.md §2.2-§2.4, not a transliteration of
 * stateTable.ts) and frozen to the JSON this test reads. Replaying frozen,
 * fully-explicit rows means the two implementations are compared only on the
 * state they assign a given input, never on how the lattice was generated —
 * see state-table-lattice.json's own header for why.
 *
 * Regenerate after a deliberate change to the function or the thresholds:
 *   python3 validation/observatory/oracle/state_table.py --write
 */

interface LatticeRow {
  readonly insideDomain: boolean;
  readonly sources: readonly SourceObservationRecord[];
  readonly expected: { readonly state: ObservationState; readonly ruleId: string };
}

const EXPECTED_PATH = join(__dirname, '..', 'validation', 'observatory', 'expected', 'state-table-lattice.expected.json');
const PARAMS_PATH = join(__dirname, '..', 'validation', 'observatory', 'oracle', 'state-table-lattice.json');

const frozen = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) as { rowCount: number; rows: LatticeRow[] };
const config = JSON.parse(readFileSync(PARAMS_PATH, 'utf8')) as { params: { p_solid: number; p_empty: number; n_min: number } };

describe('OB-ST-01 state table — exhaustive lattice (Python oracle agreement)', () => {
  it('the frozen file is not empty and its own row count matches its row array', () => {
    expect(frozen.rows.length).toBeGreaterThan(0);
    expect(frozen.rows.length).toBe(frozen.rowCount);
  });

  it('agrees with the independent Python restatement on every row of the lattice', () => {
    const mismatches: string[] = [];
    for (let i = 0; i < frozen.rows.length; i++) {
      const row = frozen.rows[i];
      const decision = deriveObservationState(row.sources, row.insideDomain, config.params);
      if (decision.state !== row.expected.state || decision.ruleId !== row.expected.ruleId) {
        mismatches.push(
          `row ${i}: got ${decision.state}/${decision.ruleId}, oracle says ${row.expected.state}/${row.expected.ruleId} `
            + `(insideDomain=${row.insideDomain}, sources=${JSON.stringify(row.sources)})`,
        );
        if (mismatches.length >= 5) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('covers every ObservationState at least once (a real exhaustive lattice, not a narrow one)', () => {
    const seen = new Set(frozen.rows.map((r) => r.expected.state));
    const all: ObservationState[] = [
      'SURFACE', 'PARTIAL', 'OBSERVED_EMPTY', 'CONFLICT', 'SHADOWED',
      'NO_RETURN_PATH', 'UNADDRESSED', 'NOT_READ', 'OUTSIDE_DOMAIN',
    ];
    for (const s of all) expect(seen.has(s), `lattice never produces ${s}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Falsification checklist items this phase can already test (SPEC §9.3),
// as direct unit assertions independent of the lattice above.
// ---------------------------------------------------------------------------

function source(over: Partial<SourceObservationRecord> = {}): SourceObservationRecord {
  return {
    sourceIndex: 0,
    hit: 0,
    pass: 0,
    behind: 0,
    noReturn: 0,
    saturated: false,
    addressed: true,
    notDecoded: false,
    ...over,
  };
}

const params = config.params;

describe('OB-INV-02 — CONFLICT requires two distinct sources', () => {
  it('a single source, however contradictory internally, never produces CONFLICT', () => {
    // hit=9,pass=1 alone reads solid; there is no second source to disagree with.
    const decision = deriveObservationState([source({ hit: 9, pass: 1 })], true, params);
    expect(decision.state).not.toBe('CONFLICT');
  });

  it('within-source disagreement (a mixed pixel) yields PARTIAL, never CONFLICT', () => {
    const decision = deriveObservationState([source({ hit: 5, pass: 5 })], true, params);
    expect(decision.state).toBe('PARTIAL');
  });

  it('two distinct sources, one solid and one empty, DO produce CONFLICT and name both', () => {
    const decision = deriveObservationState(
      [source({ sourceIndex: 0, hit: 9, pass: 1 }), source({ sourceIndex: 1, hit: 0, pass: 9 })],
      true,
      params,
    );
    expect(decision.state).toBe('CONFLICT');
    expect(decision.conflict?.solidSourceIndex).toBe(0);
    expect(decision.conflict?.emptySourceIndex).toBe(1);
  });
});

describe('OB-INV-01 — an unaddressed, no-return or not-read voxel is never OBSERVED_EMPTY', () => {
  it('UNADDRESSED never equals OBSERVED_EMPTY', () => {
    const decision = deriveObservationState([source({ addressed: false })], true, params);
    expect(decision.state).toBe('UNADDRESSED');
    expect(decision.state).not.toBe('OBSERVED_EMPTY');
  });

  it('NO_RETURN_PATH never equals OBSERVED_EMPTY', () => {
    const decision = deriveObservationState([source({ noReturn: 3 })], true, params);
    expect(decision.state).toBe('NO_RETURN_PATH');
    expect(decision.state).not.toBe('OBSERVED_EMPTY');
  });

  it('NOT_READ never equals OBSERVED_EMPTY', () => {
    const decision = deriveObservationState([source({ notDecoded: true })], true, params);
    expect(decision.state).toBe('NOT_READ');
    expect(decision.state).not.toBe('OBSERVED_EMPTY');
  });
});

describe('SPEC §9.3 — CONFLICT is never averaged into SURFACE', () => {
  it('a solid/empty pair returns CONFLICT, not an averaged mid-fraction SURFACE or PARTIAL', () => {
    // Aggregate hit fraction here (9/19 ~= 0.47) would read PARTIAL if it were
    // computed from the sum before CONFLICT is checked; it must not be.
    const decision = deriveObservationState(
      [source({ sourceIndex: 0, hit: 9, pass: 1 }), source({ sourceIndex: 1, hit: 0, pass: 9 })],
      true,
      params,
    );
    expect(decision.state).toBe('CONFLICT');
  });
});

describe('OUTSIDE_DOMAIN is applied first (validation/protocols/observatory/OB-ST-THRESHOLDS.protocol.json)', () => {
  it('wins over evidence that would otherwise read SURFACE', () => {
    const decision = deriveObservationState([source({ hit: 100, pass: 0 })], false, params);
    expect(decision.state).toBe('OUTSIDE_DOMAIN');
  });
});
