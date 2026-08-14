/**
 * claimRegisterLint.test.ts — proves the claim-register lint REJECTS, and for
 * the stated reason.
 *
 * The rules under test bind an evidence level to the evidence behind it. That is
 * the kind of rule that is easy to write and easy to write wrongly: a rule that
 * cannot fail looks identical, in a passing CI run, to a rule that works. So
 * every C-rule gets a case here that feeds it input it must reject and asserts
 * the rule id, not merely that something went wrong.
 *
 * The inputs are synthetic on purpose. `collectRegisterProblems` takes the
 * register text, the generated registry text, the gate ids and the studies as
 * arguments, so a case is a function of what it passes and not of whatever the
 * repository happens to contain today. The committed register is checked by the
 * CLI in the release gate; these cases are about the rules themselves.
 */

import { describe, it, expect } from 'vitest';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { collectRegisterProblems, parseRegister, SUPPORTING_STATUSES } from '../scripts/lint-claim-register.mjs';

interface Problem { rule: string; message: string }
interface Study {
  studyId: string;
  claimId: string;
  status: string;
  scope: { supported: { datasetId: string; parameterSetId: string }[]; unsupported: string[] };
}

const AGREEING_STUDY: Study = {
  studyId: 'OLV-XS-001-TEST',
  claimId: 'SLOPE-RASTER',
  status: 'agree',
  scope: {
    supported: [{ datasetId: 'OLV-DS-001-TEST-DEM', parameterSetId: 'PS-HORN-DEG' }],
    unsupported: ['Everything the fixture does not contain.'],
  },
};

/** A register holding exactly the claim blocks given. */
function register(...claims: string[]): string {
  return `schemaVersion: 1\nsoftwareVersion: 0.6.3\n\nclaims:\n${claims.join('\n')}\n`;
}

/** The generated runtime map, in the shape the lint greps for. */
function registry(...ids: string[]): string {
  const body = ids
    .map((id) => `  '${id}': { current: 'E1_UNIT_VERIFIED', required: 'E1_UNIT_VERIFIED', exportAllowed: true },`)
    .join('\n');
  return `export const EVIDENCE_REGISTRY = {\n${body}\n};\n`;
}

/**
 * One claim block. `extra` is appended verbatim inside the claim, so a case can
 * add, drop or bend exactly the field it is about.
 */
function claim(id: string, level: string, extra: string): string {
  // A well-formed E4+ claim carries a measured externalValidationStatus (C5).
  // `extra` is appended AFTER, so a case can override it (the parser keeps the
  // last value) — e.g. the C5 negative control sets `pending`.
  const isE4Plus = /^E[4-6]_/.test(level);
  const lines = [
    `  - claimId: ${id}`,
    `    product: ${id} product`,
    `    algorithm: an algorithm`,
    `    currentEvidence: ${level}`,
    `    requiredEvidence: ${level}`,
    `    exportAllowed: true`,
  ];
  if (isE4Plus) lines.push(`    externalValidationStatus: partial`);
  lines.push(extra);
  return lines.join('\n');
}

const SCOPED = [
  '    scope:',
  '      supported: []',
  '      unsupported:',
  '        - "Everything not measured."',
].join('\n');

function lint(opts: {
  registerText: string;
  ids?: string[];
  studies?: Study[];
  existing?: string[];
}): { problems: Problem[]; ruleIds: string[] } {
  const { problems } = collectRegisterProblems({
    registerText: opts.registerText,
    registryText: registry(...(opts.ids ?? ['SLOPE-RASTER'])),
    gateIds: [],
    studies: opts.studies ?? [],
    recordExists: (p: string) => (opts.existing ?? []).includes(p),
  }) as { problems: Problem[] };
  return { problems, ruleIds: [...new Set(problems.map((p) => p.rule))] };
}

describe('the register parser reads the nested scope block', () => {
  it('reads supported pairs, unsupported lines and the study list', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-001-TEST]',
        '    scope:',
        '      supported:',
        '        - datasetId: OLV-DS-001-TEST-DEM',
        '          parameterSetId: PS-HORN-DEG',
        '      unsupported:',
        '        - "The one-cell border."',
        '        - "Accuracy."',
      ].join('\n')),
    );
    const claims = parseRegister(text) as {
      id: string;
      supportingStudies: string[];
      scope: { supported: { datasetId: string; parameterSetId: string }[]; unsupported: string[] };
    }[];
    expect(claims).toHaveLength(1);
    expect(claims[0].supportingStudies).toEqual(['OLV-XS-001-TEST']);
    expect(claims[0].scope.supported).toEqual([
      { datasetId: 'OLV-DS-001-TEST-DEM', parameterSetId: 'PS-HORN-DEG' },
    ]);
    expect(claims[0].scope.unsupported).toEqual(['The one-cell border.', 'Accuracy.']);
  });
});

