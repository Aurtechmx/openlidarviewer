/**
 * withheldChangeFeatures.test.ts: change detection and feature extraction
 * apply the Withheld policy.
 *
 * Both are scientific processing, so a point the producer marked Withheld is
 * not read (`withheldPolicy.ts`), and each result states the counts in the
 * same words as the terrain, volume and profile reports. A scan with no
 * Withheld point produces the same bytes it did before the policy applied:
 * the hashes below are the outputs of main for the same fixture.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseBuffer } from '../src/io/parseBuffer';
import type { PointCloud } from '../src/model/PointCloud';
import {
  buildSharedEpochDtms,
  epochWithheldLines,
  excludeWithheldEpoch,
  withheldEpochs,
} from '../src/terrain/change/compareEpochs';
import { compareDtms } from '../src/terrain/change/compareDtms';
import { changeToEsriAscii } from '../src/terrain/change/changeRaster';
import { buildFeatureExtractionInput } from '../src/app/featureExtractionInput';
import { extractBuildingCandidates } from '../src/features/FeatureExtractionService';
import { CandidateReviewStore } from '../src/features/candidateReview';
import { acceptedFootprintGeoJson } from '../src/ui/featureCandidatesMount';
import { isWithheld } from '../src/science/withheldPolicy';
import { horizontalSpanXY } from '../src/render/measure/measureDerivations';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const IDENTITY_LL = (p: readonly [number, number, number]): [number, number, number] => [p[0], p[1], p[2]];

async function load(name: string): Promise<PointCloud> {
  const bytes = readFileSync(join(FIXTURES, name));
  const { cloud } = await parseBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    'las',
    name,
  );
  return cloud;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The compare pipeline from positions to the exported .asc, as the shell runs it. */
function differenceAsc(
  before: { positions: Float32Array; origin?: readonly [number, number, number] },
  after: { positions: Float32Array; origin?: readonly [number, number, number] },
): string {
  const dtms = buildSharedEpochDtms(before, after)!;
  const cmp = compareDtms(dtms.before, dtms.after, {});
  return changeToEsriAscii({
    diff: cmp.result.diff,
    ncols: dtms.cols,
    nrows: dtms.rows,
    cellSizeM: dtms.cellSizeM,
    xllCorner: dtms.before.originH1,
    yllCorner: dtms.before.originH2,
  });
}

/** The fields extraction reads, with the fixture's class-2 points relabelled as buildings. */
function asBuildings(cloud: PointCloud): PointCloud {
  return {
    positions: cloud.positions,
    classification: Uint8Array.from(cloud.classification!, (c) => (c === 2 ? 6 : c)),
    classificationFlags: cloud.classificationFlags,
    classificationIsDerived: false,
    sourceFormat: cloud.sourceFormat,
    metadata: cloud.metadata,
  } as unknown as PointCloud;
}

function stripFlags(cloud: PointCloud): PointCloud {
  return { ...cloud, classificationFlags: undefined } as PointCloud;
}

function footprintExport(cloud: PointCloud): string {
  const input = buildFeatureExtractionInput(cloud)!;
  const buildings = extractBuildingCandidates(input.buildingPoints, input.buildingGrid, input.unit);
  const review = new CandidateReviewStore();
  for (const b of buildings) review.accept(b.id);
  return JSON.stringify(acceptedFootprintGeoJson(buildings, review, 'EPSG:32615', IDENTITY_LL, input.withheld));
}

