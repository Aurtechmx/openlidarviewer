/**
 * portability.test.ts — the comparator, and the tamper classes it must refuse.
 *
 * WHY THE TAMPER TESTS REGENERATE THE MANIFEST. A check that only recomputes
 * SHA-256 catches a careless edit and nothing else: anyone editing a published
 * result to make it say something it did not say would refresh the digests, and
 * the tree would then be perfectly self-consistent about the wrong thing. So
 * every tamper below edits a leg, writes a fresh manifest over the edited
 * bytes, and the check still has to fail — because the comparator re-derives
 * its verdict from the records rather than trusting the document beside them.
 * This is the arrangement `benchmark:verify` already uses, applied to the
 * cross-platform tree.
 *
 * These run in the unit bucket. Nothing here measures anything: the records are
 * synthetic, so the whole file is milliseconds.
 */
import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capturedEnv } from '../../benchmarks/framework';
import { nodeSha256Hex } from '../../benchmarks/framework/node';
import { scienceScopedArtifacts, ARTIFACT_SCOPE, PIPELINE_ARTIFACTS } from '../../benchmarks/pipeline/runPipeline';
import { REPRODUCIBILITY_CONFIG } from '../../benchmarks/runner/config';
import {
  BUILD_SCOPED_ARTIFACTS,
  REQUIRED_SCIENCE_ARTIFACTS,
  comparePlatforms,
} from '../../benchmarks/portability/compare';
import { comparisonCsv, comparisonMarkdown } from '../../benchmarks/portability/render';
import { PORTABILITY_SCHEMA_VERSION, type PlatformRecord } from '../../benchmarks/portability/record';
import { detectEndianness, platformId } from '../../benchmarks/portability/preconditions';
import { witnessSuite } from './reachability';

witnessSuite('platform-portability');
import {
  PLATFORM_RECORD_FILE,
  readPlatformLeg,
  verifyPortabilityDir,
  writeComparison,
  type PortabilityManifest,
} from '../../benchmarks/portability/writer';

// ── synthetic legs ──────────────────────────────────────────────────────────

function hashesFor(salt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REQUIRED_SCIENCE_ARTIFACTS) out[name] = nodeSha256Hex(Buffer.from(`${name}:${salt}`));
  return out;
}

const SCALARS = {
  gridCols: 61,
  gridRows: 61,
  gridCellCount: 3721,
  cellSizeM: 2,
  elevationMinM: 10.5,
  elevationMaxM: 41.25,
  elevationRangeM: 30.75,
  meanConfidence: 0.81,
  qualityScore: 74,
  qualityBand: 'good',
  contourIntervalM: 1,
  contourLevelCount: 31,
  contourPolylineCount: 412,
  contourFeatureCount: 412,
  contourLabelCount: 96,
  sourcePointCount: 250_000,
  analyzedPointCount: 249_212,
  applicationContentHash: 'a'.repeat(64),
} as const;

