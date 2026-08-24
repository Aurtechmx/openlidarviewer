/**
 * crossImplementationManifest.test.ts — proves the study verifier REJECTS, and
 * for the stated reason.
 *
 * A verifier nobody has watched fail is a decoration. Each rejection below gets
 * its own case: a manifest that is valid in every other respect, one field bent,
 * and an assertion on the rule id the verifier reports. Asserting the id (not
 * merely a non-zero exit) is what stops a case from passing because a different
 * rule happened to fire on a fixture that drifted.
 *
 * The verifier runs as a child process so the exit code the release gate would
 * see is the exit code this suite observes.
 *
 * EVERY CASE NAMES ITS OWN DATASET REGISTER, via --dataset-register: either a
 * temp file it wrote, or a path that deliberately does not exist. R2 has two
 * behaviours, shape-only and membership, and which one applies used to depend on
 * whether the repository happened to contain a register. That made the mode
 * ambient: these cases were written under shape-only and silently changed
 * meaning when the register landed. Naming the register keeps each case a
 * function of its arguments, and lets both modes be covered on purpose.
 */
// lint-dataset-citations: synthetic-ids — the ids below are fixtures, not records.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept on one line: @ts-expect-error applies to the line that follows it.
// @ts-expect-error — plain .mjs script, no types
import { protocolDigestOf, protocolRecordDigestOf, STUDY_STATUSES, readDatasetIds, DATASET_REGISTER_PATH } from '../scripts/verify-cross-implementation-study.mjs';
import { REFERENCE_SLOTS, allReferencesPending } from '../src/validation/crossCheck';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = join(ROOT, 'scripts/verify-cross-implementation-study.mjs');
const BUILDER = join(ROOT, 'scripts/build-cross-implementation-summary.mjs');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

type Json = Record<string, unknown>;

/** Run a script and report the literal exit code plus its combined output. */
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

