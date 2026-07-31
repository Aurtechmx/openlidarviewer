/**
 * generalizationRecord.test.ts — proves the generalisation verifier REJECTS, and
 * for the stated reason.
 *
 * A verifier nobody has watched fail is a decoration. Each rejection below gets
 * its own case: a record that is valid in every other respect, one field bent,
 * and an assertion on the rule id the verifier reports. Asserting the id, not
 * merely a non-zero exit, is what stops a case from passing because a different
 * rule happened to fire on a fixture that drifted.
 *
 * The verifier runs as a child process, so the exit code a release gate would
 * see is the exit code this suite observes.
 *
 * Two cases matter more than the rest. G5 is the container's reason to exist: an
 * argument from mechanism and an assumption are both writable and neither may be
 * counted as evidence. G11 is the one that keeps the check from being a
 * decoration in the other direction — an empty register must go red, because a
 * pass over zero records certifies nothing while looking exactly like a pass
 * that certified something.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { GENERALIZATION_STATUSES, BASIS_KINDS, MEASURED_BASES, UNSUPPORTED_BASES, EXTRAPOLATION_AXES, ASSERTING_STATUSES, UNCOUNTED_STATUSES, SOURCE_REGISTRIES } from '../scripts/verify-generalization-record.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = join(ROOT, 'scripts/verify-generalization-record.mjs');
const SCHEMA = join(ROOT, 'validation/generalization/generalization-record.schema.json');

type Json = Record<string, any>;

/** Run the verifier and report the literal exit code plus its combined output. */
function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [VERIFIER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The rule ids the verifier reported, deduplicated, in first-seen order. */
function rules(out: string): string[] {
  const found: string[] = [];
  for (const m of out.matchAll(/•\s*\[([A-Z0-9-]+)\]/g)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * A register that verifies: one record reasoning from a claim that exists,
 * along one axis, on an assumption, asserting nothing. Every negative case
 * starts here and bends one thing.
 */
function makeRegister(): { dir: string; record: Json } {
  const dir = mkdtempSync(join(tmpdir(), 'olv-generalization-'));
  mkdirSync(join(dir, 'records'), { recursive: true });

  const record: Json = {
    schemaVersion: 1,
    recordId: 'TEST-REACH-001',
    example: false,
    source: {
      kind: 'claim',
      id: 'DTM',
      measured: 'A DTM over the bundled synthetic fixture at one parameter set.',
    },
    dimension: {
      axis: 'point-density',
      measuredRange: '8 points per square metre, one fixture',
      extrapolatedTo: '2 to 40 points per square metre',
    },
    assertion: 'The surface behaves the same way between 2 and 40 points per square metre.',
    basis: {
      kind: 'assumed',
      statement: 'Nothing measures it. The record exists so the reach is visible rather than implied.',
    },
    status: 'proposed',
    statusReason: 'Written down, not assessed.',
    boundary: { doesNotExtendTo: ['Any other axis.'] },
    reviewedAt: '2026-07-31',
  };
  return { dir, record };
}

/** Write `record` into `dir` and verify the register it forms. */
function verify(dir: string, record: Json | null) {
  if (record !== null) {
    writeFileSync(join(dir, 'records/record.json'), `${JSON.stringify(record, null, 2)}\n`);
  }
  return run(['--records', join(dir, 'records')]);
}

/** Run one case against a fresh register and clean up after it. */
function check(bend: (r: Json) => void) {
  const { dir, record } = makeRegister();
  try {
    bend(record);
    return verify(dir, record);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A measured basis that resolves, for the cases that need one. */
function measuredBasis(): Json {
  return {
    kind: 'measured-second-dataset',
    statement: 'Re-measured on a second dataset that differs along this axis.',
    measurement: {
      sourceKind: 'cross-implementation-study',
      sourceIds: ['OLV-XS-001-SLOPE-RASTER-GDAL-HORN'],
      datasetIds: ['OLV-DS-001-ANALYTIC-DEM'],
      summary: 'Agreed within the same tolerance at the second density, with a larger spread near breaklines.',
      retrievedAt: '2026-07-30',
    },
  };
}

describe('verify-generalization-record', () => {
  it('accepts the baseline record it was given', () => {
    const r = check(() => {});
    expect(r.out).toContain('verify:generalization-record OK');
    expect(r.code).toBe(0);
  });

  it('verifies the committed register, which asserts no generalisation', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(ROOT, 'validation/generalization/records'));
    // Nothing committed may claim a reach carried by a second measurement
    // without this line being changed in the same commit.
    expect(r.out).toContain('Generalisations carried on a second measurement: 0');
    expect(readFileSync(join(ROOT, 'validation/generalization/README.md'), 'utf8'))
      .toContain('Nothing in this register is evidence');
  });

  it('G1 rejects a record missing a required section', () => {
    const r = check((rec) => { delete rec.boundary; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G1-SCHEMA');
  });

  it('G1 rejects a boundary that states nothing', () => {
    const r = check((rec) => { rec.boundary.doesNotExtendTo = []; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G1-SCHEMA');
  });

  it('G1 rejects an axis outside the vocabulary', () => {
    const r = check((rec) => { rec.dimension.axis = 'vibes'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G1-SCHEMA');
    expect(r.out).toContain('permitted values');
  });

  it('G2 rejects an EXAMPLE- id that is not marked example', () => {
    const r = check((rec) => { rec.recordId = 'EXAMPLE-TEST-REACH-001'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G2-EXAMPLE');
  });

  it('G2 rejects an example that refuses a generalisation', () => {
    const r = check((rec) => {
      rec.recordId = 'EXAMPLE-TEST-REACH-001';
      rec.example = true;
      rec.status = 'refused';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G2-EXAMPLE');
  });

  // The rule that makes the source resolve. Without it a reach from a study
  // that does not exist reads exactly like a reach from one that does.
  it('G3 rejects a source study that resolves nowhere', () => {
    const r = check((rec) => { rec.source.id = 'NO-SUCH-STUDY'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G3-SOURCE-UNRESOLVED');
    expect(r.out).toContain('sentence with no subject');
  });

  it('G3 rejects a cross-implementation study id that is not on file', () => {
    const r = check((rec) => {
      rec.source.kind = 'cross-implementation-study';
      rec.source.id = 'OLV-XS-999-INVENTED';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G3-SOURCE-UNRESOLVED');
  });

  it('G3 accepts every source kind against its own register', () => {
    const cases: Array<[string, string]> = [
      ['claim', 'SLOPE-RASTER'],
      ['cross-implementation-study', 'OLV-XS-001-SLOPE-RASTER-GDAL-HORN'],
    ];
    for (const [kind, id] of cases) {
      const r = check((rec) => { rec.source.kind = kind; rec.source.id = id; });
      expect(r.code, `${kind}:${id}`).toBe(0);
    }
  });

  it('G4 rejects a real record reasoning from an EXAMPLE study', () => {
    const r = check((rec) => {
      rec.source.kind = 'field-study';
      rec.source.id = 'EXAMPLE-DTM-FIELD-CHECK';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G4-SOURCE-IS-EXAMPLE');
  });

  // The rule this whole container exists for.
  it('G5 rejects an argument from mechanism counted as a measured result', () => {
    const r = check((rec) => {
      rec.basis = { kind: 'mechanism', statement: 'The gradient operator is scale invariant, so density cannot matter.' };
      rec.status = 'supported';
      rec.statusReason = 'The mechanism settles it.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G5-BASIS-NOT-EVIDENCE');
    expect(r.out).toContain('none of them is a result');
  });

  it('G5 rejects an assumption dressed as an argument', () => {
    const r = check((rec) => {
      rec.status = 'argued';
      rec.statusReason = 'Filed as an argument.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G5-BASIS-NOT-EVIDENCE');
  });

  it('G5 rejects an assumption asserted as supported', () => {
    const r = check((rec) => {
      rec.status = 'supported';
      rec.statusReason = 'Asserted.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G5-BASIS-NOT-EVIDENCE');
  });

  it('G5 permits an unsupported basis to be recorded and refused', () => {
    const r = check((rec) => {
      rec.status = 'refused';
      rec.statusReason = 'Considered, and it does not hold.';
    });
    expect(r.code).toBe(0);
  });

  it('G6 rejects a measured basis that names no measurement', () => {
    const r = check((rec) => {
      rec.basis = { kind: 'measured-second-dataset', statement: 'We measured it elsewhere.' };
      rec.status = 'supported';
      rec.statusReason = 'Measured.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G6-MEASUREMENT-MISSING');
  });

  it('G6 rejects a second measurement that is the source study itself', () => {
    const r = check((rec) => {
      rec.source.kind = 'cross-implementation-study';
      rec.source.id = 'OLV-XS-001-SLOPE-RASTER-GDAL-HORN';
      rec.basis = measuredBasis();
      rec.status = 'supported';
      rec.statusReason = 'Measured.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G6-MEASUREMENT-MISSING');
    expect(r.out).toContain('not a second one');
  });

  it('G6 rejects a dataset nobody registered', () => {
    const r = check((rec) => {
      rec.basis = measuredBasis();
      rec.basis.measurement.datasetIds = ['OLV-DS-999-IMAGINARY'];
      rec.status = 'supported';
      rec.statusReason = 'Measured.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G6-MEASUREMENT-MISSING');
  });

  it('G6 rejects a measurement block hung under an unmeasured basis', () => {
    const r = check((rec) => {
      rec.basis = measuredBasis();
      rec.basis.kind = 'mechanism';
      rec.status = 'argued';
      rec.statusReason = 'Argued.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G6-MEASUREMENT-MISSING');
  });

  it('G6 accepts a measured reach whose second study and datasets resolve', () => {
    const r = check((rec) => {
      rec.basis = measuredBasis();
      rec.status = 'supported';
      rec.statusReason = 'Measured on a second dataset that differs along this axis.';
    });
    expect(r.code).toBe(0);
  });

  it('G7 rejects a reach that repeats what was measured', () => {
    const r = check((rec) => {
      rec.dimension.extrapolatedTo = '  8 Points Per Square Metre, One Fixture ';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G7-DIMENSION-DEGENERATE');
  });

  it('G8 rejects a measured reach stated as unbounded', () => {
    const r = check((rec) => {
      rec.basis = measuredBasis();
      rec.status = 'supported';
      rec.statusReason = 'Measured.';
      rec.dimension.extrapolatedTo = 'any point density';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G8-UNBOUNDED-REACH');
  });

  it('G9 rejects a measurement retrieved after the review that read it', () => {
    const r = check((rec) => {
      rec.basis = measuredBasis();
      rec.basis.measurement.retrievedAt = '2026-09-01';
      rec.status = 'supported';
      rec.statusReason = 'Measured.';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G9-DATES');
  });

  it('G9 rejects a review date that is not a real day', () => {
    const r = check((rec) => { rec.reviewedAt = '2026-02-30'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G9-DATES');
  });

  it('G10 rejects a claim nobody registered', () => {
    const r = check((rec) => { rec.claimIds = ['NO-SUCH-CLAIM']; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('G10-CLAIM-UNKNOWN');
  });

  // The check that keeps this verifier from being vacuous.
  it('G11 rejects an empty register', () => {
    const { dir } = makeRegister();
    try {
      const r = verify(dir, null);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('G11-REGISTER-EMPTY');
      expect(r.out).toContain('certifies nothing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G12 rejects a record that will not parse', () => {
    const { dir } = makeRegister();
    try {
      writeFileSync(join(dir, 'records/broken.json'), '{ "schemaVersion": 1, ');
      const r = verify(dir, null);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('G12-REGISTER-UNREADABLE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when the register directory is not there at all', () => {
    const r = run(['--records', join(tmpdir(), 'olv-generalization-absent-register')]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('cannot read its inputs');
  });

  it('G13 rejects the same reach filed twice', () => {
    const { dir, record } = makeRegister();
    try {
      const second = JSON.parse(JSON.stringify(record));
      second.recordId = 'TEST-REACH-002';
      second.status = 'refused';
      second.statusReason = 'The kinder duplicate.';
      writeFileSync(join(dir, 'records/second.json'), `${JSON.stringify(second, null, 2)}\n`);
      const r = verify(dir, record);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('G13-DUPLICATE-RECORD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the vocabulary the schema and the verifier share', () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));

  it('permits no status outside the verifier\'s own vocabulary', () => {
    expect(schema.properties.status.enum).toEqual(GENERALIZATION_STATUSES);
  });

  it('permits no basis outside the verifier\'s own vocabulary', () => {
    expect(schema.$defs.basis.properties.kind.enum).toEqual(BASIS_KINDS);
  });

  it('permits no axis outside the verifier\'s own vocabulary', () => {
    expect(schema.$defs.dimension.properties.axis.enum).toEqual(EXTRAPOLATION_AXES);
  });

  // The partition IS the honesty rule: every basis is either a measurement or
  // it is not, and nothing sits in both halves or in neither.
  it('splits every basis into measured or unsupported, with no overlap', () => {
    const measured = [...MEASURED_BASES];
    const unsupported = [...UNSUPPORTED_BASES];
    expect([...measured, ...unsupported].sort()).toEqual([...BASIS_KINDS].sort());
    expect(measured.filter((k: string) => UNSUPPORTED_BASES.has(k))).toEqual([]);
  });

  it('keeps the statuses that assert something apart from the ones that do not', () => {
    for (const status of ASSERTING_STATUSES) expect(UNCOUNTED_STATUSES.has(status)).toBe(false);
    for (const status of [...ASSERTING_STATUSES, ...UNCOUNTED_STATUSES]) {
      expect(GENERALIZATION_STATUSES).toContain(status);
    }
  });

  // A source kind with no register behind it can never resolve, so G3 would
  // report "no register to look it up in" for a value the schema advertises.
  it('names a register for every source kind the schema permits', () => {
    const kinds: string[] = schema.$defs.source.properties.kind.enum;
    expect(schema.$defs.measurement.properties.sourceKind.enum).toEqual(kinds);
    expect(Object.keys(SOURCE_REGISTRIES).sort()).toEqual([...kinds].sort());
  });
});
