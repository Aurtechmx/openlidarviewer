/**
 * methodSupportingTests.test.ts — the method→test hop of the provenance chain.
 *
 * The registry (methodRegistry.ts) binds each scientific method to the SOURCE
 * that implements it (`implementation`), and methodRegistry.test.ts asserts
 * those paths exist. The chain claim → method → version → source → test → study
 * was missing one machine-readable hop: from a method to the TEST(s) that
 * validate it. A reader could find the code behind a figure but not, without a
 * grep, the evidence that the code is correct.
 *
 * This binding closes that hop WITHOUT adding bytes to the shipped bundle: the
 * map lives here in the test tree, not in the eager registry. It is a hard
 * contract, not documentation — every registered method must name at least one
 * supporting test, every named test must exist, and no entry may reference a
 * method the registry does not define. Each listed test genuinely exercises the
 * method's implementation module (verified when the binding was written); it is
 * the primary validation for that method, not an exhaustive list of every test
 * that transitively touches it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHOD_REGISTRY, isMethodId } from '../src/science/methodRegistry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** methodId → the primary test(s) that validate it. Repo-relative paths. */
const SUPPORTING_TESTS: Readonly<Record<string, readonly string[]>> = {
  'olv.ground.smrf': [
    'tests/groundFilterValidation.test.ts',
    'tests/groundFilterPdalAgreement.test.ts',
    'tests/groundFilterEstoniaAgreement.test.ts',
  ],
  'olv.class.derived-heuristic': [
    'tests/deriveClassification.test.ts',
    'tests/invariantClassification.test.ts',
    'tests/groundFilterProducerAgreement.test.ts',
  ],
  'olv.terrain.slope-horn': [
    'tests/terrainDerivatives.test.ts',
    'tests/slopeCrossCheck.test.ts',
    'tests/aspectCrossCheck.test.ts',
  ],
  'olv.terrain.vrm': ['tests/vrmCrossCheck.test.ts', 'tests/terrainDescriptorSyntheticTruth.test.ts'],
  'olv.terrain.tpi': ['tests/tpiCrossCheck.test.ts', 'tests/terrainDescriptorSyntheticTruth.test.ts'],
  'olv.dtm.idw-fill': ['tests/surfaceFromRaster.test.ts', 'tests/geodesicFillAccuracy.test.ts'],
  'olv.validation.holdout-rmse': ['tests/holdoutRmse.test.ts', 'tests/stratifiedRmse.test.ts'],
  'olv.validation.spatial-block': ['tests/spatialBlockHoldout.test.ts'],
  'olv.validation.reliability-wilson': ['tests/reliabilitySplit.test.ts'],
  'olv.registration.icp-planar': ['tests/registrationModel.test.ts', 'tests/planarIcpReexport.test.ts'],
  'olv.registration.epoch-horizontal-icp': [
    'tests/alignEpochs.test.ts',
    'tests/registrationArtifact.test.ts',
  ],
  'olv.volume.stockpile': [
    'tests/stockpileVolume.test.ts',
    'tests/analyticVolumeOracle.test.ts',
    'tests/volumeSyntheticTruth.test.ts',
  ],
  'olv.volume.stockpile-area-grid': ['tests/stockpileAreaGrid.test.ts'],
  'olv.topology.linkage-record': ['tests/sourceTopologyManifest.test.ts'],
  'olv.feature.building-footprint': ['tests/buildingFootprints.test.ts', 'tests/footprintTrace.test.ts'],
  'olv.feature.conductor-fit': ['tests/conductors.test.ts'],
  'olv.contour.analytical': [
    'tests/contourAnalyticValidation.test.ts',
    'tests/contourCrossCheck.test.ts',
  ],
  'olv.contour.generalize': ['tests/contourGeometryProduct.test.ts', 'tests/contourAdaptiveGeneralize.test.ts'],
  'olv.contour.generalize.dp': ['tests/contourGeometryProduct.test.ts'],
  'olv.contour.generalize.terrain-adaptive': ['tests/contourAdaptiveGeneralize.test.ts'],
};

describe('method → supporting-test binding', () => {
  it('every registered method names at least one supporting test', () => {
    const missing = Object.keys(METHOD_REGISTRY).filter(
      (id) => !(SUPPORTING_TESTS[id]?.length),
    );
    expect(missing, `methods with no supporting test: ${missing.join(', ')}`).toEqual([]);
  });

  it('names no method the registry does not define', () => {
    const unknown = Object.keys(SUPPORTING_TESTS).filter((id) => !isMethodId(id));
    expect(unknown, `binding references unregistered ids: ${unknown.join(', ')}`).toEqual([]);
  });

  it('every named supporting test file exists', () => {
    const absent: string[] = [];
    for (const [id, tests] of Object.entries(SUPPORTING_TESTS)) {
      for (const t of tests) {
        if (!existsSync(resolve(ROOT, t))) absent.push(`${id} → ${t}`);
      }
    }
    expect(absent, `named tests that do not exist:\n${absent.join('\n')}`).toEqual([]);
  });
});