/** The rule ids the verifier reported, deduplicated, in first-seen order. */
function rules(out: string): string[] {
  const found: string[] = [];
  for (const m of out.matchAll(/•\s*\[([A-Z0-9-]+)\]/g)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * A path under `dir` that is never created: the "no register supplied" mode,
 * stated rather than inherited from whatever the tree holds.
 */
function absentRegister(dir: string): string {
  return join(dir, 'no-dataset-register.yaml');
}

/**
 * A minimal register listing exactly `ids`. The verifier reads this file
 * line-wise, so the two keys it looks for are all it needs.
 */
function writeRegister(dir: string, ids: string[]): string {
  const path = join(dir, 'dataset-register.yaml');
  writeFileSync(path, `schemaVersion: 1\ndatasets:\n${ids.map((id) => `  - datasetId: ${id}\n`).join('')}`);
  return path;
}

/**
 * A study directory that verifies: real artifact files on disk, digests that
 * match them, a status the numbers support, and a scope no broader than what is
 * listed. Every negative case starts here and bends one thing.
 */
function makeStudy(): { dir: string; manifest: Json } {
  const dir = mkdtempSync(join(tmpdir(), 'olv-xstudy-'));
  mkdirSync(join(dir, 'raw'), { recursive: true });
  mkdirSync(join(dir, 'derived'), { recursive: true });
  mkdirSync(join(dir, 'protocols'), { recursive: true });

  // The frozen protocol the manifest below runs under. It lives in its own file
  // because that is the point of R11: the manifest has to agree with a record a
  // result cannot reach back and edit.
  const protocol: Json = {
    schemaVersion: 1,
    protocolId: 'TEST-PROTO-001',
    example: false,
    title: 'Test protocol for the study verifier fixture.',
    question: 'Does the candidate agree with the reference on the test grid?',
    recordWrittenOn: '2026-07-10',
    referenceTool: 'GDAL',
    referenceVersion: '3.13.1',
    claims: [
      {
        claimId: 'SLOPE-RASTER',
        datasetIds: ['TEST-DEM-A'],
        parameterSetIds: ['PS-A'],
        metrics: {
          toleranceAbs: 0.5,
          toleranceUnit: 'degree',
          minimumComparableCells: 4,
          requiredWithinToleranceFraction: 1,
        },
        toleranceDerivation: 'Fixed before the fixture was compared, so the gate cannot follow the result.',
        freeze: {
          status: 'preregistered',
          on: '2026-07-01',
          witnessCommit: 'abc1234',
          witness: 'A test commit that carries the tolerance with the slot pending.',
          resultLandedOn: '2026-07-08',
          resultCommit: 'def5678',
        },
      },
    ],
    decisionRule: 'Agreement only when the cell count and the within-tolerance fraction both reach the gate above.',
    digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  protocol.digest = protocolRecordDigestOf(protocol);
  writeFileSync(join(dir, 'protocols/TEST-PROTO-001.protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`);

  const candidateBytes = 'ncols 2\nnrows 1\n1.0 2.0\n';
  const referenceBytes = 'ncols 2\nnrows 1\n1.0 2.0\n';
  writeFileSync(join(dir, 'raw/candidate-slope.asc'), candidateBytes);
  writeFileSync(join(dir, 'raw/reference-slope.asc'), referenceBytes);

  const rawArtifacts = [
    { path: 'raw/candidate-slope.asc', sha256: sha256(candidateBytes), role: 'candidate-output' },
    { path: 'raw/reference-slope.asc', sha256: sha256(referenceBytes), role: 'reference-output' },
  ];

  // The derived summary carries the digest of the {path, sha256} pairs it came
  // from, computed here the same way the verifier recomputes it from disk.
  const pairs = [...rawArtifacts]
    .map((a) => ({ path: a.path, sha256: a.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const canonical = `[${pairs
    .map((p) => `{"path":${JSON.stringify(p.path)},"sha256":${JSON.stringify(p.sha256)}}`)
    .join(',')}]`;
  const inputsDigest = `sha256:${sha256(canonical)}`;

  const derivedBytes = JSON.stringify({ comparableCells: 10, withinToleranceFraction: 1 });
  writeFileSync(join(dir, 'derived/comparison.json'), derivedBytes);

  const manifest: Json = {
    schemaVersion: 1,
    studyId: 'TEST-STUDY-001',
    claimId: 'SLOPE-RASTER',
    example: false,
    protocolRef: { protocolId: 'TEST-PROTO-001', digest: protocol.digest },
    protocolDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    candidate: {
      revision: '1c5733c9ce79eb7ae023cde762e6124ee11ec895',
      version: '0.6.3',
      algorithmVersion: 'v0.4.x',
    },
    reference: {
      tool: 'GDAL',
      version: '3.13.1',
      containerDigest: null,
      containerPinning: 'not-executed',
      containerPinningNote: 'No container runtime on this host; pinned by path, version and command instead.',
      executablePath: '/usr/local/bin/gdal',
      commandLine: 'gdal raster slope in.asc out.asc --gradient-alg Horn --unit degree',
      platform: 'test',
    },
    datasets: [{ datasetId: 'TEST-DEM-A', description: 'A two-cell test grid.' }],
    parameterSets: [
      {
        id: 'PS-A',
        description: 'Horn, degrees, no edges.',
        candidateParameters: { gradientAlgorithm: 'Horn' },
        referenceParameters: { gradientAlg: 'Horn' },
      },
    ],
    metrics: {
      toleranceAbs: 0.5,
      toleranceUnit: 'degree',
      minimumComparableCells: 4,
      requiredWithinToleranceFraction: 1,
    },
    status: 'agree',
    statusReason: 'Every comparable cell is inside the preregistered tolerance.',
    result: { comparableCells: 10, withinToleranceFraction: 1, maxAbsDiff: 0.01, rmse: 0.001 },
    rawArtifacts,
    derivedArtifacts: [
      {
        path: 'derived/comparison.json',
        sha256: sha256(derivedBytes),
        derivedFrom: rawArtifacts.map((a) => a.path),
        inputsDigest,
      },
    ],
    scope: {
      supported: [{ datasetId: 'TEST-DEM-A', parameterSetId: 'PS-A' }],
      unsupported: ['Says nothing about the point-cloud-to-DTM pipeline.'],
    },
  };
  manifest.protocolDigest = protocolDigestOf(manifest);
  return { dir, manifest };
}

/**
 * Write the manifest and verify it, reporting the literal exit code. The dataset
 * register defaults to one that does not exist, so a case says nothing about
 * membership unless it supplies a register itself.
 */
function verify(
  dir: string,
  manifest: Json,
  datasetRegister: string = absentRegister(dir),
): { code: number; out: string } {
  writeFileSync(join(dir, 'study.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return run(VERIFIER, [
    '--studies', dir,
    '--protocols', join(dir, 'protocols'),
    '--artifact-root', dir,
    '--dataset-register', datasetRegister,
  ]);
}

/** Re-freeze the protocol digest, for cases that legitimately change metrics. */
function refreeze(manifest: Json): Json {
  manifest.protocolDigest = protocolDigestOf(manifest);
  return manifest;
}

describe('the study verifier accepts a record that holds together', () => {
  it('verifies the base fixture with no register supplied, exit 0', () => {
    const { dir, manifest } = makeStudy();
    try {
      const r = verify(dir, manifest);
      expect(r.out).toContain('verify:cross-implementation-study OK');
      expect(r.out).toContain('dataset id shape only');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies the base fixture against a register that lists its dataset, exit 0', () => {
    const { dir, manifest } = makeStudy();
    try {
      const r = verify(dir, manifest, writeRegister(dir, ['TEST-DEM-A']));
      expect(r.out).toContain('membership enforced');
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies the committed example manifest, exit 0', () => {
    // Shape-only on purpose. What this case is for is that the committed record
    // is internally consistent: digests, status, scope and dataset-id shape.
    // Membership of the committed manifests against the committed register is a
    // different question, and the answer is whatever the default CLI run in the
    // release gate reports; asserting it from here would put this suite's result
    // back at the mercy of the tree.
    const studies = join(ROOT, 'validation/cross-implementation/studies');
    const r = run(VERIFIER, [
      '--studies', studies,
      '--dataset-register', join(ROOT, 'no-such-dataset-register.yaml'),
    ]);
    expect(r.out).toContain('verify:cross-implementation-study OK');
    expect(r.code).toBe(0);
    const example = JSON.parse(
      readFileSync(
        join(ROOT, 'validation/cross-implementation/studies/EXAMPLE-slope-raster-gdal-horn.study.json'),
        'utf8',
      ),
    ) as { example: boolean; status: string; studyId: string; result?: unknown };
    // A committed example must stay unmistakably an example, and must never
    // acquire a result: the tree's own record would otherwise read as evidence.
    expect(example.example).toBe(true);
    expect(example.studyId.startsWith('EXAMPLE-')).toBe(true);
    expect(example.status).toBe('pending');
    expect(example.result).toBeUndefined();
  });
});

describe('the study verifier rejects', () => {
  const bend = (
    mutate: (m: Json) => void,
    expected: string,
    register?: (dir: string) => string,
  ): { code: number; out: string; ruleIds: string[] } => {
    const { dir, manifest } = makeStudy();
    try {
      mutate(manifest);
      const r = verify(dir, manifest, register ? register(dir) : undefined);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain(expected);
      return { ...r, ruleIds: rules(r.out) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('1. a claimId that is not in the claim register', () => {
    const r = bend((m) => {
      m.claimId = 'SLOPE-RASTER-V2';
      refreeze(m);
    }, 'R1-CLAIM-UNKNOWN');
    expect(r.out).toContain('docs/validation/claim-register.yaml');
    // R11 fires alongside it, and should: a claim the register does not know is
    // also a claim the frozen protocol does not govern. Both are the same defect
    // seen from two records, and neither should be silent about it.
    expect(r.ruleIds).toEqual(['R1-CLAIM-UNKNOWN', 'R11-PROTOCOL-REF']);
  });

  it('2. a datasetId that is free text, with no register supplied', () => {
    const r = bend((m) => {
      m.datasets = [{ datasetId: 'the frozen analytic DEM we used', description: 'prose, not an id' }];
      (m.scope as { supported: unknown[] }).supported = [];
      m.status = 'inconclusive';
      m.statusReason = 'Kept off the agreement path so only the dataset rule fires.';
      delete m.result;
      m.derivedArtifacts = [];
      refreeze(m);
    }, 'R2-DATASET-ID');
    expect(r.out).toContain('free text');
    // R11 fires too: a dataset swapped for prose is also a dataset the protocol
    // never admitted, and a dataset added after the freeze is a different study.
    expect(r.ruleIds).toEqual(['R2-DATASET-ID', 'R11-PROTOCOL-REF']);
  });

  it('2b. a well-shaped datasetId the supplied register does not list', () => {
    // The half of R2 the shape check cannot reach: TEST-DEM-A is a perfectly
    // formed id, and the register below lists a different dataset.
    const r = bend(
      (m) => {
        (m.scope as { supported: unknown[] }).supported = [];
        m.status = 'inconclusive';
        m.statusReason = 'Kept off the agreement path so only the dataset rule fires.';
        delete m.result;
        m.derivedArtifacts = [];
        refreeze(m);
      },
      'R2-DATASET-ID',
      (dir) => writeRegister(dir, ['TEST-DEM-B']),
    );
    expect(r.out).toContain('"TEST-DEM-A" is not in');
    expect(r.out).toContain('dataset-register.yaml');
    expect(r.ruleIds).toEqual(['R2-DATASET-ID']);
  });

  it('3. a tolerance changed after the result was recorded', () => {
    // The protocol digest is NOT refrozen here: that is the whole point.
    const r = bend((m) => {
      (m.metrics as { toleranceAbs: number }).toleranceAbs = 5;
    }, 'R3-PROTOCOL-DIGEST');
    expect(r.out).toContain('frozen protocolDigest');
    // Two records catch it independently now: the manifest's own digest (R3) and
    // the protocol file the manifest cites (R11). That is the point of keeping
    // the protocol outside the manifest — restamping one no longer suffices.
    expect(r.ruleIds).toEqual(['R3-PROTOCOL-DIGEST', 'R11-PROTOCOL-REF']);
  });

  it('4. our own output used as its own reference', () => {
    const r = bend((m) => {
      const ref = m.reference as Json;
      ref.tool = 'OpenLiDARViewer';
      ref.executablePath = '/usr/local/bin/openlidarviewer-cli';
      ref.commandLine = 'npm run terrain:slope -- in.asc out.asc';
    }, 'R4-REFERENCE-IS-CANDIDATE');
    expect(r.out).toContain('measures nothing');
    expect(r.ruleIds).toEqual(['R4-REFERENCE-IS-CANDIDATE']);
  });

  it('5. missing rawArtifacts under a status that asserts a measurement', () => {
    const r = bend((m) => {
      m.rawArtifacts = [];
      m.derivedArtifacts = [];
    }, 'R5-RAW-MISSING');
    expect(r.out).toContain('rawArtifacts may not be empty');
    expect(r.ruleIds).toEqual(['R5-RAW-MISSING']);
  });

  it('6. a derived summary that cannot be re-derived from the raw artifacts', () => {
    const r = bend((m) => {
      // The derived file is edited on disk is caught by R9; this is the subtler
      // case: the raw side moved, so the recorded input digest no longer
      // describes the records the summary claims to come from.
      const raw = m.rawArtifacts as { path: string; sha256: string }[];
      raw.splice(1, 1);
      (m.derivedArtifacts as { derivedFrom: string[] }[])[0].derivedFrom = ['raw/candidate-slope.asc'];
      m.status = 'insufficient';
      m.statusReason = 'Kept off the agreement path so only the derivation rule fires.';
      m.result = { comparableCells: 2, withinToleranceFraction: 1, maxAbsDiff: 0.01 };
      (m.scope as { supported: unknown[] }).supported = [];
    }, 'R6-DERIVED-NOT-REDERIVABLE');
    expect(r.out).toContain('cannot be re-derived');
    expect(r.ruleIds).toEqual(['R6-DERIVED-NOT-REDERIVABLE']);
  });

  it('7. a pending study carrying numbers that could reach a summary count', () => {
    const r = bend((m) => {
      m.status = 'pending';
      m.statusReason = 'Registered, not run.';
      (m.scope as { supported: unknown[] }).supported = [];
    }, 'R7-UNCOUNTED-CARRIES-RESULT');
    expect(r.out).toContain('excludes this study from every count');
    expect(r.ruleIds).toEqual(['R7-UNCOUNTED-CARRIES-RESULT']);
  });

  it('8. an approved scope broader than the datasets and parameter sets listed', () => {
    const r = bend((m) => {
      (m.scope as { supported: Json[] }).supported = [
        { datasetId: 'TEST-DEM-A', parameterSetId: 'PS-A' },
        { datasetId: 'TEST-DEM-B', parameterSetId: 'PS-B' },
      ];
    }, 'R8-SCOPE-BROADER');
    expect(r.out).toContain('may not exceed the datasets actually compared');
    expect(r.out).toContain('may not exceed the parameter sets actually compared');
    expect(r.ruleIds).toEqual(['R8-SCOPE-BROADER']);
  });

  it('9. a raw artifact whose recorded sha256 disagrees with the file on disk', () => {
    const { dir, manifest } = makeStudy();
    try {
      // Isolated from the derived artifact on purpose. Editing a raw file also
      // breaks the derived record's input digest (R6), which is correct and is
      // covered above; dropping the derived entry here proves R9 fires on its
      // own, from the bytes alone.
      manifest.derivedArtifacts = [];
      // The bytes change, the record does not: the case a refreshed checksum
      // beside an edited file is meant to hide.
      writeFileSync(join(dir, 'raw/reference-slope.asc'), 'ncols 2\nnrows 1\n1.0 9.0\n');
      const r = verify(dir, manifest);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toEqual(['R9-ARTIFACT-DIGEST']);
      expect(r.out).toContain('hashes to');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('10. an unpinned reference: no container digest and no path, version and command', () => {
    const r = bend((m) => {
      const ref = m.reference as Json;
      ref.containerDigest = null;
      ref.executablePath = null;
      ref.commandLine = null;
    }, 'R10-REFERENCE-UNPINNED');
    expect(r.out).toContain('no containerDigest');
    expect(r.ruleIds).toEqual(['R10-REFERENCE-UNPINNED']);
  });

  it('10b. a floating tag, or a bare tool name, is not a pin', () => {
    const tag = bend((m) => {
      (m.reference as Json).containerDigest = 'ghcr.io/osgeo/gdal:latest';
    }, 'R10-REFERENCE-UNPINNED');
    expect(tag.out).toContain('is not a sha256 digest');

    const bare = bend((m) => {
      const ref = m.reference as Json;
      ref.executablePath = 'gdal';
      ref.version = 'latest';
    }, 'R10-REFERENCE-UNPINNED');
    expect(bare.out).toContain('a bare tool name');
    expect(bare.out).toContain('not a floating tag');
  });

  it('11. a protocol edited after a study cited it', () => {
    // The rule the protocol directory exists for. The manifest is untouched and
    // internally consistent; the tolerance moved in the protocol file, which is
    // exactly the edit a disappointing result invites.
    const { dir, manifest } = makeStudy();
    try {
      const path = join(dir, 'protocols/TEST-PROTO-001.protocol.json');
      const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
        claims: { metrics: { toleranceAbs: number } }[];
        digest: string;
      };
      protocol.claims[0].metrics.toleranceAbs = 5;
      // Restamped, so the protocol is self-consistent: only the manifest that
      // already cited the old one can notice.
      protocol.digest = protocolRecordDigestOf(protocol) as string;
      writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`);

      const r = verify(dir, manifest);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toEqual(['R11-PROTOCOL-REF']);
      expect(r.out).toContain('does not match protocol');
      expect(r.out).toContain('the protocol changed under a study that had already cited it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11b. a protocol whose own digest no longer describes it', () => {
    const { dir, manifest } = makeStudy();
    try {
      const path = join(dir, 'protocols/TEST-PROTO-001.protocol.json');
      const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
        claims: { metrics: { toleranceAbs: number } }[];
      };
      protocol.claims[0].metrics.toleranceAbs = 5;
      writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`);

      const r = verify(dir, manifest);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toEqual(['P2-PROTOCOL-DIGEST', 'R11-PROTOCOL-REF']);
      expect(r.out).toContain('digest does not describe this file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11c. a protocolRef pointing at a protocol nobody wrote', () => {
    const r = bend((m) => {
      m.protocolRef = { protocolId: 'TEST-PROTO-404', digest: `sha256:${'b'.repeat(64)}` };
    }, 'R11-PROTOCOL-REF');
    expect(r.out).toContain('is not a record under');
    expect(r.ruleIds).toEqual(['R11-PROTOCOL-REF']);
  });

  it('11d. a freeze called preregistered that did not precede its result', () => {
    // The rule a reviewer had to apply by hand. The first version of the
    // committed protocol claimed one frozen date for three claims, and for
    // ASPECT-RASTER no commit showed the tolerance before the result: the slot,
    // the tolerance and the numbers arrived together. A record that says
    // "preregistered" while its own dates say otherwise must fail here.
    const { dir, manifest } = makeStudy();
    try {
      const path = join(dir, 'protocols/TEST-PROTO-001.protocol.json');
      const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
        claims: { freeze: { on: string; resultLandedOn: string } }[];
        digest: string;
      };
      // The tolerance was fixed the day the result landed, and the record still
      // calls it preregistered.
      protocol.claims[0].freeze.on = protocol.claims[0].freeze.resultLandedOn;
      protocol.digest = protocolRecordDigestOf(protocol) as string;
      writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`);

      const r = verify(dir, manifest);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('P9-FREEZE-PROVENANCE');
      expect(r.out).toContain('does not precede the result date');
      expect(r.out).toContain('it is still not a preregistration');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11e. a freeze whose result date is missing, under a measured outcome', () => {
    // Without the result date the freeze claim cannot be falsified from the
    // records, so omitting it would be the way around 11d.
    const { dir, manifest } = makeStudy();
    try {
      const path = join(dir, 'protocols/TEST-PROTO-001.protocol.json');
      const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
        claims: { freeze: Record<string, unknown> }[];
        digest: string;
      };
      delete protocol.claims[0].freeze.resultLandedOn;
      delete protocol.claims[0].freeze.resultCommit;
      protocol.digest = protocolRecordDigestOf(protocol) as string;
      writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`);

      const r = verify(dir, manifest);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('R11-PROTOCOL-REF');
      expect(r.out).toContain('records no resultLandedOn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11f. accepts an honest adopted-with-result freeze', () => {
    // The aspect case. Not a preregistration, said so, and therefore fine.
    const { dir, manifest } = makeStudy();
    try {
      const path = join(dir, 'protocols/TEST-PROTO-001.protocol.json');
      const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
        claims: { freeze: { status: string; on: string; resultLandedOn: string } }[];
        digest: string;
      };
      protocol.claims[0].freeze.status = 'adopted-with-result';
      protocol.claims[0].freeze.on = protocol.claims[0].freeze.resultLandedOn;
      protocol.digest = protocolRecordDigestOf(protocol) as string;
      writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`);
      manifest.protocolRef = { protocolId: 'TEST-PROTO-001', digest: protocol.digest };

      const r = verify(dir, manifest);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11g. an adopted-with-result freeze that understates a real preregistration', () => {
    const { dir, manifest } = makeStudy();
    try {
      const path = join(dir, 'protocols/TEST-PROTO-001.protocol.json');
      const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
        claims: { freeze: { status: string } }[];
        digest: string;
      };
      protocol.claims[0].freeze.status = 'adopted-with-result';
      protocol.digest = protocolRecordDigestOf(protocol) as string;
      writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`);
      manifest.protocolRef = { protocolId: 'TEST-PROTO-001', digest: protocol.digest };

      const r = verify(dir, manifest);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('P9-FREEZE-PROVENANCE');
      expect(r.out).toContain('stronger than the record admits');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11h. a freeze date that does not belong to its witness commit', () => {
    // P9 compares a record against itself, so a back-dated freeze satisfies it.
    // That is the shape the original defect took, and this is what closes the
    // easy version: the date must belong to the commit offered as the witness.
    //
    // The rule needs the real commit's authored date from git. A source
    // archive carries no history — unavailable environment, not a mismatch.
    try {
      execFileSync('git', ['cat-file', '-e', 'a78b0f9^{commit}'], { stdio: 'ignore' });
    } catch {
      return;
    }
    const { dir, manifest } = makeStudy();
    try {
      const path = join(dir, 'protocols/TEST-PROTO-001.protocol.json');
      const protocol = JSON.parse(readFileSync(path, 'utf8')) as {
        claims: { freeze: { on: string; witnessCommit: string } }[];
        digest: string;
      };
      // A real commit in this repository, dated 2026-07-05, offered as the
      // witness for a freeze claimed four days earlier.
      protocol.claims[0].freeze.witnessCommit = 'a78b0f9';
      protocol.claims[0].freeze.on = '2026-07-01';
      protocol.digest = protocolRecordDigestOf(protocol) as string;
      writeFileSync(path, `${JSON.stringify(protocol, null, 2)}\n`);
      manifest.protocolRef = { protocolId: 'TEST-PROTO-001', digest: protocol.digest };

      const r = verify(dir, manifest);
      expect(r.code).toBe(1);
      expect(rules(r.out)).toContain('P10-WITNESS-DATE');
      expect(r.out).toContain('is not evidence of anything');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11i. P10 stays silent when the commit cannot be resolved', () => {
    // An extracted archive has no history. The check degrades to a no-op there
    // rather than failing records it cannot read, and the base fixture (whose
    // witness is a made-up hash) is the case that proves it.
    const { dir, manifest } = makeStudy();
    try {
      const r = verify(dir, manifest);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('P10-WITNESS-DATE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('12. a measured outcome with no protocol behind it', () => {
    const r = bend((m) => {
      delete m.protocolRef;
    }, 'R12-PROTOCOL-MISSING');
    expect(r.out).toContain('protocolRef is required');
    expect(r.ruleIds).toEqual(['R12-PROTOCOL-MISSING']);
  });

  it('accepts a container digest as the stronger pin', () => {
    const { dir, manifest } = makeStudy();
    try {
      const ref = manifest.reference as Json;
      ref.containerDigest = `sha256:${'a'.repeat(64)}`;
      ref.containerPinning = 'pinned';
      const r = verify(dir, manifest);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R2 has two modes and reports which one it applied', () => {
  const source = readFileSync(VERIFIER, 'utf8');

  it('defaults to the repository register without reading it as ambient state', () => {
    expect(source).toContain('validation/datasets/dataset-register.yaml');
    // The default lives in a parameter, so a caller can name another register.
    expect(source).toMatch(/readDatasetIds\([^)]*registerPath\s*=\s*DATASET_REGISTER_PATH\)/);
  });

  it('carries an id-shape pattern and enforces it', () => {
    expect(source).toContain('DATASET_ID_PATTERN');
    expect(source).toMatch(/DATASET_ID_PATTERN\s*=\s*\//);
    expect(source).toContain('DATASET_ID_PATTERN.test');
  });

  it('reads the register a caller names, and the default one otherwise', () => {
    // Directly on the exported function, with no tree involved: the path it
    // consults is an argument, and null is how it says "shape only".
    const asked: string[] = [];
    const read = (path: string): string | null => {
      asked.push(path);
      return path === 'given/register.yaml' ? 'datasets:\n  - datasetId: OLV-DS-999-GIVEN\n' : null;
    };

    expect(readDatasetIds(read, 'given/register.yaml')).toEqual(new Set(['OLV-DS-999-GIVEN']));
    expect(readDatasetIds(read, 'other/register.yaml')).toBeNull();
    readDatasetIds(read);

    expect(asked).toEqual(['given/register.yaml', 'other/register.yaml', DATASET_REGISTER_PATH]);
    expect(DATASET_REGISTER_PATH).toBe('validation/datasets/dataset-register.yaml');
  });

  it('reports that membership is unenforced when the named register is not there', () => {
    const { dir, manifest } = makeStudy();
    try {
      // An explicitly absent path, not the repository's state. This case is
      // about the unenforced mode, and it has to keep testing that whether or
      // not a register is committed to the tree.
      const r = verify(dir, manifest, absentRegister(dir));
      expect(r.code).toBe(0);
      expect(r.out).toContain('dataset id shape only');
      expect(r.out).not.toContain('membership enforced');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports membership enforced when a register is supplied', () => {
    const { dir, manifest } = makeStudy();
    try {
      const register = writeRegister(dir, ['TEST-DEM-A']);
      const r = verify(dir, manifest, register);
      expect(r.code).toBe(0);
      expect(r.out).toContain('membership enforced');
      expect(r.out).toContain(register);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the summary counts only what was measured', () => {
  it('excludes a pending study from every count', () => {
    const { dir, manifest } = makeStudy();
    try {
      manifest.status = 'pending';
      manifest.statusReason = 'Registered, not run.';
      delete manifest.result;
      manifest.derivedArtifacts = [];
      (manifest.scope as { supported: unknown[] }).supported = [];
      writeFileSync(join(dir, 'study.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      const out = join(dir, 'summary.json');
      const r = run(BUILDER, [
        '--studies', dir, '--protocols', join(dir, 'protocols'), '--artifact-root', dir, '--out', out,
        '--dataset-register', absentRegister(dir),
      ]);
      expect(r.code).toBe(0);

      const summary = JSON.parse(readFileSync(out, 'utf8')) as {
        studiesRead: number;
        countedStudies: number;
        byStatus: Record<string, number>;
        byClaim: Record<string, unknown>;
        agreement: { denominator: number; fraction: number | null };
        excludedFromCounts: { studyId: string; status: string }[];
      };
      expect(summary.studiesRead).toBe(1);
      expect(summary.countedStudies).toBe(0);
      expect(summary.byStatus).toEqual({});
      expect(summary.byClaim).toEqual({});
      expect(summary.agreement.denominator).toBe(0);
      expect(summary.agreement.fraction).toBeNull();
      expect(summary.excludedFromCounts.map((e) => e.status)).toEqual(['pending']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a study that produced a result', () => {
    const { dir, manifest } = makeStudy();
    try {
      writeFileSync(join(dir, 'study.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const out = join(dir, 'summary.json');
      const built = run(BUILDER, [
        '--studies', dir, '--protocols', join(dir, 'protocols'), '--artifact-root', dir, '--out', out,
        '--dataset-register', absentRegister(dir),
      ]);
      expect(built.code).toBe(0);
      const summary = JSON.parse(readFileSync(out, 'utf8')) as {
        countedStudies: number;
        byStatus: Record<string, number>;
        agreement: { denominator: number; agree: number; fraction: number };
      };
      expect(summary.countedStudies).toBe(1);
      expect(summary.byStatus).toEqual({ agree: 1 });
      expect(summary.agreement).toMatchObject({ denominator: 1, agree: 1, fraction: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to summarise a manifest that does not verify', () => {
    const { dir, manifest } = makeStudy();
    try {
      manifest.claimId = 'SLOPE-RASTER-V2';
      writeFileSync(join(dir, 'study.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const r = run(BUILDER, [
        '--studies', dir, '--protocols', join(dir, 'protocols'), '--artifact-root', dir, '--out', join(dir, 'summary.json'),
        '--dataset-register', absentRegister(dir),
      ]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('the manifests do not verify');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the committed summary current', () => {
    // No summary number depends on the dataset register, so the staleness check
    // is run in shape-only mode: it is about the arithmetic in summary.json
    // matching the committed manifests, not about register membership.
    const r = run(BUILDER, [
      '--check',
      '--dataset-register', join(ROOT, 'no-such-dataset-register.yaml'),
    ]);
    expect(r.out).toContain('is current');
    expect(r.code).toBe(0);
  });
});

describe('the status vocabulary', () => {
  it('permits the ten statuses, including blocked-external', () => {
    expect(STUDY_STATUSES).toEqual([
      'pending',
      'not-executed',
      'unavailable',
      'blocked-external',
      'insufficient',
      'agree',
      'partial',
      'disagree',
      'invalid',
      'inconclusive',
    ]);
  });

  it('keeps blocked-external distinct from unavailable in the schema', () => {
    const schema = JSON.parse(
      readFileSync(join(ROOT, 'validation/cross-implementation/manifest.schema.json'), 'utf8'),
    ) as { properties: { status: { enum: string[] } } };
    expect(schema.properties.status.enum).toEqual(STUDY_STATUSES);
  });

  it('accepts blocked-external for work no repository can close', () => {
    const { dir, manifest } = makeStudy();
    try {
      manifest.status = 'blocked-external';
      manifest.statusReason = 'Needs a survey crew on the site; not obtainable from inside a repository.';
      delete manifest.result;
      manifest.derivedArtifacts = [];
      (manifest.scope as { supported: unknown[] }).supported = [];
      const r = verify(dir, manifest);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('REFERENCE_SLOTS stays the compact runtime summary', () => {
  it('still lists every claim slot, with twelve references supplied', () => {
    expect(REFERENCE_SLOTS.map((s) => s.claimId)).toEqual([
      'DTM',
      'DSM',
      'CHM',
      'SLOPE-RASTER',
      'ASPECT-RASTER',
      'HILLSHADE',
      'CONTOURS',
      'GROUND-FILTER',
      'MEAS-AREA',
      'TPI',
      'VRM',
      'MEAS-PROFILE',
      'E57-INGEST',
      // The two change slots carry a committed GRASS reference and still read
      // `pending`: the comparison ran and agreed, but promoting a claim needs a
      // study manifest whose protocol was frozen in an earlier commit.
      'CHANGE-RASTER',
      'CHANGE-VOLUME',
    ]);
    const supplied = REFERENCE_SLOTS.filter((s) => s.status === 'supplied').map((s) => s.claimId);
    expect(supplied).toEqual(['DTM', 'DSM', 'CHM', 'SLOPE-RASTER', 'ASPECT-RASTER', 'HILLSHADE', 'CONTOURS', 'MEAS-AREA', 'TPI', 'VRM', 'MEAS-PROFILE', 'E57-INGEST']);
  });

  it('allReferencesPending keeps its behaviour', () => {
    expect(allReferencesPending()).toBe(false);
    expect(allReferencesPending(REFERENCE_SLOTS)).toBe(false);
    expect(allReferencesPending(REFERENCE_SLOTS.filter((s) => s.status === 'pending'))).toBe(true);
    expect(allReferencesPending([])).toBe(true);
  });

  it('every slot claim id is registered, so the two records agree', () => {
    const register = readFileSync(join(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
    const registered = new Set(
      [...register.matchAll(/^\s*-?\s*claimId:\s*(\S+)/gm)].map((m) => m[1]),
    );
    for (const slot of REFERENCE_SLOTS) expect(registered.has(slot.claimId)).toBe(true);
  });
});
