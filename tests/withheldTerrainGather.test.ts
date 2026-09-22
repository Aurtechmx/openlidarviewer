/**
 * withheldTerrainGather.test.ts: the terrain gather applies the Withheld policy.
 *
 * Three properties are pinned. The stride walk drops Withheld points without
 * moving which candidates it samples, so turning the policy on can only remove
 * points, never swap one sampled point for another. The DTM built through the
 * real terrain path gathers 5 class-2 returns from the fixture instead of 8. And
 * the product says what happened: excluded, not excluded, or unknowable
 * because the cloud carried no flags channel.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseBuffer } from '../src/io/parseBuffer';
import { sampleStridedTerrain, type TerrainStreamBuffer } from '../src/render/terrainStreamSample';
import { computeTerrainCore } from '../src/terrain/contour/analyseContours';
import { paramsKey } from '../src/terrain/contour/terrainCoreCache';
import { terrainDtmToFlowGrid } from '../src/simulation/flowPulse/dtmFlowGrid';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const WITHHELD = 0b0100;

async function fixture() {
  const bytes = readFileSync(join(FIXTURES, 'withheld-flags.las'));
  const { cloud } = await parseBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    'las',
    'withheld-flags.las',
  );
  return cloud;
}

/** A buffer whose x coordinate is the point's global index, so the sample names its sources. */
function indexed(n: number, start: number, flags?: Uint8Array): TerrainStreamBuffer {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = start + i;
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = 0;
  }
  return flags ? { pos, flags } : { pos };
}

function sampledIndices(positions: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < positions.length; i += 3) out.push(positions[i]);
  return out;
}

describe('stride invariance', () => {
  it('samples the same candidates with and without the policy, minus the Withheld ones', () => {
    // 1000 points over two buffers, stride 7. Withheld marks sit on sampled
    // candidates and between them, so a walk that skipped the counter on an
    // excluded point would shift every later candidate by one.
    const n1 = 400, n2 = 600;
    const f1 = new Uint8Array(n1), f2 = new Uint8Array(n2);
    const withheldIdx = new Set<number>();
    for (let g = 0; g < n1 + n2; g++) {
      if (g % 5 === 0 || g % 13 === 3) {
        withheldIdx.add(g);
        if (g < n1) f1[g] = WITHHELD; else f2[g - n1] = WITHHELD;
      }
    }
    const bufs = [indexed(n1, 0, f1), indexed(n2, n1, f2)];
    const total = n1 + n2;
    const maxPoints = Math.ceil(total / 7);

    const kept = sampleStridedTerrain(bufs, [], total, maxPoints, false, { includeWithheld: true });
    const applied = sampleStridedTerrain(bufs, [], total, maxPoints, false);
    expect(kept && applied).toBeTruthy();

    const before = sampledIndices(kept!.positions);
    const after = sampledIndices(applied!.positions);
    const expected = before.filter((g) => !withheldIdx.has(g));
    expect(after).toEqual(expected);
    expect(applied!.withheldExcludedCount).toBe(before.length - after.length);
    expect(applied!.withheldExcludedCount).toBeGreaterThan(0);
  });
});

describe('declaring the outcome', () => {
  it('is true when the policy ran over a flags channel', () => {
    const s = sampleStridedTerrain([indexed(10, 0, new Uint8Array(10))], [], 10, 10, false);
    expect(s!.withheldExcluded).toBe(true);
    expect(s!.withheldExcludedCount).toBe(0);
  });

  it('is null when a contributing cloud has no flags channel', () => {
    const s = sampleStridedTerrain(
      [indexed(10, 0, new Uint8Array(10)), indexed(10, 10)], [], 20, 20, false,
    );
    expect(s!.withheldExcluded).toBeNull();
  });

  it('is false only when the caller opted out', () => {
    const f = new Uint8Array(10).fill(WITHHELD);
    const s = sampleStridedTerrain([indexed(10, 0, f)], [], 10, 10, false, { includeWithheld: true });
    expect(s!.withheldExcluded).toBe(false);
    expect(s!.positions.length).toBe(30);
  });
});

describe('the fixture through the real terrain path', () => {
  async function core(includeWithheld: boolean) {
    const cloud = await fixture();
    const sample = sampleStridedTerrain(
      [{ pos: cloud.positions, cls: cloud.classification, flags: cloud.classificationFlags }],
      [], cloud.pointCount, 300_000, true, { includeWithheld },
    )!;
    const params = {
      cellSizeM: 1,
      classification: sample.classification,
      withheldExcluded: sample.withheldExcluded,
      withheldExcludedCount: sample.withheldExcludedCount,
    };
    return { sample, core: computeTerrainCore(sample.positions, params), params };
  }

  const groundReturns = (counts: Uint32Array): number => counts.reduce((a, b) => a + b, 0);

  it('gathers 5 class-2 ground returns under the policy and 8 without it', async () => {
    const on = await core(false);
    const off = await core(true);
    const class2 = (c: Uint8Array | undefined) => Array.from(c ?? []).filter((v) => v === 2).length;
    expect(class2(on.sample.classification)).toBe(5);
    expect(class2(off.sample.classification)).toBe(8);
    // The DTM also reads the two unclassified (class 1) returns, which the
    // core keeps; the building returns are dropped by class. The difference
    // between the two surfaces is exactly the three Withheld ground returns.
    expect(groundReturns(on.core.dtm.counts)).toBe(7);
    expect(groundReturns(off.core.dtm.counts)).toBe(10);
  });

  it('stamps the DTM and the flow basis with what was excluded', async () => {
    const on = await core(false);
    expect(on.core.dtm.withheldExcluded).toBe(true);
    expect(on.core.dtm.withheldExcludedCount).toBe(3);
    const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
    expect(terrainDtmToFlowGrid(on.core.dtm, scale).basis.withheldExcluded).toBe(true);
    // An explicit caller declaration still wins over the stamp.
    expect(terrainDtmToFlowGrid(on.core.dtm, scale, { withheldExcluded: false }).basis.withheldExcluded)
      .toBe(false);
  });

  it('keys the core cache on the outcome', async () => {
    const on = await core(false);
    const off = await core(true);
    expect(paramsKey(on.params)).not.toBe(paramsKey(off.params));
  });

  it('opting out reproduces the unfiltered gather byte for byte', async () => {
    const cloud = await fixture();
    const off = await core(true);
    const legacy = sampleStridedTerrain(
      [{ pos: cloud.positions, cls: cloud.classification }], [], cloud.pointCount, 300_000, true,
    )!;
    expect(Buffer.from(off.sample.positions.buffer)).toEqual(Buffer.from(legacy.positions.buffer));
    expect(Array.from(off.sample.classification!)).toEqual(Array.from(legacy.classification!));
    const plain = computeTerrainCore(legacy.positions, { cellSizeM: 1, classification: legacy.classification });
    expect(Buffer.from(off.core.dtm.z.buffer)).toEqual(Buffer.from(plain.dtm.z.buffer));
    expect(Array.from(off.core.dtm.counts)).toEqual(Array.from(plain.dtm.counts));
  });
});
