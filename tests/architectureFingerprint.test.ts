/**
 * architectureFingerprint.test.ts: the release manifest carries a canonical,
 * timestamp-free fingerprint of the enforced module-graph facts.
 *
 * The fingerprint is derived from the SAME measurement scripts/lint-module-graph.mjs
 * enforces (directory-pair edges, the two fan-out ratchets, file-level cycles),
 * so a reviewer can recompute it from the source tree and match it byte for
 * byte. Three properties matter and are checked here:
 *
 *   1. Deterministic — the same tree yields the same hex on every run. A digest
 *      that drifted between two calls on one tree would prove a timestamp or a
 *      set-iteration order leaked into the canonical form.
 *   2. Anchored to the committed baseline — the counts the fingerprint reports
 *      are the counts the shrink-only gate holds, so the two can never disagree
 *      silently.
 *   3. Timestamp-free — the fingerprint object is exactly six scalar fields and
 *      the digest is a 64-hex string; nothing date-shaped rides along.
 *
 * The manifest builder then threads the fingerprint into an `architecture`
 * block, tested against buildManifest directly so it needs no staged release.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeArchitectureFingerprint,
  measureModuleGraph,
} from '../scripts/lint-module-graph.mjs';
import { buildManifest } from '../scripts/create-release-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/module-graph-baseline.json');

describe('architecture fingerprint', () => {
  it('is deterministic: the same tree yields the same digest', () => {
    const a = computeArchitectureFingerprint();
    const b = computeArchitectureFingerprint();
    expect(a.architectureDigest).toBe(b.architectureDigest);
    expect(a).toEqual(b);
  });

  it('reports exactly the six documented scalar fields', () => {
    const fp = computeArchitectureFingerprint();
    expect(Object.keys(fp).sort()).toEqual(
      [
        'architectureDigest',
        'cycleCount',
        'edgeCount',
        'mainFanOut',
        'moduleCount',
        'viewerFanOut',
      ].sort(),
    );
    for (const [k, v] of Object.entries(fp)) {
      if (k === 'architectureDigest') continue;
      expect(typeof v).toBe('number');
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('carries no timestamp: the digest is a 64-hex string and no field is date-shaped', () => {
    const fp = computeArchitectureFingerprint();
    expect(fp.architectureDigest).toMatch(/^[0-9a-f]{64}$/);
    const asText = JSON.stringify(fp);
    // An ISO-8601 date or a plausible epoch-millis timestamp would betray a clock.
    expect(asText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(asText).not.toMatch(/"\d{13}"/);
  });

  it('matches the committed module-graph baseline the gate enforces', () => {
    const fp = computeArchitectureFingerprint();
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    expect(fp.cycleCount).toBe(baseline.cycles.count);
    expect(fp.mainFanOut).toBe(baseline.fanOut['src/main.ts'].runtime);
    expect(fp.viewerFanOut).toBe(baseline.fanOut['src/render/Viewer.ts'].runtime);
    // The live measurement and the fingerprint agree on the same counts.
    const m = measureModuleGraph();
    expect(m.problems).toEqual([]);
    expect(fp.moduleCount).toBe(m.filesScanned);
    expect(fp.mainFanOut).toBe(m.fanOut.get('src/main.ts')!.runtime);
    expect(fp.viewerFanOut).toBe(m.fanOut.get('src/render/Viewer.ts')!.runtime);
  });

  it('is threaded into the release manifest under an `architecture` block', () => {
    const fp = computeArchitectureFingerprint();
    const version = '9.9.9';
    const evidence = {
      version,
      commit: 'abc1234',
      tag: `v${version}`,
      releaseAuthoritative: true,
      gateExit: 0,
      stages: { mutation: 'executed' },
    };
    const assets = Object.fromEntries(
      ['sourceZip', 'deployZip', 'sbom', 'evidence', 'gateLog', 'gateLogSha256', 'releaseNotes'].map(
        (k) => [k, { file: `${k}.bin`, sizeBytes: 1, sha256: 'x' }],
      ),
    );
    const built = buildManifest({
      version,
      evidence,
      assets,
      builtAt: '2026-01-01T00:00:00.000Z',
      architecture: fp,
    });
    expect(built.ok).toBe(true);
    expect(built.manifest!.architecture).toEqual(fp);
    // The block is optional in the pure builder — omitting it leaves null,
    // never a thrown error, so a caller that has no measurement still builds.
    const without = buildManifest({ version, evidence, assets, builtAt: '2026-01-01T00:00:00.000Z' });
    expect(without.ok).toBe(true);
    expect(without.manifest!.architecture).toBeNull();
  });
});
