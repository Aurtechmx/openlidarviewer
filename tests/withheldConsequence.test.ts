/**
 * withheldConsequence.test.ts: what the Withheld policy would actually cost.
 *
 * Ledger entry L26 records the Withheld policy as written and its consequence
 * as unmeasured, for a concrete reason: every LAS fixture in this repository
 * left the flag byte at zero, so excluding Withheld points changed no number
 * anywhere and no test could show what the exclusion spares or costs.
 *
 * `tests/fixtures/withheld-flags.las` is the file that makes the question
 * answerable. This measures the answer on it. It does NOT apply the policy to
 * terrain, density or stockpile: those carry recorded evidence, and moving
 * their numbers is a separate change with its own before-and-after. What is
 * pinned here is the size and shape of the exclusion, so that change can be
 * made against a known quantity rather than a guess.
 *
 * The distinction that matters most is Withheld against Overlap. A producer
 * commonly sets Withheld on overlap points culled during flight-line merging,
 * so the two arrive together and are easy to conflate. Excluding Overlap would
 * thin every seam in a survey, which is why the policy never touches it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeExtendedClassificationFlags } from '../src/lasSemantics';
import {
  excludesWithheld,
  isWithheld,
  pointIsReadable,
  withheldCount,
  withheldTreatment,
} from '../src/science/withheldPolicy';
import { parseBuffer } from '../src/io/parseBuffer';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The fixture, decoded through the real reader rather than a hand parse. */
async function fixture() {
  const bytes = readFileSync(join(FIXTURES, 'withheld-flags.las'));
  const { cloud } = await parseBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    'las',
    'withheld-flags.las',
  );
  return cloud;
}

describe('the flags survive decoding', () => {
  it('carries the producer marks the file was written with', async () => {
    // The generator wrote 3 withheld, 2 overlap, 1 synthetic, 1 key point.
    // If the decoder dropped the byte, every assertion below would pass
    // vacuously on a field of zeros, so the counts are checked first.
    const cloud = await fixture();
    const flags = cloud.classificationFlags;
    expect(flags, 'the decoder produced no classification flags').toBeTruthy();
    const f = flags as Uint8Array;
    expect(f).toHaveLength(cloud.pointCount);

    let withheld = 0, overlap = 0, synthetic = 0, key = 0;
    for (let i = 0; i < f.length; i++) {
      const d = decodeExtendedClassificationFlags(f[i]);
      if (d.withheld) withheld++;
      if (d.overlap) overlap++;
      if (d.synthetic) synthetic++;
      if (d.keyPoint) key++;
    }
    expect({ withheld, overlap, synthetic, key }).toEqual({
      withheld: 3, overlap: 2, synthetic: 1, key: 1,
    });
  });
});

describe('the size of the exclusion, measured', () => {
  it('scientific processing would leave out three of twelve points', async () => {
    const cloud = await fixture();
    const f = cloud.classificationFlags as Uint8Array;
    expect(withheldCount(f, 'scientific-processing')).toBe(3);
    expect(cloud.pointCount).toBe(12);
  });

  it('and three of the eight ground returns, which is what a DTM reads', async () => {
    // The figure that matters for terrain: the exclusion is not spread evenly
    // over the file, it lands entirely on ground. A DTM built from this scan
    // would fit through 5 measured returns under the policy and 8 without it.
    const cloud = await fixture();
    const f = cloud.classificationFlags as Uint8Array;
    const cls = cloud.classification as Uint8Array;
    let ground = 0, groundWithheld = 0;
    for (let i = 0; i < cls.length; i++) {
      if (cls[i] !== 2) continue;
      ground++;
      if (isWithheld(f[i])) groundWithheld++;
    }
    expect({ ground, groundWithheld }).toEqual({ ground: 8, groundWithheld: 3 });
  });

  it('raw inspection and source export leave out nothing', async () => {
    const cloud = await fixture();
    const f = cloud.classificationFlags as Uint8Array;
    expect(withheldCount(f, 'raw-inspection')).toBe(0);
    expect(withheldCount(f, 'source-export')).toBe(0);
    expect(withheldTreatment('source-export')).toBe('preserve');
    expect(withheldTreatment('raw-inspection')).toBe('preserve');
  });

  it('an auditor asking for them back gets the whole file', async () => {
    const cloud = await fixture();
    const f = cloud.classificationFlags as Uint8Array;
    expect(withheldCount(f, 'scientific-processing', true)).toBe(0);
    expect(excludesWithheld('scientific-processing', true)).toBe(false);
  });
});

describe('Overlap is not Withheld', () => {
  it('reads an overlap-only point despite the exclusion being on', async () => {
    // Dropping overlap globally would thin every flight-line seam in a survey,
    // which is a change to density in exactly the strips where two passes
    // agree. The fixture carries one overlap point with no Withheld mark.
    const cloud = await fixture();
    const f = cloud.classificationFlags as Uint8Array;
    const overlapOnly: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const d = decodeExtendedClassificationFlags(f[i]);
      if (d.overlap && !d.withheld) overlapOnly.push(i);
    }
    expect(overlapOnly).toHaveLength(1);
    for (const i of overlapOnly) {
      expect(pointIsReadable(f[i], 'scientific-processing')).toBe(true);
    }
  });

  it('still excludes a point carrying both marks, for the Withheld one', async () => {
    const cloud = await fixture();
    const f = cloud.classificationFlags as Uint8Array;
    const both: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const d = decodeExtendedClassificationFlags(f[i]);
      if (d.overlap && d.withheld) both.push(i);
    }
    expect(both).toHaveLength(1);
    for (const i of both) {
      expect(pointIsReadable(f[i], 'scientific-processing')).toBe(false);
    }
  });

  it('ignores Synthetic and Key-point, which it does not read', async () => {
    const cloud = await fixture();
    const f = cloud.classificationFlags as Uint8Array;
    for (let i = 0; i < f.length; i++) {
      const d = decodeExtendedClassificationFlags(f[i]);
      if ((d.synthetic || d.keyPoint) && !d.withheld) {
        expect(pointIsReadable(f[i], 'scientific-processing')).toBe(true);
      }
    }
  });
});

describe('where the policy is applied', () => {
  it('is imported under src/ by the terrain gather, the lasso volume walk, the profile walks and density alone', () => {
    // Floor-plan and routing read through the terrain gather, so they inherit
    // the exclusion without importing the policy. The lasso volume walk
    // (tests/lassoVolumeWithheld.test.ts), the profile series and workbench
    // section (tests/profileWithheld.test.ts), and the scan report's density
    // rows with the Dataset Intelligence density tier
    // (tests/scanReportWithheld.test.ts, tests/densityBasisAreal.test.ts)
    // apply it themselves. Another importer is a new product applying it,
    // which needs its own before-and-after.
    const SRC = join(FIXTURES, '..', '..', 'src');
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /from '[^']*science\/withheldPolicy'/.test(readFileSync(p, 'utf8'))) {
          importers.push(relative(join(SRC, '..'), p).split(sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(importers.sort()).toEqual([
      'src/analysis/modules/scanReport.ts',
      'src/app/inspectorCardRefreshers.ts',
      'src/render/measure/lassoVolumeCompute.ts',
      'src/render/measure/profileSampler.ts',
      'src/render/measure/profileSectionExtract.ts',
      'src/render/terrainStreamSample.ts',
    ]);
  });
});