describe('the claim-register lint accepts a register whose claims are backed', () => {
  it('an E4 claim citing an agreeing study, scoped no wider than that study', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-001-TEST]',
        '    scope:',
        '      supported:',
        '        - datasetId: OLV-DS-001-TEST-DEM',
        '          parameterSetId: PS-HORN-DEG',
        '      unsupported:',
        '        - "Accuracy."',
      ].join('\n')),
    );
    expect(lint({ registerText: text, studies: [AGREEING_STUDY] }).problems).toEqual([]);
  });

  it('a claim below E4 with an empty supported scope', () => {
    const text = register(claim('SLOPE-RASTER', 'E2_ANALYTICALLY_VERIFIED', SCOPED));
    expect(lint({ registerText: text }).problems).toEqual([]);
  });
});

describe('the claim-register lint rejects', () => {
  it('C1. a claim with no scope block', () => {
    const text = register(claim('SLOPE-RASTER', 'E1_UNIT_VERIFIED', '    units: [metres]'));
    const r = lint({ registerText: text });
    expect(r.ruleIds).toEqual(['C1-SCOPE-MISSING']);
    expect(r.problems[0].message).toContain('no scope block');
  });

  it('C1. a scope that states no boundary', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E1_UNIT_VERIFIED', [
        '    scope:',
        '      supported: []',
        '      unsupported: []',
      ].join('\n')),
    );
    const r = lint({ registerText: text });
    expect(r.ruleIds).toEqual(['C1-SCOPE-MISSING']);
    expect(r.problems[0].message).toContain('scope.unsupported is empty');
  });

  it('C2. an E4 claim that names no study', () => {
    const text = register(claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', SCOPED));
    const r = lint({ registerText: text });
    expect(r.ruleIds).toEqual(['C2-E4-STUDY']);
    expect(r.problems[0].message).toContain('names no supportingStudies');
  });

  it('C2. an E4 claim citing a study that was registered but never run', () => {
    // The case the rule exists for. The study is real, the manifest verifies,
    // its tolerance is frozen — and it has measured nothing.
    const text = register(
      claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-001-TEST]',
        SCOPED,
      ].join('\n')),
    );
    const r = lint({
      registerText: text,
      studies: [{ ...AGREEING_STUDY, status: 'pending', scope: { supported: [], unsupported: ['x'] } }],
    });
    expect(r.ruleIds).toEqual(['C2-E4-STUDY']);
    expect(r.problems[0].message).toContain('whose status is "pending"');
    expect(r.problems[0].message).toContain('measured nothing');
  });

  it('C2. an E4 claim citing a study that measured a disagreement', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-001-TEST]',
        SCOPED,
      ].join('\n')),
    );
    const r = lint({
      registerText: text,
      studies: [{ ...AGREEING_STUDY, status: 'disagree', scope: { supported: [], unsupported: ['x'] } }],
    });
    expect(r.ruleIds).toEqual(['C2-E4-STUDY']);
    expect(r.problems[0].message).toContain('a disagreement is not support');
    expect([...SUPPORTING_STATUSES]).toEqual(['agree', 'partial']);
  });

  it('C2. a claim citing a study id that does not exist', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-404-MISSING]',
        SCOPED,
      ].join('\n')),
    );
    const r = lint({ registerText: text, studies: [AGREEING_STUDY] });
    expect(r.ruleIds).toEqual(['C2-E4-STUDY']);
    expect(r.problems[0].message).toContain('is not a manifest in');
  });

  it('C2. a claim citing a study that was run for a different claim', () => {
    const text = register(
      claim('HILLSHADE', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-001-TEST]',
        SCOPED,
      ].join('\n')),
    );
    const r = lint({ registerText: text, ids: ['HILLSHADE'], studies: [AGREEING_STUDY] });
    expect(r.ruleIds).toEqual(['C2-E4-STUDY']);
    expect(r.problems[0].message).toContain('is a comparison for SLOPE-RASTER');
  });

  it('C5. an E4 claim whose externalValidationStatus is still pending (the CONTOURS drift)', () => {
    // The study agrees (C2 passes), but the claim's own status field still reads
    // pending — the exact contradiction that shipped: E4 currentEvidence with a
    // pending status. C5 refuses it.
    const text = register(
      claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-001-TEST]',
        '    externalValidationStatus: pending', // overrides the helper's `partial`
        SCOPED,
      ].join('\n')),
    );
    const r = lint({ registerText: text, studies: [AGREEING_STUDY] });
    expect(r.ruleIds).toEqual(['C5-E4-STATUS']);
    expect(r.problems[0].message).toContain('pending');
  });

  it('C3. an E5 claim with no external record', () => {
    // E5 needs ground truth from outside this repository. Asserting the level
    // without naming the record is the failure this rule exists to make loud.
    const text = register(claim('SLOPE-RASTER', 'E5_EXTERNALLY_VALIDATED', SCOPED));
    const r = lint({ registerText: text });
    expect(r.ruleIds).toEqual(['C3-EXTERNAL-RECORD']);
    expect(r.problems[0].message).toContain('names no externalValidationRecords');
    expect(r.problems[0].message).toContain('validation/field/');
  });

  it('C3. an E6 claim naming a record that is not on disk', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E6_INDEPENDENTLY_REPRODUCED', [
        '    externalValidationRecords: [validation/reproduction/run-001.json]',
        SCOPED,
      ].join('\n')),
    );
    const r = lint({ registerText: text });
    expect(r.ruleIds).toEqual(['C3-EXTERNAL-RECORD']);
    expect(r.problems[0].message).toContain('does not exist');
  });

  it('C3. an E5 claim pointing at a record generated inside this tree', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E5_EXTERNALLY_VALIDATED', [
        '    externalValidationRecords: [validation/cross-implementation/summary.json]',
        SCOPED,
      ].join('\n')),
    );
    const r = lint({ registerText: text, existing: ['validation/cross-implementation/summary.json'] });
    expect(r.ruleIds).toEqual(['C3-EXTERNAL-RECORD']);
    expect(r.problems[0].message).toContain('is not under validation/field/');
  });

  it('C3. passes once the record it names exists', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E6_INDEPENDENTLY_REPRODUCED', [
        '    externalValidationRecords: [validation/reproduction/run-001.json]',
        SCOPED,
      ].join('\n')),
    );
    expect(lint({ registerText: text, existing: ['validation/reproduction/run-001.json'] }).problems).toEqual([]);
  });

  it('C4. a claim approving a dataset its study never compared', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E4_CROSS_IMPLEMENTATION_VALIDATED', [
        '    supportingStudies: [OLV-XS-001-TEST]',
        '    scope:',
        '      supported:',
        '        - datasetId: OLV-DS-001-TEST-DEM',
        '          parameterSetId: PS-HORN-DEG',
        '        - datasetId: OLV-DS-999-FIELD-SITE',
        '          parameterSetId: PS-HORN-DEG',
        '      unsupported:',
        '        - "Accuracy."',
      ].join('\n')),
    );
    const r = lint({ registerText: text, studies: [AGREEING_STUDY] });
    expect(r.ruleIds).toEqual(['C4-SCOPE-EXCEEDS-STUDY']);
    expect(r.problems[0].message).toContain('OLV-DS-999-FIELD-SITE');
    expect(r.problems[0].message).toContain('may not approve more than the studies behind it measured');
  });

  it('C4. a claim with a supported scope and no study at all', () => {
    const text = register(
      claim('SLOPE-RASTER', 'E3_SYNTHETICALLY_VALIDATED', [
        '    scope:',
        '      supported:',
        '        - datasetId: OLV-DS-001-TEST-DEM',
        '          parameterSetId: PS-HORN-DEG',
        '      unsupported:',
        '        - "Accuracy."',
      ].join('\n')),
    );
    const r = lint({ registerText: text });
    expect(r.ruleIds).toEqual(['C4-SCOPE-EXCEEDS-STUDY']);
    expect(r.problems[0].message).toContain('cites no study that verifies');
  });
});

