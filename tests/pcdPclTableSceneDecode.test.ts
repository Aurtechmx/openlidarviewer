/**
 * pcdPclTableSceneDecode.test.ts
 *
 * `table_scene_mug_stereo_textured.pcd` from the Point Cloud Library's data
 * repository (PointCloudLibrary/data `tutorials/`, BSD-3-Clause), vendored in
 * `tests/fixtures/pcd-pcl/`, opened through `loadFile` with the real parse
 * worker running in this process.
 *
 * The file is an organized 640 x 480 stereo capture written as
 * `binary_compressed`: one LZF block holding the x, y, z and rgb columns one
 * after another. 97,920 of its 307,200 cells hold NaN coordinates, the PCL
 * convention for a pixel with no depth. Its header declares
 * `VIEWPOINT 0 0 0 0 1 0 0`, which the PCD format defines as a translation
 * (tx ty tz) followed by a quaternion with its scalar first (qw qx qy qz): no
 * translation and a half turn about the x axis.
 *
 * PCL's own loader keeps the viewpoint beside the points as the sensor origin
 * and orientation and does not move the points by it. OLV does the same: it
 * records the pose on the organized grid and the acquisition station, and
 * leaves the coordinates as stored.
 *
 * The reference values were read from the file by decompressing its LZF block
 * independently of OLV (the decoder OLV uses is three.js's PCDLoader).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadFile } from '../src/io/loadFile';
import type { PointCloud } from '../src/model/PointCloud';
import { installInProcessParseWorker, type InProcessParseWorkerHandle } from './helpers/inProcessParseWorker';

const NAME = 'table_scene_mug_stereo_textured.pcd';
const BYTES = readFileSync(new URL(`./fixtures/pcd-pcl/${NAME}`, import.meta.url));

/** Independently decoded reference values (see the header comment). */
const REF = {
  cells: 307_200,
  finite: 209_280,
  nonFinite: 97_920,
  min: [-0.45642998814582825, -0.5107399821281433, 0.6900100111961365],
  max: [0.715179979801178, 0.1792300045490265, 2.5927000045776367],
  // Finite cells in file order: the first, the middle one, and the last.
  first: { xyz: [-0.3819099962711334, -0.448199987411499, 2.0257999897003174], rgb: [0x43, 0x43, 0x3e] },
  middle: { ordinal: 104_640, xyz: [0.04211200028657913, 0.019070999696850777, 0.7781000137329102], rgb: [0x9d, 0x9e, 0x69] },
  last: { xyz: [0.22537000477313995, 0.17903999984264374, 0.7029200196266174], rgb: [0xe9, 0xeb, 0x13] },
};

let bridge: InProcessParseWorkerHandle;
let cloud: PointCloud;

beforeAll(async () => {
  bridge = await installInProcessParseWorker();
  ({ cloud } = await loadFile(new File([BYTES], NAME)));
}, 30_000);
afterAll(() => bridge.restore());

function world(i: number): number[] {
  return [0, 1, 2].map((k) => cloud.positions[i * 3 + k] + cloud.origin[k]);
}

describe('PCL table_scene_mug_stereo_textured.pcd', () => {
  it('has the header the format and the reference describe', () => {
    const header = new TextDecoder().decode(BYTES.subarray(0, 194));
    expect(header).toContain('\nWIDTH 640\nHEIGHT 480\nVIEWPOINT 0 0 0 0 1 0 0\nPOINTS 307200\nDATA binary_compressed\n');
  });

  it('records the organized 640 x 480 grid it declares', () => {
    const frame = cloud.organizedRange?.frames[0];
    expect(cloud.organizedRange?.organization).toBe('organized-grid');
    expect(frame?.width).toBe(640);
    expect(frame?.height).toBe(480);
    expect(frame?.cellState.length).toBe(REF.cells);
  });

  it('decompresses every finite cell, in file order, to the stored values', () => {
    expect(cloud.pointCount).toBe(REF.finite);
    const close = (got: number[], want: number[]): void => {
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k], 6);
    };
    close(world(0), REF.first.xyz);
    close(world(REF.middle.ordinal), REF.middle.xyz);
    close(world(REF.finite - 1), REF.last.xyz);
    const rgb = (i: number): number[] => Array.from(cloud.colors!.subarray(i * 3, i * 3 + 3));
    expect(rgb(0)).toEqual(REF.first.rgb);
    expect(rgb(REF.middle.ordinal)).toEqual(REF.middle.rgb);
    expect(rgb(REF.finite - 1)).toEqual(REF.last.rgb);
  });

  it('drops the NaN cells and says so, rather than plotting them at the origin', () => {
    let atOrigin = 0;
    let nonFinite = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < cloud.pointCount; i++) {
      const p = world(i);
      if (!p.every(Number.isFinite)) nonFinite++;
      if (Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9 && Math.abs(p[2]) < 1e-9) atOrigin++;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
    expect(nonFinite).toBe(0);
    expect(atOrigin).toBe(0);
    for (let k = 0; k < 3; k++) {
      expect(min[k]).toBeCloseTo(REF.min[k], 6);
      expect(max[k]).toBeCloseTo(REF.max[k], 6);
    }
    expect(cloud.metadata?.loadWarnings).toContainEqual(expect.stringContaining('Excluded 97,920 of 307,200 points'));
  });

  it('reports the VIEWPOINT as a pose with the scalar first, and leaves the points unrotated', () => {
    const pose = cloud.organizedRange?.frames[0].acquisitionPose;
    expect(pose?.worldTranslation).toEqual([0, 0, 0]);
    // qw qx qy qz = 0 1 0 0: a half turn about x. Read in x y z w order by
    // mistake, the same four numbers would be a half turn about y.
    expect(pose?.rotation).toEqual({ w: 0, x: 1, y: 0, z: 0 });
    expect(pose?.rotationSource).toBe('source-declared');
    expect(cloud.acquisitionStations?.stations).toHaveLength(1);
    // Applying the half turn would negate y and z; the stored values stand.
    expect(world(0)[1]).toBeCloseTo(REF.first.xyz[1], 6);
    expect(world(0)[2]).toBeCloseTo(REF.first.xyz[2], 6);
  });
});
