/**
 * releaseAssetVerifier.test.ts — the staged release is checked as a SET.
 *
 * Every other gate checks one link. These tests cover the failures where each
 * individual file is valid and the SET is not: two source zips from different
 * cuts, a manifest naming a different commit than the evidence, a deploy
 * archive wrapped in dist/, an asset left behind by the previous packaging run.
 * Those survive typecheck, tests, lints, and packaging.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// The same resolver the scripts use, so 'is zip installed' is answered one way.
import { binaryOnPath } from '../scripts/lib/binaryOnPath.mjs';
// @ts-expect-error — plain .mjs script, no types
import { verifyStagedRelease } from '../scripts/verify-release-assets.mjs';

const VERSION = '0.6.0-alpha.3';
const TAG = `v${VERSION}`;
const COMMIT = 'c'.repeat(40);
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

let dir: string;

/** Build a zip from a { path: contents } map, rooted at the zip root. */
/**
 * These suites build real archives with the `zip` command, because what they
 * verify is the bytes a release actually ships, not a library's idea of them.
 *
 * GitHub's Windows runners carry no `zip`, so every case here died with ENOENT
 * and the new Windows leg was red from its first run. A permanently failing
 * advisory check is one people stop reading, which costs more than the coverage
 * it pretends to give.
 *
 * So the suites skip when the tool is absent, naming it. They are NOT skipped by
 * platform: a Windows machine with `zip` on PATH runs them, and a Linux machine
 * without it does not pretend to. The release gate itself runs on Linux where
 * `zip` is present, so nothing that ships is unverified. The Windows leg simply
 * does not cover release-asset verification, and that boundary is stated in the
 * developer manual rather than implied by a green tick.
 */
const HAS_ZIP = binaryOnPath('zip') !== null;
const describeZip = describe.skipIf(!HAS_ZIP);

