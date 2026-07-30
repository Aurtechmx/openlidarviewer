/**
 * reproductionRecord.test.ts — proves the reproduction verifier REJECTS, and
 * for the stated reason.
 *
 * One case per rejection: a record valid in every other respect, one field
 * bent, and an assertion on the rule id. The verifier runs as a child process,
 * so the exit code a release gate would see is the one asserted here.
 *
 * The case that matters is P4. E6_INDEPENDENTLY_REPRODUCED is the one level in
 * src/validation/evidenceLevel.ts this project cannot award itself, and the four
 * P4 cases below are the four ways a record tries to.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { isValidOrcid, REPRODUCTION_STATUSES, EVIDENCE_LEVEL } from '../scripts/verify-reproduction-record.mjs';
import { EVIDENCE_LEVELS } from '../src/validation/evidenceLevel';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = join(ROOT, 'scripts/verify-reproduction-record.mjs');

type Json = Record<string, any>;

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

function rules(out: string): string[] {
  const found: string[] = [];
  for (const m of out.matchAll(/•\s*\[([A-Z0-9-]+)\]/g)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * A record that verifies: an unaffiliated reproducer with a well-formed ORCID,
 * a pinned artifact, a public deposit for the raw output, and a status whose
 * numbers exist. Every negative case starts here and bends one thing.
 */
function makeRecord(): Json {
  return {
    schemaVersion: 1,
    recordId: 'TEST-REPRO-001',
    example: false,
    evidenceLevelClaimed: 'E6_INDEPENDENTLY_REPRODUCED',
    claimIds: ['DTM'],
    reproducer: {
      name: 'Test Reproducer',
      identifier: { scheme: 'ORCID', value: 'https://orcid.org/0000-0002-1825-0097' },
      affiliation: { organisation: 'Unrelated University', country: 'Testland' },
    },
    independence: {
      affiliatedWithProject: false,
      fundedByProject: false,
      contributedCode: false,
      statement: 'No employment, funding or code contribution.',
    },
    artifactUnderTest: {
      version: '0.6.3',
      revision: 'a'.repeat(40),
      sourceArchiveSha256: 'b'.repeat(64),
      downloadUrl: 'https://example.org/openlidarviewer-0.6.3.tar.gz',
    },
    executed: {
      commands: ['npm ci', 'npm run test:unit'],
      inputs: [],
      startedAt: '2026-05-04',
      completedAt: '2026-05-05',
    },
    environment: { os: 'Testux 1.0', cpu: 'Test CPU', runtime: 'node 24' },
    status: 'reproduced',
    statusReason: 'ran the published procedure and matched the published figures',
    outcome: {
      comparedAgainst: 'the figures in the release manifest',
      agreementSummary: 'identical to the published digests',
      deviations: [],
    },
    rawOutput: {
      locationKind: 'doi',
      location: '10.5281/zenodo.0000000',
      sha256: 'c'.repeat(64),
      retrievedAt: '2026-05-06',
      publishedBy: 'reproducer',
    },
    scope: {
      reproduced: [{ claimId: 'DTM', statement: 'the pipeline produced the published digest' }],
      notReproduced: ['every claim not named above'],
    },
  };
}