describe('change detection leaves Withheld points out', () => {
  it('drops the 3 Withheld points from an epoch and records the counts', async () => {
    const cloud = await load('withheld-flags.las');
    const flags = cloud.classificationFlags!;
    const epoch = { positions: cloud.positions, origin: cloud.sourceOrigin };
    const { cloud: read, withheld } = excludeWithheldEpoch(epoch, flags);
    expect(withheld).toEqual({ sourcePoints: 12, withheldExcluded: 3, analysedPoints: 9 });
    expect(read.positions).toHaveLength(27);
    const kept: number[] = [];
    for (let i = 0; i < 12; i++) {
      if (!isWithheld(flags[i])) kept.push(...cloud.positions.subarray(i * 3, i * 3 + 3));
    }
    expect(Array.from(read.positions)).toEqual(kept);
  });

  it('changes the difference: the Withheld ground no longer shapes the after surface', async () => {
    const cloud = await load('withheld-flags.las');
    const epoch = { positions: cloud.positions, origin: cloud.sourceOrigin };
    const unflagged = { ...epoch, positions: Float32Array.from(cloud.positions) };
    const after = excludeWithheldEpoch(epoch, cloud.classificationFlags).cloud;
    // Before the policy the two identical epochs differenced to no change.
    const everyPoint = differenceAsc(unflagged, epoch);
    const policy = differenceAsc(unflagged, after);
    expect(policy).not.toBe(everyPoint);
  });

  it('names the counts in the compare panel', async () => {
    const cloud = await load('withheld-flags.las');
    const epoch = { positions: cloud.positions, origin: cloud.sourceOrigin };
    const a = excludeWithheldEpoch(epoch, undefined).withheld;
    const b = excludeWithheldEpoch(epoch, cloud.classificationFlags).withheld;
    expect(epochWithheldLines(a, b)).toEqual([
      'Before points: 12 of 12 analysed; Withheld excluded: unknown (no flags on a source)',
      'After points: 9 of 12 analysed; Withheld excluded: 3',
    ]);
  });

  it('is byte-identical on a scan with no Withheld point', async () => {
    const cloud = await load('terrain-access-utm.las');
    const epoch = { positions: cloud.positions, origin: cloud.sourceOrigin };
    const shifted = { positions: cloud.positions.map((v, i) => (i % 3 === 2 ? v + 0.5 : v)), origin: cloud.sourceOrigin };
    const a = excludeWithheldEpoch(epoch, cloud.classificationFlags);
    const b = excludeWithheldEpoch(shifted, cloud.classificationFlags);
    expect(a.cloud).toBe(epoch);
    expect(b.cloud).toBe(shifted);
    expect(epochWithheldLines(a.withheld, b.withheld)).toEqual([]);
    expect(sha(differenceAsc(a.cloud, b.cloud))).toBe(ASC_HASH);
  });
});

describe('the alignment gate and an all-Withheld epoch', () => {
  const WITHHELD = 0b0100;

  it('measures the residual-gate span on the filtered before epoch', () => {
    // A Withheld point 1 km out stretched the span the 10% residual gate is
    // scaled by; the read points span 10 units.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 1000, 1000, 0]);
    const flags = new Uint8Array([0, 0, 0, WITHHELD]);
    const prepared = { beforeCloud: { positions }, afterCloud: { positions } };
    const everyPoint = horizontalSpanXY(positions);
    const { span } = withheldEpochs(prepared, { classificationFlags: flags }, {});
    expect(everyPoint).toBe(1000);
    expect(span).toBe(10);
    // Nothing withheld: the same span as before.
    expect(withheldEpochs(prepared, {}, {}).span).toBe(everyPoint);
  });

  it('leaves no points and still names the counts when every point is Withheld', async () => {
    const cloud = await load('withheld-flags.las');
    const epoch = { positions: cloud.positions, origin: cloud.sourceOrigin };
    const all = new Uint8Array(12).fill(WITHHELD);
    const r = withheldEpochs({ beforeCloud: epoch, afterCloud: epoch }, { classificationFlags: all }, {});
    expect(r.beforeCloud.positions).toHaveLength(0);
    expect(buildSharedEpochDtms(r.beforeCloud, r.afterCloud)).toBeNull();
    expect(r.lines[0]).toBe('Before points: 0 of 12 analysed; Withheld excluded: 12');
  });
});

describe('feature extraction leaves Withheld points out', () => {
  it('reads 7 of the 10 building points and records the counts', async () => {
    const cloud = asBuildings(await load('withheld-flags.las'));
    const input = buildFeatureExtractionInput(cloud)!;
    // Before the policy every class-6 point was read, Withheld or not.
    expect(buildFeatureExtractionInput(stripFlags(cloud))!.buildingPoints).toHaveLength(10);
    expect(input.buildingPoints).toHaveLength(7);
    expect(input.withheld).toEqual({ sourcePoints: 10, withheldExcluded: 3, analysedPoints: 7 });
  });

  it('records the counts in the GeoJSON export', async () => {
    const gj = JSON.parse(footprintExport(asBuildings(await load('withheld-flags.las'))));
    expect(gj.metadata.withheld).toEqual({ sourcePoints: 10, withheldExcluded: 3, analysedPoints: 7 });
  });

  it('is byte-identical on a scan with no Withheld point', async () => {
    const cloud = asBuildings(await load('terrain-access-utm.las'));
    const text = footprintExport(cloud);
    expect(JSON.parse(text).metadata.withheld).toBeUndefined();
    expect(sha(text)).toBe(GEOJSON_HASH);
  });
});

const ASC_HASH = '4399cf394aabb89c35b9f06b3395248f14bed55663fd2851894a4293b3d13710';
const GEOJSON_HASH = 'bbcbfa03824957ac67597fc964f79570ab041eab9ef793d414179e47d3db47a4';
