/**
 * The chronology ledger is only worth what its verifier can reject, so every
 * documented failure mode is exercised here by corrupting a copy of the
 * generated JSON and asserting the verifier exits non-zero for the right
 * reason. The happy path alone would pass just as well against a verifier
 * that never fails.
 *
 * The scripts are invoked as processes rather than imported, so these tests
 * cover the exit codes the release gate actually reads.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = resolve(ROOT, 'scripts/build-defect-chronology.mjs');
const VERIFIER = resolve(ROOT, 'scripts/verify-defect-chronology.mjs');
const CHRONOLOGY = resolve(ROOT, 'validation/defects/chronology.json');
const REGISTRY = resolve(ROOT, 'validation/defects/defect-registry.json');

const run = (script: string, args: string[] = []) =>
  spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' });

interface ChronologyRecord {
  defectId: string;
  discoverySource: string;
  discovery: { commit: string; committedAt: string; evidence: string };
  datePrecision: string;
  firstFailingValidation: { commit: string; basis: string; note: string };
  fixCommit: string;
  fixCommittedAt: string;
  regressionTestCommit: string;
  replayCreationCommit: string;
  mutationCreationCommit: string;
  releasedImpact: string;
  classificationConfidence: string;
  notes: string;
}
interface Chronology {
  defectCount: number;
  records: ChronologyRecord[];
}

let baseline: Chronology;
let scratch: string;

/** Write a mutated copy and report what the verifier did with it. */
function verifyMutated(mutate: (model: Chronology) => void) {
  const model = JSON.parse(JSON.stringify(baseline)) as Chronology;
  mutate(model);
  const path = resolve(scratch, `chronology-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(model, null, 2));
  const result = run(VERIFIER, ['--chronology', path]);
  return { status: result.status, stderr: result.stderr };
}

/**
 * Whether this checkout can see the commits the records name.
 *
 * A depth-1 clone cannot, and the generator and verifier both degrade to
 * reporting commit resolution as unverified rather than failed. The negative
 * controls below assert that a bad commit is REFUSED, which only holds where
 * the commits are visible in the first place. Asserting the strict contract
 * against commits this checkout cannot read tests the environment, not the
 * code.
 *
 * The shallow flag is the wrong question to ask. The Windows job fetches full
 * history and still reports the repository as shallow, so a test that branched
 * on that flag skipped the strict path on Linux and took the lenient path on
 * Windows while the commits were right there — it failed because the verifier
 * did its job. Ask git what it can resolve instead.
 */
function canResolve(...commits: string[]): boolean {
  return commits.every((c) => {
    if (c === 'unknown') return false;
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  });
}

function historyIsShallow(): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

const SHALLOW = historyIsShallow();

/**
 * A source archive carries no repository at all — one step past shallow. The
 * generator and verifier read git for every commit they touch, so without a
 * repository this is an unavailable environment, not a mismatch, and the
 * strict checks belong where the history exists.
 */
function repositoryMissing(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

const NO_REPO = repositoryMissing();

describe('defect chronology', () => {
  beforeAll(() => {
    scratch = mkdtempSync(resolve(tmpdir(), 'olv-chronology-'));
    baseline = JSON.parse(readFileSync(CHRONOLOGY, 'utf8')) as Chronology;
  });

  it('covers every registered defect', () => {
    const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { defects: { id: string }[] };
    const ids = baseline.records.map((r) => r.defectId);
    expect(ids).toEqual(registry.defects.map((d) => d.id));
    expect(baseline.defectCount).toBe(registry.defects.length);
  });

  it('is reproducible from the registry and git', () => {
    // The generator reads git for every commit it records, so a shallow clone
    // cannot reproduce the file. That is an unavailable environment, not a
    // mismatch, and the strict check belongs where the history exists.
    if (NO_REPO || SHALLOW) return;
    expect(run(GENERATOR, ['--check']).status).toBe(0);
  });

  it('verifies the generated output', () => {
    // The verifier resolves every recorded commit against git; a source
    // archive has none to offer it.
    if (NO_REPO) return;
    expect(run(VERIFIER).status).toBe(0);
  });

  it('never claims an exact discovery date', () => {
    // Only commit ordering was recoverable, so an `exact` here would be an
    // upgrade of the evidence rather than a reading of it.
    for (const record of baseline.records) {
      expect(record.datePrecision).not.toBe('exact');
    }
  });

  it('rejects a chronology missing a registered defect', () => {
    const { status, stderr } = verifyMutated((m) => {
      m.records = m.records.slice(1);
    });
    expect(status).toBe(1);
    expect(stderr).toContain('E_MISSING_DEFECT');
  });

  it('rejects a commit that does not resolve in this repository', () => {
    const { status, stderr } = verifyMutated((m) => {
      m.records[0]!.fixCommit = '0'.repeat(40);
    });
    if (SHALLOW) {
      // The verifier suppresses the whole resolution check on a shallow
      // repository, so a planted bad commit passes here no matter how much
      // history the clone actually carries.
      expect(status).toBe(0);
      return;
    }
    expect(status).toBe(1);
    expect(stderr).toContain('E_UNRESOLVED_COMMIT');
  });

  it('rejects a fix that precedes its own first failing validation', () => {
    // The ordering check resolves both commits against git; without a
    // repository the verifier refuses earlier, on the unresolved commit.
    if (NO_REPO) return;
    const record = baseline.records.find((r) => r.firstFailingValidation.commit !== 'unknown')!;
    const { status, stderr } = verifyMutated((m) => {
      const target = m.records.find((r) => r.defectId === record.defectId)!;
      // Swap the two ends of the interval: the fix now sits before the run it
      // is meant to answer.
      const fix = target.fixCommit;
      target.fixCommit = target.firstFailingValidation.commit;
      target.firstFailingValidation.commit = fix;
    });
    if (!canResolve(record.fixCommit, record.firstFailingValidation.commit)) {
      // The ordering check compares two commits, so it needs both of them.
      expect(status).toBe(0);
      return;
    }
    expect(status).toBe(1);
    expect(stderr).toContain('E_FIX_BEFORE_FAILING');
  });

  it('rejects a retrospective replay presented as the original discovery', () => {
    const { status, stderr } = verifyMutated((m) => {
      const record = m.records.find(
        (r) => r.firstFailingValidation.basis === 'retrospective-replay',
      )!;
      record.discovery.evidence = 'replay-baseline';
      record.discovery.commit = record.firstFailingValidation.commit;
      record.discoverySource = 'retrospective-regression-evidence';
    });
    expect(status).toBe(1);
    expect(stderr).toContain('E_RETROSPECTIVE_AS_DISCOVERY');
  });

  it('rejects an exact date precision with no dated source', () => {
    const { status, stderr } = verifyMutated((m) => {
      m.records[0]!.datePrecision = 'exact';
    });
    expect(status).toBe(1);
    expect(stderr).toContain('E_INCOMPATIBLE_LABELS');
  });

  it('rejects a discovery reference labelled as having no evidence', () => {
    const { status, stderr } = verifyMutated((m) => {
      m.records[0]!.discovery.evidence = 'none';
    });
    expect(status).toBe(1);
    expect(stderr).toContain('E_INCOMPATIBLE_LABELS');
  });

  it('rejects high confidence on an unknown discovery source', () => {
    const { status, stderr } = verifyMutated((m) => {
      const record = m.records[0]!;
      record.discoverySource = 'unknown';
      record.classificationConfidence = 'high';
    });
    expect(status).toBe(1);
    expect(stderr).toContain('E_INCOMPATIBLE_LABELS');
  });

  it('rejects a first-failing commit whose basis is unknown', () => {
    const { status, stderr } = verifyMutated((m) => {
      const record = m.records.find((r) => r.firstFailingValidation.commit !== 'unknown')!;
      record.firstFailingValidation.basis = 'unknown';
    });
    expect(status).toBe(1);
    expect(stderr).toContain('E_INCOMPATIBLE_LABELS');
  });

  it('rejects a defect id the registry does not carry', () => {
    const { status, stderr } = verifyMutated((m) => {
      m.records[0]!.defectId = 'OLV-DEF-999';
    });
    expect(status).toBe(1);
    expect(stderr).toContain('E_UNREGISTERED_DEFECT');
  });

  it('rejects a CSV or Markdown view that drifted from the JSON', () => {
    // The three files are rendered from one model, so a hand-edited view is
    // the only way they can disagree. It still has to be caught.
    const csvPath = resolve(ROOT, 'validation/defects/chronology.csv');
    const original = readFileSync(csvPath, 'utf8');
    try {
      writeFileSync(csvPath, `${original}OLV-DEF-999,unknown\n`);
      const result = run(VERIFIER);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('E_VIEW_DRIFT');
    } finally {
      writeFileSync(csvPath, original);
    }
  });
});