describe('the checks that were already here still fail', () => {
  it('a claim missing from the generated registry', () => {
    const text = register(claim('SLOPE-RASTER', 'E1_UNIT_VERIFIED', SCOPED));
    const r = lint({ registerText: text, ids: ['HILLSHADE'] });
    expect(r.ruleIds.sort()).toEqual(['REGISTRY-DRIFT']);
  });

  it('an invalid evidence level', () => {
    const text = register(claim('SLOPE-RASTER', 'E9_WISHFUL', SCOPED));
    const r = lint({ registerText: text });
    expect(r.ruleIds).toContain('INVALID-LEVEL');
  });

  it('survey-grade wording in a descriptor', () => {
    const text = register(
      [
        '  - claimId: SLOPE-RASTER',
        '    product: Survey-grade slope raster',
        '    algorithm: an algorithm',
        '    currentEvidence: E1_UNIT_VERIFIED',
        '    requiredEvidence: E1_UNIT_VERIFIED',
        '    exportAllowed: true',
        SCOPED,
      ].join('\n'),
    );
    const r = lint({ registerText: text });
    expect(r.ruleIds).toEqual(['BANNED-WORDING']);
  });

  it('an exporter gating on an unregistered claim', () => {
    const { problems } = collectRegisterProblems({
      registerText: register(claim('SLOPE-RASTER', 'E1_UNIT_VERIFIED', SCOPED)),
      registryText: registry('SLOPE-RASTER'),
      gateIds: [{ file: 'src/export/thing.ts', id: 'NOT-A-CLAIM' }],
      studies: [],
      recordExists: () => false,
    }) as { problems: Problem[] };
    expect(problems.map((p) => p.rule)).toEqual(['UNREGISTERED-GATE']);
  });
});
