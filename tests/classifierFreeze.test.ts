/**
 * classifierFreeze.test.ts — the freeze on the derived-classification
 * heuristic.
 *
 * A derived classification is only reproducible if a reader can say WHICH
 * classifier produced it. The classifier is a rule set plus a parameter
 * bundle, and until this file existed either could move without leaving a
 * trace in an export: two files both stamped "derived (heuristic)
 * classification" could have been produced by different rules.
 *
 * The freeze is three assertions that have to be defeated together:
 *
 *   1. the live `DEFAULTS` the classifier runs on ARE the frozen preset for
 *      `CLASSIFIER_VERSION` (same object identity), so the running code and
 *      the published record cannot drift apart;
 *   2. every preset's `digest` recomputes from its own contents, so editing a
 *      historical preset in place fails here rather than rewriting history;
 *   3. this file carries its OWN copy of every published preset. A default
 *      changed in the source has to be changed here too, and adding an entry
 *      here without bumping `CLASSIFIER_VERSION` fails assertion 1.
 *
 * The last one is the point. A default cannot move unless the version moves
 * with it.
 */
import { describe, it, expect } from 'vitest';
import {
  CLASSIFIER_METHOD_ID,
  CLASSIFIER_VERSION,
  CLASSIFIER_PRESET,
  CLASSIFIER_PRESETS,
  classifierPresetDigest,
  classifierProcessingOp,
  deriveClassification,
} from '../src/render/class/deriveClassification';
import { METHOD_REGISTRY, methodTag, methodRef } from '../src/science/methodRegistry';

/**
 * Every preset ever published, written out here as literals. This is the
 * second copy the freeze needs: the source can no longer be the only place a
 * default is stated.
 */
const PUBLISHED = {
  1: {
    id: 'derived-heuristic-v1',
    digest: 'sha256:58e3e9083d776a6306e1b032d177f5a531536ee746097906805b9a99567dd43a',
    params: {
      buildingMinHagM: 2.5,
      buildingMinSupport: 0.66,
      buildingRoughnessMaxM: 1.5,
      elevThresholdM: 0.3,
      groundBandM: 0.5,
      lowVegBandM: 2,
      maxGridDim: 768,
      maxObjectSizeM: 20,
      medVegBandM: 5,
      minGroundSupport: 0.5,
      slope: 0.15,
      vegGreennessMin: 0.06,
    },
  },
  2: {
    id: 'derived-heuristic-v2',
    digest: 'sha256:a4270700486436d01a1c5a2d0a8987faca2a92d6f3a0059e542bd3f256c6e35f',
    params: {
      buildingMinHagM: 2.5,
      buildingMinSupport: 0.66,
      buildingRoughnessMaxM: 1.5,
      despikeNeighbourFactor: 1,
      elevThresholdM: 0.3,
      groundBandM: 0.5,
      lowVegBandM: 2,
      maxGridDim: 768,
      maxObjectSizeM: 20,
      medVegBandM: 5,
      minGroundSupport: 0.5,
      slope: 0.15,
      vegGreennessMin: 0.06,
    },
  },
} as const;

describe('classifier version and preset freeze', () => {
  it('CLASSIFIER_VERSION is a positive integer and names a published preset', () => {
    expect(Number.isInteger(CLASSIFIER_VERSION)).toBe(true);
    expect(CLASSIFIER_VERSION).toBeGreaterThanOrEqual(1);
    expect(CLASSIFIER_PRESETS[CLASSIFIER_VERSION]).toBeDefined();
    expect(CLASSIFIER_PRESET).toBe(CLASSIFIER_PRESETS[CLASSIFIER_VERSION]);
  });

  it('the running defaults ARE the frozen preset for the current version', () => {
    // deriveClassification merges `CLASSIFIER_PRESET.params` over the caller's
    // options, so this equality is the whole guarantee that the record
    // describes the run.
    const run = deriveClassification(flatCloud(), FLAT_COUNT, {});
    expect(run.classifier.presetId).toBe(CLASSIFIER_PRESET.id);
    expect(run.classifier.presetDigest).toBe(CLASSIFIER_PRESET.digest);
    for (const [key, value] of Object.entries(CLASSIFIER_PRESET.params)) {
      expect(run.classifier.parameters[key]).toBe(value);
    }
  });

  it('every published preset matches this file, value for value', () => {
    expect(Object.keys(CLASSIFIER_PRESETS).sort()).toEqual(Object.keys(PUBLISHED).sort());
    for (const [version, expected] of Object.entries(PUBLISHED)) {
      const preset = CLASSIFIER_PRESETS[Number(version)];
      expect(preset.id).toBe(expected.id);
      expect(preset.version).toBe(Number(version));
      expect({ ...preset.params }).toEqual({ ...expected.params });
    }
  });

  it('every preset digest recomputes from its own contents', () => {
    for (const preset of Object.values(CLASSIFIER_PRESETS)) {
      expect(classifierPresetDigest(preset)).toBe(preset.digest);
    }
  });

  it('the digest is sensitive to a single moved default', () => {
    const tampered = {
      ...CLASSIFIER_PRESET,
      params: { ...CLASSIFIER_PRESET.params, slope: 0.16 },
    };
    expect(classifierPresetDigest(tampered)).not.toBe(CLASSIFIER_PRESET.digest);
  });

  it('the method registry carries the classifier at the same version', () => {
    expect(METHOD_REGISTRY[CLASSIFIER_METHOD_ID]).toBeDefined();
    expect(METHOD_REGISTRY[CLASSIFIER_METHOD_ID].version).toBe(CLASSIFIER_VERSION);
    expect(methodTag(methodRef(CLASSIFIER_METHOD_ID))).toBe(
      `${CLASSIFIER_METHOD_ID}@${CLASSIFIER_VERSION}`,
    );
  });
});