function legFor(id: string, options: { readonly medianMs: number } = { medianMs: 900 }): PlatformRecord {
  return {
    portabilitySchemaVersion: PORTABILITY_SCHEMA_VERSION,
    benchmarkSchemaVersion: 2,
    platformId: id,
    environment: {
      platformId: id,
      endianness: 'LE',
      os: capturedEnv(id.startsWith('linux') ? 'linux 6.8.0' : 'darwin 25.5.0'),
      arch: capturedEnv(id.endsWith('x64') ? 'x64' : 'arm64'),
      cpuModel: capturedEnv(id.endsWith('x64') ? 'AMD EPYC 7763' : 'Apple M3 Max'),
      logicalCpuCount: capturedEnv('4'),
      totalMemoryBytes: capturedEnv('17179869184'),
      loadAverage: capturedEnv('0.40 0.30 0.20'),
      nodeVersion: capturedEnv('v22.17.1'),
      npmVersion: capturedEnv('10.9.2'),
      v8Version: capturedEnv('12.4.254.21-node.22'),
    },
    evaluated: {
      commit: capturedEnv('c'.repeat(40)),
      commitShort: capturedEnv('ccccccc'),
      workingTree: capturedEnv('clean'),
      releaseVersion: capturedEnv('0.6.1'),
      lockfileSha256: capturedEnv('d'.repeat(64)),
      config: REPRODUCIBILITY_CONFIG,
      benchmarkPackageVersion: '1.1.0',
    },
    fixture: {
      datasetId: 'synthetic-250000-seed20260726',
      seed: REPRODUCIBILITY_CONFIG.seed,
      requestedPointCount: 250_000,
      generatedPointCount: 250_000,
      sourceCloudHash: hashesFor('shared').pointBytes,
      descriptorHash: hashesFor('shared').fixture,
    },
    science: {
      hashes: hashesFor('shared'),
      scalars: { ...SCALARS },
      applicationContentHash: SCALARS.applicationContentHash,
    },
    buildScopedHashes: {
      // Build-scoped by construction: these differ per platform and must never
      // gate the result.
      scientificRecord: nodeSha256Hex(Buffer.from(`record:${id}`)),
      processingManifest: nodeSha256Hex(Buffer.from(`manifest:${id}`)),
    },
    internal: {
      pass: true,
      failures: [],
      scienceHashesStable: true,
      scalarsStable: true,
      manifestVerifiedOnEveryRun: true,
      recordedRuns: REPRODUCIBILITY_CONFIG.recordedRuns,
      warmupRunsCompleted: REPRODUCIBILITY_CONFIG.warmupRuns,
    },
    timing: {
      medianAnalysisMs: { value: options.medianMs, unit: 'ms', reason: null },
      analysisCv: { value: 0.021, unit: 'ratio', reason: null },
      medianPipelineTotalMs: { value: options.medianMs + 300, unit: 'ms', reason: null },
      peakRssBytes: { value: 512 * 1024 * 1024, unit: 'bytes', reason: null },
    },
  };
}

const LINUX = 'linux-x64';
const MAC = 'darwin-arm64';

/** A deep clone that keeps the record a plain JSON document. */
function clone(record: PlatformRecord): PlatformRecord {
  return JSON.parse(JSON.stringify(record)) as PlatformRecord;
}

// ── the comparator ──────────────────────────────────────────────────────────

