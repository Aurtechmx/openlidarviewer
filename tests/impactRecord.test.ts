/**
 * impactRecord.test.ts — proves the impact verifier REJECTS, and for the stated
 * reason, and proves the summary builder never counts what was not verified.
 *
 * One case per rejection: a record valid in every other respect, one field
 * bent, and an assertion on the rule id. Both scripts run as child processes,
 * so the exit codes asserted here are the ones a release gate would see.
 *
 * The case that matters is I3. An impact claim a reader cannot check spends the
 * credibility the rest of this repository's evidence discipline exists to earn,
 * so a record with no resolvable source may not sit at status "verified".
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { IMPACT_STATUSES, UNCOUNTED_STATUSES, PUBLIC_SOURCE_KINDS } from '../scripts/verify-impact-record.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = join(ROOT, 'scripts/verify-impact-record.mjs');
const BUILDER = join(ROOT, 'scripts/build-impact-summary.mjs');

type Json = Record<string, any>;

function run(script: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
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

/** A verified record with a resolvable DOI. Every negative case bends one field. */
function makeRecord(): Json {
  return {
    schemaVersion: 1,
    recordId: 'TEST-IMPACT-001',
    example: false,
    kind: 'research-output',
    subject: {
      title: 'A paper that used the software',
      description: 'processed a survey with the DTM pipeline and reported the result',
      organisation: 'Unrelated University',
      publishedAt: '2026-04-01',
    },
    source: { kind: 'doi', value: '10.5281/zenodo.0000000', retrievedAt: '2026-05-01' },
    verification: {
      method: 'identifier-resolved',
      verifiedAt: '2026-05-02',
      note: 'the DOI resolved to the paper named above',
    },
    relationToProject: { byProjectMembers: false, selfReported: false },
    status: 'verified',
    statusReason: 'the DOI resolves and the paper describes the use',
  };
}

