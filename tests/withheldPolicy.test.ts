import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { encodeExtendedClassificationFlags } from '../src/lasSemantics';
import {
  excludesWithheld,
  isWithheld,
  pointIsReadable,
  withheldCount,
  withheldTreatment,
  type ProcessingContext,
} from '../src/science/withheldPolicy';

const CONTEXTS: readonly ProcessingContext[] = [
  'raw-inspection',
  'source-export',
  'scientific-processing',
];

const flags = (over: Parameters<typeof encodeExtendedClassificationFlags>[0]) =>
  encodeExtendedClassificationFlags(over);

describe('the three contexts', () => {
  it('shows a withheld point to a person looking at the scan', () => {
    expect(withheldTreatment('raw-inspection')).toBe('preserve');
  });

  it('writes it back out with the bit intact', () => {
    expect(withheldTreatment('source-export')).toBe('preserve');
  });

  it('leaves it out of a computed product', () => {
    // A surface fitted through points the producer marked as not-to-be-used is
    // a surface nobody sanctioned.
    expect(withheldTreatment('scientific-processing')).toBe('exclude');
  });

  it('lets a caller ask for them back, but only where that means something', () => {
    expect(withheldTreatment('scientific-processing', true)).toBe('preserve');
    // A flag that could delete points from an export would be a way to lose
    // data by mistake.
    expect(withheldTreatment('source-export', true)).toBe('preserve');
    expect(withheldTreatment('raw-inspection', true)).toBe('preserve');
  });

  it('excludes in exactly one context', () => {
    const excluding = CONTEXTS.filter((c) => excludesWithheld(c));
    expect(excluding).toEqual(['scientific-processing']);
  });
});

describe('reading the bit', () => {
  it('reads the flag the encoder writes', () => {
    expect(isWithheld(flags({ withheld: true }))).toBe(true);
    expect(isWithheld(flags({ withheld: false }))).toBe(false);
  });

  it('is not confused by the other three markings', () => {
    for (const other of ['synthetic', 'keyPoint', 'overlap'] as const) {
      expect(isWithheld(flags({ [other]: true })), other).toBe(false);
      expect(isWithheld(flags({ [other]: true, withheld: true })), other).toBe(true);
    }
  });

  it('reads an unusable byte as not marked', () => {
    expect(isWithheld(Number.NaN)).toBe(false);
  });
});

describe('overlap is never excluded', () => {
  it('reads an overlap point in every context', () => {
    // Overlap marks the seam between two flight lines: the ground there was
    // measured twice, not badly. Dropping it globally would thin every seam.
    const overlap = flags({ overlap: true });
    for (const context of CONTEXTS) {
      expect(pointIsReadable(overlap, context), context).toBe(true);
    }
  });

  it('reads a synthetic or key-point point too', () => {
    for (const marking of ['synthetic', 'keyPoint'] as const) {
      expect(pointIsReadable(flags({ [marking]: true }), 'scientific-processing')).toBe(true);
    }
  });

  it('excludes an overlap point only when it is also withheld', () => {
    const both = flags({ overlap: true, withheld: true });
    expect(pointIsReadable(both, 'scientific-processing')).toBe(false);
    expect(pointIsReadable(both, 'raw-inspection')).toBe(true);
  });
});

describe('counting what would be left out', () => {
  const run = [
    flags({}),
    flags({ withheld: true }),
    flags({ overlap: true }),
    flags({ withheld: true, synthetic: true }),
  ];

  it('counts the withheld points a computation would skip', () => {
    expect(withheldCount(run)).toBe(2);
  });

  it('counts nothing in a context that excludes nothing', () => {
    expect(withheldCount(run, 'raw-inspection')).toBe(0);
    expect(withheldCount(run, 'source-export')).toBe(0);
    expect(withheldCount(run, 'scientific-processing', true)).toBe(0);
  });

  it('counts nothing without flags to read', () => {
    expect(withheldCount(null)).toBe(0);
    expect(withheldCount(undefined)).toBe(0);
    expect(withheldCount([])).toBe(0);
  });
});