describe('the portability comparator', () => {
  test('the required artifact list is exactly the pipeline science scope', () => {
    // The comparator names its own requirements so a missing artifact fails
    // loudly. This is what stops the two lists drifting apart in silence.
    expect([...REQUIRED_SCIENCE_ARTIFACTS].sort()).toEqual([...scienceScopedArtifacts()].sort());
    expect([...BUILD_SCOPED_ARTIFACTS].sort()).toEqual(
      PIPELINE_ARTIFACTS.filter((n) => ARTIFACT_SCOPE[n] === 'build').slice().sort(),
    );
  });

  test('two agreeing platforms reproduce, and the expected differences are reported', () => {
    const comparison = comparePlatforms([legFor(LINUX), legFor(MAC, { medianMs: 640 })]);
    expect(comparison.status).toBe('reproduced');
    expect(comparison.ok).toBe(true);
    expect(comparison.claimEstablished).toBe(true);
    expect(comparison.fixture.identical).toBe(true);
    expect(comparison.science.hashesMismatched).toBe(0);
    expect(comparison.science.scalarsMismatched).toBe(0);
    expect(comparison.science.hashesCompared).toBe(REQUIRED_SCIENCE_ARTIFACTS.length);
    expect(comparison.scalarTolerance).toBe(0);

    const fields = comparison.expectedDifferences.map((d) => d.field);
    // Build-scoped hashes and timing differ and are REPORTED, never dropped.
    expect(fields).toContain('scientificRecord');
    expect(fields).toContain('processingManifest');
    expect(fields).toContain('cpuModel');
    expect(fields).toContain('os');
    expect(fields).toContain('medianAnalysisMs');
    expect(comparison.structuralExclusions.map((e) => e.field)).toContain('archive paths');
  });

  test('a single platform is reported honestly and establishes no cross-platform claim', () => {
    const comparison = comparePlatforms([legFor(MAC)]);
    expect(comparison.status).toBe('single-platform');
    expect(comparison.ok).toBe(true);
    expect(comparison.claimEstablished).toBe(false);
    expect(comparison.claim).toContain('unestablished');
  });

  test('runtimes are never pooled across platforms', () => {
    const comparison = comparePlatforms([legFor(LINUX, { medianMs: 1200 }), legFor(MAC, { medianMs: 600 })]);
    expect(comparison.timing.map((t) => t.medianAnalysisMs)).toEqual([600, 1200]);
    // No combined figure exists to be misread as "the" runtime.
    expect(Object.keys(comparison)).not.toContain('medianAnalysisMs');
  });

  test('an unavailable statistic is never reported as zero', () => {
    const leg = legFor(MAC);
    const blind = clone(leg);
    (blind.timing as { peakRssBytes: unknown }).peakRssBytes = {
      value: null,
      unit: null,
      reason: 'process.memoryUsage() is not available in this runtime',
    };
    const comparison = comparePlatforms([legFor(LINUX), blind]);
    const row = comparison.timing.find((t) => t.platformId === MAC);
    expect(row?.peakRssBytes).toBeNull();
    expect(row?.peakRssUnavailableReason).toContain('memoryUsage');
    expect(comparisonMarkdown(comparison)).toContain('unavailable (process.memoryUsage()');
  });

  test('a big-endian leg halts the comparison instead of reporting a science mismatch', () => {
    const big = clone(legFor(LINUX));
    (big.environment as { endianness: string }).endianness = 'BE';
    const comparison = comparePlatforms([big, legFor(MAC)]);
    expect(comparison.status).toBe('unsupported-architecture');
    expect(comparison.ok).toBe(false);
    expect(comparison.science.evaluated).toBe(false);
    expect(comparison.preconditionFailures.join(' ')).toContain('little-endian');
  });

  test('a differing fixture is a generator finding, not a science finding', () => {
    const drifted = clone(legFor(MAC));
    (drifted.fixture as { sourceCloudHash: string }).sourceCloudHash = 'f'.repeat(64);
    (drifted.science.hashes as Record<string, string>).pointBytes = 'f'.repeat(64);
    // Everything downstream differs too, exactly as it would in reality.
    for (const name of REQUIRED_SCIENCE_ARTIFACTS) {
      if (name !== 'fixture') (drifted.science.hashes as Record<string, string>)[name] = nodeSha256Hex(Buffer.from(`${name}:drift`));
    }
    const comparison = comparePlatforms([legFor(LINUX), drifted]);
    expect(comparison.status).toBe('generator-not-portable');
    expect(comparison.ok).toBe(false);
    expect(comparison.fixture.identical).toBe(false);
    // The downstream comparison is suppressed rather than blamed.
    expect(comparison.science.evaluated).toBe(false);
    expect(comparison.science.mismatches).toEqual([]);
    expect(comparison.science.suppressedReason).toContain('wrong finding');
    expect(comparison.fixture.likelyCause).toContain('Math.sin');
  });

  test('same fixture, different downstream hash is scientific divergence', () => {
    const drifted = clone(legFor(MAC));
    (drifted.science.hashes as Record<string, string>).dtmZBytes = 'e'.repeat(64);
    const comparison = comparePlatforms([legFor(LINUX), drifted]);
    expect(comparison.status).toBe('science-diverged');
    expect(comparison.ok).toBe(false);
    expect(comparison.fixture.identical).toBe(true);
    expect(comparison.science.hashesMismatched).toBe(1);
    expect(comparison.science.mismatches[0].field).toBe('dtmZBytes');
  });

  test('every human-readable file derives from the comparison document', () => {
    const comparison = comparePlatforms([legFor(LINUX), legFor(MAC)]);
    // Rendering twice from the same document is byte-stable, which is what
    // makes the verifier's re-render check meaningful.
    expect(comparisonCsv(comparison)).toEqual(comparisonCsv(comparison));
    expect(comparisonMarkdown(comparison)).toEqual(comparisonMarkdown(comparison));
    expect(comparisonMarkdown(comparison)).toContain(comparison.claim);
    expect(comparisonCsv(comparison)).toContain(comparison.fixture.sourceCloudHashes[LINUX] ?? '');
  });

  test('the platform id is platform and architecture only', () => {
    expect(platformId('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformId('Linux', 'x64')).toBe('linux-x64');
    expect(() => platformId('', 'x64')).toThrow(/platform and an architecture/);
  });

  test('this host is little-endian, which the comparison requires', () => {
    expect(detectEndianness()).toBe('LE');
  });
});

// ── tamper classes ──────────────────────────────────────────────────────────

/** Write a leg directory and a manifest that matches its bytes exactly. */
function writeLeg(root: string, record: PlatformRecord): string {
  const dir = join(root, record.platformId);
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  const envText = `${JSON.stringify({ note: 'synthetic leg' }, null, 2)}\n`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PLATFORM_RECORD_FILE), recordText, 'utf8');
  writeFileSync(join(dir, 'environment.json'), envText, 'utf8');
  regenerateManifest(dir, record.platformId);
  return dir;
}