/** Write `record` into a temp directory and verify it there. */
function check(bend: (r: Json) => void): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'olv-repro-'));
  try {
    mkdirSync(join(dir, 'records'), { recursive: true });
    const record = makeRecord();
    bend(record);
    writeFileSync(join(dir, 'records/record.json'), `${JSON.stringify(record, null, 2)}\n`);
    return run(['--records', join(dir, 'records')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('verify-reproduction-record', () => {
  it('accepts the baseline record it was given', () => {
    const r = check(() => {});
    expect(r.out).toContain('verify:reproduction-record OK');
    expect(r.code).toBe(0);
  });

  it('verifies the committed container, which holds only an example', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Independent reproductions on file: 0');
    expect(readFileSync(join(ROOT, 'validation/reproduction/README.md'), 'utf8')).toContain(
      'This container is empty',
    );
  });

  it('P1 rejects a record missing a required section', () => {
    const r = check((rec) => { delete rec.independence; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P1-SCHEMA');
  });

  it('P2 rejects an EXAMPLE- id that is not marked example', () => {
    const r = check((rec) => { rec.recordId = 'EXAMPLE-TEST-REPRO-001'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P2-EXAMPLE');
  });

  it('P2 rejects an example that reports an outcome', () => {
    const r = check((rec) => {
      rec.recordId = 'EXAMPLE-TEST-REPRO-001';
      rec.example = true;
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('fabricated reproduction');
  });

  it('P3 rejects a claim nobody registered', () => {
    const r = check((rec) => { rec.claimIds = ['NO-SUCH-CLAIM']; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P3-CLAIM-UNKNOWN');
  });

  // The four ways a reproduction stops being one.
  it('P4 rejects a reproducer affiliated with this project', () => {
    const r = check((rec) => { rec.independence.affiliatedWithProject = true; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P4-NOT-INDEPENDENT');
    expect(r.out).toContain('is not an independent reproduction');
  });

  it('P4 rejects a reproduction this project funded', () => {
    const r = check((rec) => { rec.independence.fundedByProject = true; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P4-NOT-INDEPENDENT');
  });

  it('P4 rejects a reproducer whose organisation is this project', () => {
    const r = check((rec) => { rec.reproducer.affiliation.organisation = 'OpenLiDARViewer'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P4-NOT-INDEPENDENT');
  });

  it('P4 rejects raw output published only by this project', () => {
    const r = check((rec) => { rec.rawOutput.publishedBy = 'this-project'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P4-NOT-INDEPENDENT');
  });

  it('P5 rejects an ORCID that fails its check digit', () => {
    const r = check((rec) => { rec.reproducer.identifier.value = 'https://orcid.org/0000-0002-1825-0098'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P5-IDENTIFIER');
  });

  it('P6 rejects an artifact nobody else can fetch', () => {
    const r = check((rec) => { rec.artifactUnderTest.downloadUrl = 'http://localhost:8080/build.tar.gz'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P6-ARTIFACT-UNPINNED');
  });

  it('P6 rejects a placeholder revision on a non-example record', () => {
    const r = check((rec) => { rec.artifactUnderTest.revision = '0'.repeat(40); });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P6-ARTIFACT-UNPINNED');
  });

  it('P7 rejects a run that finished before it started', () => {
    const r = check((rec) => { rec.executed.completedAt = '2026-05-01'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P7-DATES');
  });

  it('P8 rejects a reported outcome whose raw output is nowhere', () => {
    const r = check((rec) => {
      rec.rawOutput.locationKind = 'none';
      delete rec.rawOutput.sha256;
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P8-RAW-OUTPUT-MISSING');
    expect(r.out).toContain('rumour about a result');
  });

  it('P8 rejects a DOI that is not one', () => {
    const r = check((rec) => { rec.rawOutput.location = 'on file with the author'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P8-RAW-OUTPUT-MISSING');
  });

  it('P9 rejects a pending record that carries an outcome', () => {
    const r = check((rec) => {
      rec.status = 'pending';
      rec.statusReason = 'agreed to try';
      rec.scope.reproduced = [];
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P9-UNCOUNTED-CARRIES-OUTCOME');
  });

  it('P10 rejects a reproduced claim the record does not list', () => {
    const r = check((rec) => {
      rec.scope.reproduced = [{ claimId: 'CONTOURS', statement: 'also fine' }];
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P10-SCOPE-BROADER');
  });

  it('P10 rejects "reproduced" sitting next to a list of deviations', () => {
    const r = check((rec) => { rec.outcome.deviations = ['contour spacing differed in two tiles']; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('P10-SCOPE-BROADER');
  });

  it('P11 rejects the same recordId filed twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-repro-'));
    try {
      mkdirSync(join(dir, 'records'), { recursive: true });
      const a = makeRecord();
      const b = makeRecord();
      writeFileSync(join(dir, 'records/a.json'), JSON.stringify(a));
      writeFileSync(join(dir, 'records/b.json'), JSON.stringify(b));
      const r = run(['--records', join(dir, 'records')]);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('P11-DUPLICATE-RECORD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the reproduction container agrees with the evidence ladder', () => {
  it('holds the top rung and only the top rung', () => {
    expect(EVIDENCE_LEVEL).toBe('E6_INDEPENDENTLY_REPRODUCED');
    expect(EVIDENCE_LEVELS[EVIDENCE_LEVELS.length - 1]).toBe(EVIDENCE_LEVEL);
  });

  it('permits no status outside its own vocabulary', () => {
    const schema = JSON.parse(
      readFileSync(join(ROOT, 'validation/reproduction/reproduction-record.schema.json'), 'utf8'),
    );
    expect(schema.properties.status.enum).toEqual(REPRODUCTION_STATUSES);
  });

  it('checks an ORCID check digit rather than its shape alone', () => {
    expect(isValidOrcid('https://orcid.org/0000-0002-1825-0097')).toBe(true);
    expect(isValidOrcid('https://orcid.org/0000-0002-1825-0096')).toBe(false);
    expect(isValidOrcid('0000-0002-1825-0097')).toBe(false);
  });
});