describe('what the policy may not touch', () => {
  it('never reads or writes a classification code', () => {
    // The code and the flags are separate fields and stay separate: nothing
    // here maps a class to another class.
    const source = readFileSync(
      new URL('../src/science/withheldPolicy.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/classification[^F]|classCode|\bclass\b/i);
    expect(code).toMatch(/export function pointIsReadable/);
  });

  it('decodes through lasSemantics rather than testing a bit of its own', () => {
    // A format whose flags move must not leave two answers in the tree.
    const source = readFileSync(
      new URL('../src/science/withheldPolicy.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('decodeExtendedClassificationFlags');
    expect(code).not.toMatch(/0x0?4|1 << 2|& 4\b/);
  });
});

describe('the audit this policy records', () => {
  /** The directories holding the products the phase asks about. */
  const SCIENTIFIC_DIRS = ['terrain', 'analysis', 'registration', 'render/measure'];

  function filesReadingFlags(dir: string): string[] {
    const root = new URL(`../src/${dir}/`, import.meta.url);
    const out: string[] = [];
    const walk = (at: URL): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, at);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.ts')) {
          const src = readFileSync(child, 'utf8');
          if (/classificationFlags|withheldPolicy/.test(src)) out.push(`${dir}/${entry.name}`);
        }
      }
    };
    walk(root);
    return out;
  }

  it('only terrain, the volume walks, the profile walks and the scan report density consult the Withheld bit', () => {
    // This pins the audit rather than the intent. When a product starts
    // applying the policy, this fails: update the list here and record the
    // before-and-after for that product, because its numbers moved.
    //
    // `terrain/withheldAwareTerrainGather.ts` is the one exception, and it
    // moves no product's numbers by existing: it re-decodes a source at full
    // resolution and hands the result to `sampleStridedTerrain` — the SAME
    // canonical gather this suite's other file (`withheldConsequence.test.ts`)
    // confirms is the policy's one importer under `src/` — so the exclusion
    // decision is still made in exactly one place. This file reads
    // `classificationFlags` only to carry it to that gather unmodified, never
    // to test a bit of its own.
    //
    // `render/measure/lassoVolumeCompute.ts` applies the policy to the lasso
    // volume's input (tests/lassoVolumeWithheld.test.ts). The profile walks
    // apply it themselves: the series drops Withheld points before it joins
    // its buffers (profileSampler, profileSectionSeam) and the workbench
    // section skips them in its corridor walk (profileSectionExtract).
    // profileSectionBuilder only declares the flags channel's type. Their
    // before-and-after is tests/profileWithheld.test.ts. The scan report
    // (analysis/scanReport.ts) leaves Withheld points out of its density
    // count; see tests/scanReportWithheld.test.ts. The polygon Volume tool's
    // buffer assembly (render/measure/volume.ts) routes Withheld points out of
    // its cut/fill; see tests/polygonVolumeWithheld.test.ts.
    const reading = SCIENTIFIC_DIRS.flatMap(filesReadingFlags);
    expect(reading.sort()).toEqual([
      'analysis/scanReport.ts',
      'render/measure/lassoVolumeCompute.ts',
      'render/measure/profileSampler.ts',
      'render/measure/profileSectionBuilder.ts',
      'render/measure/profileSectionExtract.ts',
      'render/measure/profileSectionSeam.ts',
      'render/measure/volume.ts',
      'terrain/withheldAwareTerrainGather.ts',
    ]);
  });

  it('the bit survives the pipeline that carries it', () => {
    // Applying the policy is a matter of consulting something already there.
    for (const path of ['io/lasDecodeShared.ts', 'model/PointCloud.ts', 'convert/writeLas.ts']) {
      const src = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
      expect(src, path).toContain('classificationFlags');
    }
  });
});