/**
 * Rebuild a leg's manifest over whatever bytes are on disk right now.
 *
 * This is the step that makes each tamper below a real test. After it, every
 * SHA-256 in the tree matches the tampered content, so nothing about the digest
 * can be what catches the edit.
 */
function regenerateManifest(dir: string, platformId: string | null): void {
  const names = [PLATFORM_RECORD_FILE, 'environment.json'];
  const manifest: PortabilityManifest = {
    schemaVersion: 2,
    portabilitySchemaVersion: PORTABILITY_SCHEMA_VERSION,
    benchmarkPackageVersion: '1.1.0',
    kind: 'platform',
    platformId,
    commit: capturedEnv('c'.repeat(40)),
    startedAtUtc: '2026-07-26T00:00:00.000Z',
    completedAtUtc: '2026-07-26T00:10:00.000Z',
    command: 'npm run benchmark:repro:portable',
    files: names.map((name) => {
      const bytes = readFileSync(join(dir, name));
      return { path: name, sha256: nodeSha256Hex(bytes), bytes: bytes.byteLength };
    }),
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Edit a leg on disk, then refresh its manifest so the digests still match. */
function tamper(dir: string, edit: (record: PlatformRecord) => void): void {
  const record = JSON.parse(readFileSync(join(dir, PLATFORM_RECORD_FILE), 'utf8')) as PlatformRecord;
  edit(record);
  writeFileSync(join(dir, PLATFORM_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  regenerateManifest(dir, record.platformId);
}

describe('tamper classes the comparison must refuse', () => {
  function scratch(): { root: string; linux: string; mac: string; clean: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'olv-portability-'));
    return {
      root,
      linux: writeLeg(root, legFor(LINUX)),
      mac: writeLeg(root, legFor(MAC)),
      clean: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  /** Run the published path end to end and return the problems plus the status. */
  function run(dirs: readonly string[], root: string, requirePlatforms: readonly string[] = []) {
    const outcome = writeComparison({
      legDirs: dirs,
      command: 'npm run benchmark:compare-platforms',
      startedAtUtc: '2026-07-26T01:00:00.000Z',
      completedAtUtc: '2026-07-26T01:00:05.000Z',
      outDir: join(root, 'out'),
      compare: { requirePlatforms },
    });
    return outcome;
  }

  test('an untampered pair passes the published path', () => {
    const s = scratch();
    try {
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.problems).toEqual([]);
      expect(outcome.comparison?.status).toBe('reproduced');
      expect(outcome.comparison?.ok).toBe(true);
    } finally {
      s.clean();
    }
  });

  test('1. an altered science hash fails even with the manifest regenerated', () => {
    const s = scratch();
    try {
      tamper(s.mac, (r) => {
        (r.science.hashes as Record<string, string>).dtmZBytes = '0'.repeat(64);
      });
      // The leg itself still verifies: the digests were refreshed.
      expect(readPlatformLeg(s.mac).problems).toEqual([]);
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.comparison?.status).toBe('science-diverged');
      expect(outcome.comparison?.ok).toBe(false);
    } finally {
      s.clean();
    }
  });

  test('2. an altered scalar fails even with the manifest regenerated', () => {
    const s = scratch();
    try {
      tamper(s.mac, (r) => {
        (r.science.scalars as { elevationMaxM: number }).elevationMaxM = 41.2500001;
      });
      expect(readPlatformLeg(s.mac).problems).toEqual([]);
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.comparison?.status).toBe('science-diverged');
      expect(outcome.comparison?.science.scalarsMismatched).toBe(1);
    } finally {
      s.clean();
    }
  });

  test('3. a replaced evaluated commit fails', () => {
    const s = scratch();
    try {
      tamper(s.mac, (r) => {
        (r.evaluated as { commit: unknown }).commit = capturedEnv('b'.repeat(40));
      });
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.comparison?.status).toBe('preconditions-not-met');
      expect(outcome.comparison?.preconditionFailures.join(' ')).toContain('same commit');
    } finally {
      s.clean();
    }
  });

  test('4. a replaced fixture seed fails', () => {
    const s = scratch();
    try {
      tamper(s.mac, (r) => {
        (r.fixture as { seed: number }).seed = 1;
      });
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.comparison?.status).toBe('generator-not-portable');
      expect(outcome.comparison?.fixture.mismatches.map((m) => m.field)).toContain('seed');
    } finally {
      s.clean();
    }
  });

  test('5. a changed point count fails', () => {
    const s = scratch();
    try {
      tamper(s.mac, (r) => {
        (r.fixture as { generatedPointCount: number }).generatedPointCount = 249_999;
      });
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.comparison?.status).toBe('generator-not-portable');
      expect(outcome.comparison?.fixture.mismatches.map((m) => m.field)).toContain('generatedPointCount');
    } finally {
      s.clean();
    }
  });

  test('6. classifying a build-scoped hash as scientific fails', () => {
    const s = scratch();
    try {
      tamper(s.mac, (r) => {
        (r.science.hashes as Record<string, string>).processingManifest = r.buildScopedHashes.processingManifest;
      });
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.comparison?.status).toBe('preconditions-not-met');
      expect(outcome.comparison?.preconditionFailures.join(' ')).toContain('build-scoped artifact processingManifest');
    } finally {
      s.clean();
    }
  });

  test('7. removing a required platform fails', () => {
    const s = scratch();
    try {
      const outcome = run([s.linux], s.root, [LINUX, MAC]);
      expect(outcome.comparison?.status).toBe('preconditions-not-met');
      expect(outcome.comparison?.preconditionFailures.join(' ')).toContain(`required platform ${MAC} is absent`);
      expect(outcome.comparison?.ok).toBe(false);
    } finally {
      s.clean();
    }
  });

  test('8. mixing schema versions fails', () => {
    const s = scratch();
    try {
      tamper(s.mac, (r) => {
        (r as { portabilitySchemaVersion: number }).portabilitySchemaVersion = PORTABILITY_SCHEMA_VERSION + 1;
      });
      // The leg is refused before the comparison, by its own manifest check.
      const leg = readPlatformLeg(s.mac);
      expect(leg.problems.join(' ')).toContain('portability schema version');
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.problems.join(' ')).toContain('portability schema version');
      expect(outcome.comparison).toBeNull();
    } finally {
      s.clean();
    }
  });

  test('an edited published verdict does not re-derive, even with fresh digests', () => {
    const s = scratch();
    try {
      const outcome = run([s.linux, s.mac], s.root, [LINUX, MAC]);
      expect(outcome.problems).toEqual([]);
      // Flip the published verdict and refresh every digest in the tree, the
      // way a careful edit would.
      const outDir = join(s.root, 'out');
      const comparisonPath = join(outDir, 'comparison.json');
      const published = JSON.parse(readFileSync(comparisonPath, 'utf8')) as { status: string };
      published.status = 'reproduced-and-then-some';
      writeFileSync(comparisonPath, `${JSON.stringify(published, null, 2)}\n`, 'utf8');
      const manifestPath = join(outDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PortabilityManifest;
      const refreshed = {
        ...manifest,
        files: manifest.files.map((f) => {
          const bytes = readFileSync(join(outDir, f.path));
          return { path: f.path, sha256: nodeSha256Hex(bytes), bytes: bytes.byteLength };
        }),
      };
      writeFileSync(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`, 'utf8');

      const verified = verifyPortabilityDir(outDir, { requirePlatforms: [LINUX, MAC] });
      expect(verified.ok).toBe(false);
      expect(verified.problems.join(' ')).toContain('does not re-derive');
    } finally {
      s.clean();
    }
  });
});
