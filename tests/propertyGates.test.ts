/**
 * propertyGates.test.ts — property fuzzing of the two safety gates, no framework.
 *
 * A hand-rolled seeded loop — a property-testing dependency would be overkill
 * for what ten lines do. It asserts the invariants that MUST hold for every input, not
 * just the handful of examples the unit tests pin:
 *   - Evidence gate: a product is never simultaneously "validated" and
 *     "exploratory", and any unregistered id is exploratory (never silently OK).
 *   - Record fingerprint: identical scientific content always hashes the same
 *     regardless of build/time; and it is deterministic across repeated builds.
 */
import { describe, it, expect } from 'vitest';
import { exportGate, EVIDENCE_REGISTRY } from '../src/validation/evidenceRegistry';
import { isExploratoryExport } from '../src/validation/exportEvidenceNote';
import {
  buildScientificAnalysisRecord,
  type ScientificAnalysisRecordInput,
} from '../src/science/scientificAnalysisRecord';
import type { BuildIdentity } from '../src/build/buildIdentity';

/** Seeded LCG — deterministic fuzz, reproducible on failure. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const REGISTERED = Object.keys(EVIDENCE_REGISTRY);
const METHOD_IDS = ['olv.ground.smrf', 'olv.dtm.idw-fill', 'olv.terrain.vrm', 'olv.validation.spatial-block'];

describe('evidence gate — property', () => {
  it('never validated AND exploratory at once; unregistered is always exploratory', () => {
    const r = rng(12345);
    for (let i = 0; i < 1000; i++) {
      // Half registered ids, half random junk strings.
      const useReg = r() < 0.5;
      const id = useReg
        ? REGISTERED[Math.floor(r() * REGISTERED.length)]
        : `JUNK-${Math.floor(r() * 1e9).toString(36)}`;
      const d = exportGate(id);
      // Core invariant: the two states are mutually exclusive.
      expect(d.allowed && d.exploratoryOnly).toBe(false);
      // An unregistered id can never be a validated export.
      if (!useReg) {
        expect(d.allowed).toBe(false);
        expect(isExploratoryExport(id)).toBe(true);
      }
    }
  });
});

describe('record fingerprint — property', () => {
  const buildA: BuildIdentity = {
    version: '0.5.8', commit: 'aaaaaaa', dirty: false,
    builtAt: '2026-07-08T00:00:00.000Z', node: 'v22', channel: 'live',
  };

  it('same content hashes identically regardless of build/time', () => {
    const r = rng(777);
    for (let i = 0; i < 500; i++) {
      const summary = { rmse: Math.round(r() * 1000) / 100, n: Math.floor(r() * 1e5) };
      const methodIds = METHOD_IDS.filter(() => r() < 0.5);
      if (methodIds.length === 0) methodIds.push('olv.ground.smrf');
      const base: ScientificAnalysisRecordInput = {
        kind: 'terrain-dtm',
        crs: { horizontal: 'EPSG:32610', horizontalKnown: true, verticalDatum: 'x', verticalDatumKnown: true },
        methodIds,
        evidenceExploratory: r() < 0.5,
        summary,
        build: buildA,
        generatedAt: '2026-01-01T00:00:00Z',
      };
      const h1 = buildScientificAnalysisRecord(base).contentHash;
      // Same content, different build + wall-clock time → identical fingerprint.
      const h2 = buildScientificAnalysisRecord({
        ...base,
        build: { ...buildA, commit: `c${i}`, builtAt: `20${99 - (i % 90)}-01-01T00:00:00Z` },
        generatedAt: `2050-06-0${(i % 9) + 1}T00:00:00Z`,
      }).contentHash;
      expect(h2).toBe(h1);
    }
  });
});
