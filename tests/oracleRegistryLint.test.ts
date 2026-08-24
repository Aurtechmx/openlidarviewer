/**
 * oracleRegistryLint.test.ts — proves the oracle-registry lint REJECTS, and for
 * the stated reason.
 *
 * Each rule guards a claim about evidence that no other gate reads. O3 is the
 * one worth the most care: two programs that wrap the same library look like
 * two legs in every record format the project has, and the only thing that
 * separates them is the lineage field. A rule that cannot fire looks exactly
 * like a rule that works, so each gets input it must reject and the assertion
 * names the rule id.
 *
 * The registry here is synthetic, because these cases are about the rules. The
 * committed registry is checked by the CLI in CI.
 */

import { describe, it, expect } from 'vitest';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { collectOracleProblems } from '../scripts/lint-oracle-registry.mjs';

interface Result { problems: string[]; cited: number; lineages: number }

const REGISTRY = {
  roleDefinitions: {
    'independent-same-quantity-implementation': 'a separate codebase, same quantity',
    'standard-conformance-validator': 'format only',
    'same-lineage-corroboration': 'compatibility, never a second leg',
  },
  oracles: [
    {
      oracleId: 'proj-9.8.1',
      lineageGroup: 'proj',
      roleCapabilities: ['independent-same-quantity-implementation'],
    },
    {
      oracleId: 'geographiclib-2.7',
      lineageGroup: 'geographiclib',
      roleCapabilities: ['independent-same-quantity-implementation'],
    },
    {
      // Links PROJ, so it shares that lineage however different the program is.
      oracleId: 'gdal-3.13.1',
      lineageGroup: 'proj',
      roleCapabilities: ['independent-same-quantity-implementation'],
    },
    {
      oracleId: 'e57validate-1.0',
      lineageGroup: 'libe57',
      roleCapabilities: ['standard-conformance-validator'],
    },
  ],
};

const run = (records: unknown[], registry: unknown = REGISTRY): Result =>
  collectOracleProblems(registry, records) as Result;

const ids = (msgs: string[]) => msgs.map((m) => m.slice(1, m.indexOf(' ')));

describe('oracle registry — what it accepts', () => {
  it('accepts two oracles of different lineage in one record', () => {
    const r = run([{
      path: 'a.json',
      oracles: [
        { oracleId: 'proj-9.8.1', role: 'independent-same-quantity-implementation' },
        { oracleId: 'geographiclib-2.7', role: 'independent-same-quantity-implementation' },
      ],
    }]);
    expect(r.problems).toEqual([]);
    expect(r.cited).toBe(2);
    expect(r.lineages).toBe(2);
  });

  it('accepts a record that names no role, since role is optional', () => {
    expect(run([{ path: 'a.json', oracles: [{ oracleId: 'proj-9.8.1' }] }]).problems).toEqual([]);
  });
});

describe('O1 — an oracle must be registered before it can be cited', () => {
  it('rejects an unregistered id and says what to do', () => {
    const r = run([{ path: 'a.json', oracles: [{ oracleId: 'grass-8.5' }] }]);
    expect(ids(r.problems)).toContain('O1');
    expect(r.problems[0]).toContain('grass-8.5');
    expect(r.problems[0]).toContain('Register it');
  });

  it('rejects a typo rather than treating it as a new oracle', () => {
    const r = run([{ path: 'a.json', oracles: [{ oracleId: 'proj-9.8.2' }] }]);
    expect(ids(r.problems)).toContain('O1');
  });
});

describe('O2 — an oracle may only play a role the registry grants it', () => {
  it('rejects a format validator used as a numerical implementation', () => {
    const r = run([{
      path: 'a.json',
      oracles: [{ oracleId: 'e57validate-1.0', role: 'independent-same-quantity-implementation' }],
    }]);
    expect(ids(r.problems)).toContain('O2');
    expect(r.problems[0]).toContain('standard-conformance-validator');
  });

  it('accepts the role it does grant', () => {
    const r = run([{
      path: 'a.json',
      oracles: [{ oracleId: 'e57validate-1.0', role: 'standard-conformance-validator' }],
    }]);
    expect(r.problems).toEqual([]);
  });

  it('O0 rejects a registry that grants a role its own definitions omit', () => {
    const bad = {
      roleDefinitions: { 'analytic-truth': 'closed form' },
      oracles: [{ oracleId: 'x-1', lineageGroup: 'x', roleCapabilities: ['invented-role'] }],
    };
    expect(ids(run([], bad).problems)).toContain('O0');
  });
});

describe('O3 — same lineage is not two independent legs', () => {
  it('rejects PROJ and GDAL counted as separate implementations', () => {
    // The case this rule exists for: different programs, one lineage.
    const r = run([{
      path: 'a.json',
      oracles: [
        { oracleId: 'proj-9.8.1', role: 'independent-same-quantity-implementation' },
        { oracleId: 'gdal-3.13.1', role: 'independent-same-quantity-implementation' },
      ],
    }]);
    expect(ids(r.problems)).toContain('O3');
    const o3 = r.problems.find((p) => p.startsWith('[O3')) as string;
    expect(o3).toContain("lineage 'proj'");
    expect(o3).toContain('same-lineage corroboration');
  });

  it('does not fire when the same oracle appears twice in one record', () => {
    // Repeating an id is redundant, not a false independence claim.
    const r = run([{
      path: 'a.json',
      oracles: [{ oracleId: 'proj-9.8.1' }, { oracleId: 'proj-9.8.1' }],
    }]);
    expect(ids(r.problems)).not.toContain('O3');
  });

  it('does not fire across separate records, which are separate studies', () => {
    const r = run([
      { path: 'a.json', oracles: [{ oracleId: 'proj-9.8.1' }] },
      { path: 'b.json', oracles: [{ oracleId: 'gdal-3.13.1' }] },
    ]);
    expect(ids(r.problems)).not.toContain('O3');
  });
});
