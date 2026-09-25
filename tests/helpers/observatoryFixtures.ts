/**
 * observatoryFixtures.ts: fixture builders shared by the Observatory specs
 * (freshness stamp, session gate, F8 DDA records, single-station setups).
 */
import { join } from 'node:path';

import type { AcquisitionStation } from '../../src/model/AcquisitionStations';
import type { ObservationFreshnessStamp } from '../../src/science/analysisFreshness';

export const OBSERVATORY_VALIDATION_DIR = join(__dirname, '..', '..', 'validation', 'observatory');
export const F8_EXPECTED_PATH = join(OBSERVATORY_VALIDATION_DIR, 'expected', 'f8-dda-cases.expected.json');

/** One frozen record of validation/observatory/expected/f8-dda-cases.expected.json. */
export interface F8ExpectedRecord {
  readonly caseId: string;
  readonly input: {
    readonly origin: readonly number[];
    readonly direction: readonly number[];
    readonly tMax: number;
    readonly domain: { readonly minCorner: readonly number[]; readonly maxCorner: readonly number[] };
    readonly voxelEdge: number;
  };
  readonly clip: readonly [string, string] | null;
  readonly voxels: readonly (readonly number[])[];
}

export const sameTarget = (a: string | null, b: string | null): boolean => a !== null && a === b;

export const stamp = (over: Partial<ObservationFreshnessStamp> = {}): ObservationFreshnessStamp => ({
  targetId: 'scan_1',
  classificationEpoch: 3,
  crsRevision: 7,
  coverageMode: 'full',
  sourceDigest: 'sha256:source',
  basis: 'full',
  roiDigest: 'sha256:roi',
  stationSetDigest: 'sha256:stations',
  parameterDigest: 'sha256:params',
  methodTags: [],
  metresPerUnit: 1,
  ...over,
});

type NowFacts = Pick<
  ObservationFreshnessStamp,
  'targetId' | 'classificationEpoch' | 'crsRevision' | 'sourceDigest' | 'roiDigest' | 'stationSetDigest' | 'parameterDigest'
>;

export const now = (over: Partial<NowFacts> = {}): NowFacts => ({
  targetId: 'scan_1',
  classificationEpoch: 3,
  crsRevision: 7,
  sourceDigest: 'sha256:source',
  roiDigest: 'sha256:roi',
  stationSetDigest: 'sha256:stations',
  parameterDigest: 'sha256:params',
  ...over,
});

/** A DECLARED ptx-block station at the world origin with an empty record range. */
export const originStation = (id: string): AcquisitionStation => ({
  id,
  source: 'ptx-block',
  pose: { worldTranslation: [0, 0, 0], localPositionSource: 'not-applicable' },
  recordRange: { start: 0, end: 0 },
  originStatus: 'DECLARED',
});