/** Write records into a temp directory and run `script` over it. */
function withRecords(records: Json[], script = VERIFIER, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'olv-impact-'));
  try {
    mkdirSync(join(dir, 'records'), { recursive: true });
    records.forEach((r, i) => {
      writeFileSync(join(dir, `records/r${i}.json`), `${JSON.stringify(r, null, 2)}\n`);
    });
    const result = run(script, ['--records', join(dir, 'records'), ...extra.map((e) => e.replace('{dir}', dir))]);
    return { ...result, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(bend: (r: Json) => void) {
  const record = makeRecord();
  bend(record);
  return withRecords([record]);
}

describe('verify-impact-record', () => {
  it('accepts the baseline record it was given', () => {
    const r = check(() => {});
    expect(r.out).toContain('verify:impact-record OK');
    expect(r.code).toBe(0);
  });

  it('verifies the committed container, which holds only an example', () => {
    const r = run(VERIFIER, []);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 of them verified and countable');
    expect(readFileSync(join(ROOT, 'validation/impact/README.md'), 'utf8')).toContain(
      'This container is empty',
    );
  });

  it('I1 rejects a record missing a required section', () => {
    const r = check((rec) => { delete rec.verification; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I1-SCHEMA');
  });

  it('I2 rejects an EXAMPLE- id that is not marked example', () => {
    const r = check((rec) => { rec.recordId = 'EXAMPLE-TEST-IMPACT-001'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I2-EXAMPLE');
  });

  it('I2 rejects an example claiming verified impact', () => {
    const r = check((rec) => {
      rec.recordId = 'EXAMPLE-TEST-IMPACT-001';
      rec.example = true;
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('fabricated impact claim');
  });

  // The rule this whole container exists for.
  it('I3 rejects a verified record with no source a reader can resolve', () => {
    const r = check((rec) => {
      rec.source = {
        kind: 'personal-communication',
        value: 'a lab told us at a conference that they use it',
        retrievedAt: '2026-05-01',
      };
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I3-SOURCE-UNVERIFIABLE');
    expect(r.out).toContain('worse than none');
  });

  it('I3 rejects a DOI that is not one', () => {
    const r = check((rec) => { rec.source.value = 'see the university news page'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I3-SOURCE-UNVERIFIABLE');
  });

  it('I3 rejects a URL only this project can reach', () => {
    const r = check((rec) => {
      rec.source = { kind: 'public-url', value: 'https://intranet.example/use', retrievedAt: '2026-05-01', archivedUrl: 'https://web.archive.org/web/2026/https://intranet.example/use' };
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I3-SOURCE-UNVERIFIABLE');
  });

  it('I3 rejects "verified" sitting on a not-verified method', () => {
    const r = check((rec) => { rec.verification.method = 'not-verified'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I3-SOURCE-UNVERIFIABLE');
  });

  it('I4 rejects a verified URL with no independent archive snapshot', () => {
    const r = check((rec) => {
      rec.source = { kind: 'public-url', value: 'https://example.org/news', retrievedAt: '2026-05-01' };
      rec.verification.method = 'page-archived';
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I4-ARCHIVE-REQUIRED');
  });

  it('I5 rejects a source checked before it was fetched', () => {
    const r = check((rec) => { rec.verification.verifiedAt = '2026-04-01'; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I5-DATES');
  });

  it('I6 rejects our own work filed as institutional adoption', () => {
    const r = check((rec) => {
      rec.kind = 'institutional-use';
      rec.relationToProject = { byProjectMembers: true, selfReported: false, note: 'written by a maintainer' };
    });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I6-SELF-REPORTED-AS-ADOPTION');
  });

  it('I7 rejects a claim nobody registered', () => {
    const r = check((rec) => { rec.claimIds = ['NO-SUCH-CLAIM']; });
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I7-CLAIM-UNKNOWN');
  });

  it('I8 rejects the same source counted twice', () => {
    const a = makeRecord();
    const b = makeRecord();
    b.recordId = 'TEST-IMPACT-002';
    const r = withRecords([a, b]);
    expect(r.code).toBe(1);
    expect(rules(r.out)).toContain('I8-DUPLICATE-RECORD');
  });
});

describe('build-impact-summary', () => {
  it('refuses to summarise records that do not verify', () => {
    const record = makeRecord();
    record.source.kind = 'unpublished';
    const r = withRecords([record], BUILDER, ['--out', '{dir}/summary.json']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the records do not verify');
  });

  it('counts an example nowhere, and lists why', () => {
    const example = makeRecord();
    example.recordId = 'EXAMPLE-TEST-IMPACT-001';
    example.example = true;
    example.status = 'pending';
    const real = makeRecord();
    real.source.value = '10.5281/zenodo.0000001';

    const dir = mkdtempSync(join(tmpdir(), 'olv-impact-'));
    try {
      mkdirSync(join(dir, 'records'), { recursive: true });
      writeFileSync(join(dir, 'records/a.json'), JSON.stringify(example));
      writeFileSync(join(dir, 'records/b.json'), JSON.stringify(real));
      const out = join(dir, 'summary.json');
      const r = run(BUILDER, ['--records', join(dir, 'records'), '--out', out]);
      expect(r.code).toBe(0);
      const summary = JSON.parse(readFileSync(out, 'utf8'));
      expect(summary.recordsRead).toBe(2);
      expect(summary.countedRecords).toBe(1);
      expect(summary.excludedFromCounts).toHaveLength(1);
      expect(summary.excludedFromCounts[0].why).toContain('example record');
      expect(summary.uncountedStatuses).toEqual([...UNCOUNTED_STATUSES].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the committed summary current, and at zero', () => {
    const r = run(BUILDER, ['--check']);
    expect(r.code).toBe(0);
    const summary = JSON.parse(readFileSync(join(ROOT, 'validation/impact/summary.json'), 'utf8'));
    expect(summary.countedRecords).toBe(0);
    expect(summary.independence.byOthers).toBe(0);
  });

  it('permits no status outside its own vocabulary', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'validation/impact/impact-record.schema.json'), 'utf8'));
    expect(schema.properties.status.enum).toEqual(IMPACT_STATUSES);
    // Every countable source kind is one the schema actually allows.
    expect(schema.$defs.source.properties.kind.enum).toEqual(
      expect.arrayContaining([...PUBLIC_SOURCE_KINDS]),
    );
  });
});