function makeZip(zipPath: string, files: Record<string, string>) {
  const staging = mkdtempSync(join(tmpdir(), 'zipsrc-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(staging, rel);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync('zip', ['-rqX', zipPath, '.'], { cwd: staging });
  rmSync(staging, { recursive: true, force: true });
}

const SOURCE_FILES: Record<string, string> = {
  'package.json': '{}',
  'package-lock.json': '{}',
  'sbom.json': '{}',
  'CITATION.cff': 'cff',
  'docs/project/DEPENDENCIES.md': 'deps',
  'docs/project/THIRD_PARTY_NOTICES.md': 'notices',
  'docs/validation/claim-register.yaml': 'claims',
  'docs/release/RELEASE_ASSETS.md': 'asset guide',
  'tests/fixtures/reference/slope/SHA256SUMS': 'sums',
  [`docs/releases/RELEASE_NOTES_v${VERSION}.md`]: 'notes',
  [`docs/releases/KNOWN_LIMITATIONS_v${VERSION}.md`]: 'limits',
  [`docs/releases/VALIDATION_REPORT_v${VERSION}.md`]: 'validation',
  [`docs/releases/REPRODUCIBILITY_v${VERSION}.md`]: 'repro',
};

const ALL_STAGES = [
  'staticGate', 'e2e', 'docsBuild', 'productionAudit',
  'fixtureChecksums', 'coverage',
] as const;
/** The steady state: every mandatory stage ran here, mutation was cited. */
const passedStages = () => ({
  ...Object.fromEntries(ALL_STAGES.map((s) => [s, 'passed'])),
  mutation: 'not-executed',
});
const citedMutation = (over: Record<string, unknown> = {}) => ({
  score: 87.23,
  break: 75,
  measuredAtCommit: COMMIT,
  measuredAt: '2026-07-20T04:00:00.000Z',
  coversReleaseCommit: true,
  workflowRunUrl: 'https://github.com/o/r/actions/runs/123',
  ...over,
});

const DEPLOY_FILES: Record<string, string> = {
  'index.html': '<!doctype html>',
  '.htaccess': 'headers',
  _headers: 'headers',
  'assets/app.js': 'code',
};

function evidenceRecord(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    version: VERSION,
    tag: TAG,
    commit: COMMIT,
    releaseAuthoritative: true,
    gateExit: 0,
    nodeVersion: 'v22.11.0',
    npmVersion: '10.9.2',
    total: { passed: 5797, skipped: 16 },
    bundle: { liveEntryKiB: 713, ceilingKiB: 720 },
    science: { e4ClaimCount: 2, e4Claims: [...EXPECTED_E4], suppliedReferenceSlots: 2 },
    stages: passedStages(),
    mutation: citedMutation(),
    gateLogSha256: '',
    ...over,
  };
}

/** Stage a complete, self-consistent release. Mutators run before hashing. */
function stageRelease(opts: {
  evidence?: Record<string, unknown>;
  manifest?: (m: Record<string, any>) => void;
  extraFiles?: Record<string, string>;
  deployFiles?: Record<string, string>;
  sourceFiles?: Record<string, string>;
} = {}) {
  const srcZip = join(dir, `openlidarviewer-v${VERSION}-source-20260722-1346.zip`);
  const depZip = join(dir, `openlidarviewer-v${VERSION}-deploy-20260722-1346-root.zip`);
  makeZip(srcZip, opts.sourceFiles ?? SOURCE_FILES);
  makeZip(depZip, opts.deployFiles ?? DEPLOY_FILES);

  writeFileSync(join(dir, 'sbom.json'), JSON.stringify({ metadata: { component: { version: VERSION } } }));
  writeFileSync(join(dir, 'gate.log'), 'GATE EXIT: 0\n');
  const gateSha = sha(join(dir, 'gate.log'));
  writeFileSync(join(dir, 'gate.log.sha256'), `${gateSha}  gate.log\n`);
  writeFileSync(join(dir, `RELEASE_NOTES_v${VERSION}.md`), '# notes');

  const ev = { ...evidenceRecord(opts.evidence), gateLogSha256: gateSha };
  const evName = `test-evidence-v${VERSION}.json`;
  writeFileSync(join(dir, evName), JSON.stringify(ev));

  for (const [n, b] of Object.entries(opts.extraFiles ?? {})) writeFileSync(join(dir, n), b);

  const payload = {
    sourceZip: srcZip, deployZip: depZip,
    sbom: join(dir, 'sbom.json'), evidence: join(dir, evName),
    gateLog: join(dir, 'gate.log'), gateLogSha256: join(dir, 'gate.log.sha256'),
    releaseNotes: join(dir, `RELEASE_NOTES_v${VERSION}.md`),
  };
  const artifacts = Object.fromEntries(
    Object.entries(payload).map(([k, p]) => [
      k,
      { file: p.split('/').pop(), sizeBytes: readFileSync(p).length, sha256: sha(p) },
    ]),
  );
  const manifest: Record<string, any> = {
    schemaVersion: 1, project: 'openlidarviewer', version: VERSION, tag: TAG,
    gitCommit: COMMIT, bundle: { liveEntryKiB: 713, ceilingKiB: 720 }, artifacts,
  };
  opts.manifest?.(manifest);
  const manName = `release-manifest-v${VERSION}.json`;
  writeFileSync(join(dir, manName), JSON.stringify(manifest));

  const sums = [...Object.values(payload).map((p) => `${sha(p)}  ${p.split('/').pop()}`),
    `${sha(join(dir, manName))}  ${manName}`].join('\n');
  writeFileSync(join(dir, 'SHA256SUMS'), `${sums}\n`);
}

/**
 * The E4 set is passed in rather than read from the real claim register, so
 * these cases stay hermetic: promoting a product must not turn every
 * release-asset test red, and a test that reads the register would agree with
 * the verifier for the trivial reason that both read the same file.
 */
const EXPECTED_E4 = ['SLOPE-RASTER', 'ASPECT-RASTER'];

const verify = () =>
  verifyStagedRelease(dir, { version: VERSION, expectedE4Claims: EXPECTED_E4 }) as {
    ok: boolean;
    problems: string[];
    advisories: string[];
  };
const failsWith = (needle: string) => {
  const r = verify();
  expect(r.ok).toBe(false);
  expect(r.problems.some((p) => p.toLowerCase().includes(needle.toLowerCase()))).toBe(true);
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'olv-stage-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describeZip('release:verify — the happy path', () => {
  it('accepts a complete, self-consistent asset set', () => {
    stageRelease();
    const r = verify();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describeZip('release:verify — completeness', () => {
  it('rejects a missing gate log', () => {
    stageRelease();
    rmSync(join(dir, 'gate.log'));
    failsWith('gateLog');
  });

  it('rejects a second source zip from another cut', () => {
    stageRelease();
    writeFileSync(join(dir, `openlidarviewer-v${VERSION}-source-20260101-0000.zip`), 'x');
    failsWith('exactly one sourceZip');
  });

  it('rejects an asset left over from a previous release', () => {
    stageRelease({ extraFiles: { 'openlidarviewer-v0.5.9-source-20260101-0000.zip': 'old' } });
    failsWith('another release');
  });
});

describeZip('release:verify — provenance', () => {
  it('rejects a manifest whose commit differs from the evidence', () => {
    stageRelease({ manifest: (m) => { m.gitCommit = 'd'.repeat(40); } });
    failsWith('!= evidence commit');
  });

  it('rejects a manifest commit that is not the tag target', () => {
    stageRelease();
    const r = verifyStagedRelease(dir, { version: VERSION, tagCommit: 'e'.repeat(40) }) as {
      ok: boolean; problems: string[];
    };
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('not the tag target'))).toBe(true);
  });

  it('rejects evidence that is not release-authoritative', () => {
    stageRelease({ evidence: { releaseAuthoritative: false } });
    failsWith('not release-authoritative');
  });

  it('rejects evidence produced on the wrong Node major', () => {
    stageRelease({ evidence: { nodeVersion: 'v26.0.0' } });
    failsWith('Node major');
  });

  it('rejects a mismatched tag', () => {
    stageRelease({ evidence: { tag: 'v0.5.9' } });
    failsWith('evidence tag');
  });

  it('rejects a staged SBOM naming another version', () => {
    stageRelease();
    writeFileSync(join(dir, 'sbom.json'), JSON.stringify({ metadata: { component: { version: '0.6.0-alpha.2' } } }));
    failsWith('SBOM root version');
  });
});

describeZip('release:verify — versioned evidence documents in the source zip', () => {
  for (const doc of [
    `docs/releases/RELEASE_NOTES_v${VERSION}.md`,
    `docs/releases/KNOWN_LIMITATIONS_v${VERSION}.md`,
    `docs/releases/VALIDATION_REPORT_v${VERSION}.md`,
    `docs/releases/REPRODUCIBILITY_v${VERSION}.md`,
  ]) {
    it(`rejects a source zip missing ${doc}`, () => {
      const files = { ...SOURCE_FILES };
      delete files[doc];
      stageRelease({ sourceFiles: files });
      failsWith(doc);
    });
  }
});

describeZip('release:verify — mandatory stage record', () => {
  it('rejects evidence with no stage record at all', () => {
    stageRelease({ evidence: { stages: null } });
    failsWith('mandatory stage');
  });

  it('rejects evidence whose stage record omits a mandatory stage', () => {
    const s = passedStages();
    delete (s as Record<string, string>).coverage;
    stageRelease({ evidence: { stages: s } });
    failsWith('coverage');
  });

  it('rejects evidence that omits the deferred mutation stage entirely', () => {
    const s = passedStages();
    delete (s as Record<string, string>).mutation;
    stageRelease({ evidence: { stages: s } });
    failsWith('omits deferred stage');
  });

  it('rejects a stage state outside the vocabulary', () => {
    stageRelease({ evidence: { stages: { ...passedStages(), mutation: 'skipped' } } });
    failsWith('not a stage state');
  });

  it('accepts mutation as not-executed when a passing result is cited', () => {
    stageRelease();
    expect(verify().ok).toBe(true);
  });

  it('rejects not-executed mutation with nothing cited', () => {
    stageRelease({ evidence: { mutation: null } });
    failsWith('cites no measured result');
  });

  it('rejects a cited mutation score under the break threshold', () => {
    stageRelease({ evidence: { mutation: citedMutation({ score: 70 }) } });
    failsWith('below the break threshold');
  });

  it('advises, without failing, when the cited score predates the release commit', () => {
    stageRelease({
      evidence: {
        mutation: citedMutation({ coversReleaseCommit: false, measuredAtCommit: 'f'.repeat(40) }),
      },
    });
    const r = verify();
    expect(r.ok).toBe(true);
    expect(r.advisories.some((a: string) => a.includes('not at the release commit'))).toBe(true);
  });

  it('rejects evidence recording a mandatory stage as failed', () => {
    stageRelease({ evidence: { stages: { ...passedStages(), coverage: 'failed' } } });
    failsWith('coverage');
  });
});

describeZip('release:verify — scientific scope', () => {
  it('rejects an E4 claim count that disagrees with the register', () => {
    stageRelease({
      evidence: { science: { e4ClaimCount: 3, e4Claims: [...EXPECTED_E4, 'DTM'] } },
    });
    failsWith('E4 claim(s) per the claim register');
  });

  it('rejects a different E4 claim identity', () => {
    stageRelease({ evidence: { science: { e4ClaimCount: 2, e4Claims: ['SLOPE-RASTER', 'DTM'] } } });
    failsWith('expected [SLOPE-RASTER, ASPECT-RASTER]');
  });
});

describeZip('release:verify — integrity', () => {
  it('rejects a manifest hash that does not match the file', () => {
    stageRelease({ manifest: (m) => { m.artifacts.sbom.sha256 = 'f'.repeat(64); } });
    failsWith('sha256 mismatch');
  });

  it('rejects a manifest size that does not match the file', () => {
    stageRelease({ manifest: (m) => { m.artifacts.sbom.sizeBytes = 999999; } });
    failsWith('size');
  });

  it('rejects a gate log that does not match its recorded hash', () => {
    stageRelease();
    writeFileSync(join(dir, 'gate.log'), 'GATE EXIT: 0\ntampered\n');
    failsWith('gate.log');
  });

  it('rejects a SHA256SUMS mismatch', () => {
    stageRelease();
    writeFileSync(join(dir, `RELEASE_NOTES_v${VERSION}.md`), '# tampered notes');
    failsWith('mismatch');
  });

  it('rejects a bundle over its ceiling', () => {
    stageRelease({
      evidence: { bundle: { liveEntryKiB: 999, ceilingKiB: 720 } },
      manifest: (m) => { m.bundle = { liveEntryKiB: 999, ceilingKiB: 720 }; },
    });
    failsWith('exceeds');
  });
});

describeZip('release:verify — archive contents', () => {
  it('rejects a source zip containing node_modules', () => {
    stageRelease({ sourceFiles: { ...SOURCE_FILES, 'node_modules/three/index.js': 'x' } });
    failsWith('forbidden path');
  });

  it('rejects a source zip containing internal readiness material', () => {
    stageRelease({ sourceFiles: { ...SOURCE_FILES, [`READINESS_REPORT_v${VERSION}.md`]: 'internal' } });
    failsWith('forbidden path');
  });

  it('rejects a source zip missing the frozen fixture checksums', () => {
    const missing = { ...SOURCE_FILES };
    delete missing['tests/fixtures/reference/slope/SHA256SUMS'];
    stageRelease({ sourceFiles: missing });
    failsWith('SHA256SUMS');
  });

  it('rejects generated release/ output at the archive root, but keeps docs/release/', () => {
    // The rule must reject the packaging OUTPUT tree without also rejecting
    // documentation that merely lives in a directory of the same name.
    stageRelease({ sourceFiles: { ...SOURCE_FILES, 'release/SHA256SUMS': 'generated' } });
    failsWith('forbidden path');
  });

  it('rejects a deploy zip wrapped in dist/', () => {
    stageRelease({
      deployFiles: {
        'dist/index.html': 'x', 'dist/.htaccess': 'x', 'dist/_headers': 'x', 'dist/assets/a.js': 'x',
      },
    });
    failsWith('dist/');
  });

  it('rejects a deploy zip missing its root contract', () => {
    stageRelease({ deployFiles: { 'index.html': 'x', 'assets/a.js': 'x' } });
    failsWith('_headers');
  });

  it('rejects a corrupt archive', () => {
    stageRelease();
    writeFileSync(join(dir, `openlidarviewer-v${VERSION}-source-20260722-1346.zip`), 'not a zip');
    failsWith('source zip');
  });
});