describe('classification provenance', () => {
  it('names the method, the preset and the parameters the run used', () => {
    const run = deriveClassification(flatCloud(), FLAT_COUNT, { cellSizeM: 2 });
    expect(run.classifier.method).toBe(`${CLASSIFIER_METHOD_ID}@${CLASSIFIER_VERSION}`);
    expect(run.classifier.presetId).toBe(CLASSIFIER_PRESET.id);
    // The EFFECTIVE cell size, not the default: an export has to be able to
    // state the grid the run actually used.
    expect(run.classifier.parameters.cellSizeM).toBe(run.cellSizeM);
    expect(run.provenance).toContain(`${CLASSIFIER_METHOD_ID}@${CLASSIFIER_VERSION}`);
  });

  it('records which optional cues were active', () => {
    const positions = flatCloud();
    const colors = new Uint8Array(FLAT_COUNT * 3).fill(120);
    const returnNumber = new Uint8Array(FLAT_COUNT).fill(1);
    const returnCount = new Uint8Array(FLAT_COUNT).fill(1);
    const bare = deriveClassification(positions, FLAT_COUNT, {});
    expect(bare.classifier.cues).toEqual([]);
    const cued = deriveClassification(positions, FLAT_COUNT, {
      colors,
      returnNumber,
      returnCount,
    });
    expect(cued.classifier.cues).toEqual(['rgb-greenness', 'multi-return']);
  });

  it('a not-computed run still carries the classifier identity', () => {
    const empty = deriveClassification(new Float32Array(0), 0, {});
    expect(empty.classifier.method).toBe(`${CLASSIFIER_METHOD_ID}@${CLASSIFIER_VERSION}`);
    expect(empty.classifier.presetDigest).toBe(CLASSIFIER_PRESET.digest);
  });

  it('builds a processing-manifest op an export can chain', () => {
    const run = deriveClassification(flatCloud(), FLAT_COUNT, { cellSizeM: 2 });
    const op = classifierProcessingOp(run);
    expect(op.method).toBe(`${CLASSIFIER_METHOD_ID}@${CLASSIFIER_VERSION}`);
    expect(op.params.presetId).toBe(CLASSIFIER_PRESET.id);
    expect(op.params.presetDigest).toBe(CLASSIFIER_PRESET.digest);
    expect((op.params.parameters as Record<string, number>).cellSizeM).toBe(run.cellSizeM);
    // JSON-safe: the manifest hashes a canonical serialisation of this object.
    expect(JSON.parse(JSON.stringify(op))).toEqual(op);
  });
});

// ── a small deterministic cloud, enough for the classifier to run ──────────
const FLAT_SIDE = 20;
const FLAT_COUNT = FLAT_SIDE * FLAT_SIDE;

function flatCloud(): Float32Array {
  const positions = new Float32Array(FLAT_COUNT * 3);
  let i = 0;
  for (let x = 0; x < FLAT_SIDE; x++) {
    for (let y = 0; y < FLAT_SIDE; y++) {
      positions[i * 3] = x * 0.5;
      positions[i * 3 + 1] = y * 0.5;
      positions[i * 3 + 2] = 100;
      i++;
    }
  }
  return positions;
}
