/**
 * fieldSimulationRunRecord.test.ts: the digest means "same computation".
 *
 * A run record's digest is quoted in an export and compared later, so the two
 * ways it can be wrong are both worth pinning:
 *
 *   it changes when nothing about the science did, which makes it useless for
 *   showing that two runs agree;
 *
 *   it stays the same when something about the science did, which makes it a
 *   false assurance.
 *
 * The first is why `id` and `generatedAt` are excluded. The second is checked
 * field by field below, because an omission from `digestibleFields` produces
 * exactly that failure and produces it silently.
 */
import { describe, expect, it } from 'vitest';

import {
  digestibleFields,
  parameterDigest,
  runRecordDigest,
  sameComputation,
  sealRunRecord,
  type FieldSimulationRunRecord,
} from '../src/simulation/simulationRunRecord';
import { simulationInputBasis } from '../src/simulation/simulationInputBasis';

const basis = simulationInputBasis({
  coverage: 'full',
  withheldExcluded: true,
  horizontalScaleResolved: true,
  measuredCells: 100,
  totalCells: 100,
});

const base: Omit<FieldSimulationRunRecord, 'digest'> = {
  schemaVersion: 1,
  id: 'run-0001',
  generatedAt: '2026-09-22T00:00:00.000Z',
  build: '0.7.0-alpha.1',
  kind: 'terrain-flow',
  source: {
    layerId: 'layer-a',
    filename: 'site.laz',
    sourceDigest: 'aaaa',
    analysisInputDigest: 'bbbb',
    basis,
  },
  model: { id: 'olv.simulation.terrain-flow.d8', version: 1 },
  methods: ['olv.simulation.terrain-flow.d8', 'olv.simulation.terrain-flow.accumulation'],
  parameters: { conditioning: 'raw', routing: 'd8' },
  result: { sinkCount: 3, outletCount: 12 },
  limitations: ['Cell counts only; contributing area withheld.'],
  processingManifestHead: 'cccc',
};

describe('the digest ignores what is not the computation', () => {
  it('is unchanged by the run id', () => {
    expect(runRecordDigest({ ...base, id: 'run-9999' })).toBe(runRecordDigest(base));
  });

  it('is unchanged by the wall clock', () => {
    expect(runRecordDigest({ ...base, generatedAt: '2030-01-01T12:34:56.000Z' }))
      .toBe(runRecordDigest(base));
  });

  it('lets a saved configuration re-run and be recognised as the same', () => {
    const first = sealRunRecord(base);
    const later = sealRunRecord({ ...base, id: 'run-0002', generatedAt: '2027-05-05T00:00:00.000Z' });
    expect(sameComputation(first, later)).toBe(true);
  });
});

describe('the digest covers everything that is the computation', () => {
  // Each mutation changes something a reader would consider scientific. If
  // any of these leaves the digest alone, that field fell out of
  // `digestibleFields` and the record silently stopped covering it.
  const mutations: readonly [string, Omit<FieldSimulationRunRecord, 'digest'>][] = [
    ['kind', { ...base, kind: 'terrain-access' }],
    ['build', { ...base, build: '0.7.0-alpha.2' }],
    ['model version', { ...base, model: { ...base.model, version: 2 } }],
    ['model id', { ...base, model: { ...base.model, id: 'olv.simulation.terrain-flow.accumulation' } }],
    ['methods', { ...base, methods: ['olv.simulation.terrain-flow.d8'] }],
    ['parameters', { ...base, parameters: { conditioning: 'priority-flood', routing: 'd8' } }],
    ['result', { ...base, result: { sinkCount: 4, outletCount: 12 } }],
    ['limitations', { ...base, limitations: [] }],
    ['analysis input digest', {
      ...base, source: { ...base.source, analysisInputDigest: 'dddd' },
    }],
    ['source digest', { ...base, source: { ...base.source, sourceDigest: 'eeee' } }],
    ['manifest head', { ...base, processingManifestHead: 'ffff' }],
    ['basis coverage', {
      ...base,
      source: {
        ...base.source,
        basis: simulationInputBasis({
          coverage: 'resident-only', withheldExcluded: true,
          horizontalScaleResolved: true, measuredCells: 100, totalCells: 100,
        }),
      },
    }],
    ['basis withheld handling', {
      ...base,
      source: {
        ...base.source,
        basis: simulationInputBasis({
          coverage: 'full', withheldExcluded: false,
          horizontalScaleResolved: true, measuredCells: 100, totalCells: 100,
        }),
      },
    }],
  ];

  it.each(mutations)('changes when %s changes', (_name, mutated) => {
    expect(runRecordDigest(mutated)).not.toBe(runRecordDigest(base));
  });
});

describe('the omissions are stated rather than implied', () => {
  it('leaves id and generatedAt out of the digested fields', () => {
    const fields = digestibleFields(base);
    expect(Object.keys(fields)).not.toContain('id');
    expect(Object.keys(fields)).not.toContain('generatedAt');
  });

  it('keeps the basis, which is the part a reader is most likely to drop', () => {
    const fields = digestibleFields(base) as { source: { basis: unknown } };
    expect(fields.source.basis).toEqual(basis);
  });
});

describe('the digest is a SHA-256, not a short fingerprint', () => {
  it('is 64 lowercase hex characters', () => {
    // The 32-bit FNV fingerprint in `src/canonicalHash.ts` is eight. This is a
    // persisted scientific identity and is compared across exports, so the
    // width is part of what it promises.
    expect(sealRunRecord(base).digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different parameter sets different digests', () => {
    expect(parameterDigest({ a: 1 })).not.toBe(parameterDigest({ a: 2 }));
  });

  it('does not depend on the order keys were written in', () => {
    expect(parameterDigest({ a: 1, b: 2 })).toBe(parameterDigest({ b: 2, a: 1 }));
  });
});

describe('sealing', () => {
  it('computes the digest rather than trusting one passed in', () => {
    const sealed = sealRunRecord(base);
    expect(sealed.digest).toBe(runRecordDigest(base));
  });
});
