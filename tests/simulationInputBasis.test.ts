/**
 * simulationInputBasis.test.ts: a run says what it read, or says it cannot.
 *
 * These assertions are about refusals rather than numbers. The failure they
 * exist to catch is the quiet one: a simulation that ran on a streamed subset,
 * or on a DTM that counted points the producer marked as not-to-be-used, and
 * reported a figure that reads exactly like one computed over the whole
 * survey.
 *
 * The Withheld tristate gets the most attention because it is the field most
 * likely to be "simplified" later. Today no module in `src/` calls the
 * Withheld policy, so no input can honestly claim the exclusion was applied,
 * and the undeclared case is the normal one rather than an edge case.
 */
import { describe, expect, it } from 'vitest';

import {
  basisLimitations,
  mayReportMetricArea,
  simulationInputBasis,
} from '../src/simulation/simulationInputBasis';

const full = {
  coverage: 'full' as const,
  horizontalScaleResolved: true,
  measuredCells: 100,
  totalCells: 100,
};

describe('completeness comes from coverage, not from a separate claim', () => {
  it('calls only a full walk complete', () => {
    expect(simulationInputBasis(full).complete).toBe(true);
    expect(simulationInputBasis({ ...full, coverage: 'resident-only' }).complete).toBe(false);
    expect(simulationInputBasis({ ...full, coverage: 'sampled' }).complete).toBe(false);
  });

  it('says so when the terrain came from the resident subset', () => {
    const limits = basisLimitations(simulationInputBasis({ ...full, coverage: 'resident-only' }));
    expect(limits.join(' ')).toMatch(/resident streamed subset/);
  });

  it('distinguishes a sample from a resident subset, rather than merging them', () => {
    const sampled = basisLimitations(simulationInputBasis({ ...full, coverage: 'sampled' }));
    expect(sampled.join(' ')).toMatch(/sample of the source/);
    expect(sampled.join(' ')).not.toMatch(/resident/);
  });
});

describe('Withheld is a tristate, and undeclared is not "no"', () => {
  it('defaults to undeclared when the caller says nothing', () => {
    expect(simulationInputBasis(full).withheldExcluded).toBeNull();
  });

  it('reports undeclared as a limitation the reader sees', () => {
    const limits = basisLimitations(simulationInputBasis(full));
    expect(limits.join(' ')).toMatch(/not recorded/);
  });

  it('reports a declared inclusion in plain terms', () => {
    const limits = basisLimitations(simulationInputBasis({ ...full, withheldExcluded: false }));
    expect(limits.join(' ')).toMatch(/read as ordinary returns/);
  });

  it('says nothing about Withheld once the exclusion is declared', () => {
    const limits = basisLimitations(simulationInputBasis({ ...full, withheldExcluded: true }));
    expect(limits.join(' ')).not.toMatch(/Withheld/);
  });

  it('never silently turns undeclared into excluded', () => {
    // The lie in the dangerous direction: a run that claims the producer's
    // rejected points were left out when nothing checked.
    for (const declared of [undefined, null]) {
      const basis = simulationInputBasis({ ...full, withheldExcluded: declared });
      expect(basis.withheldExcluded).not.toBe(true);
    }
  });
});

describe('an unresolved horizontal scale withholds metric figures', () => {
  it('refuses square metres, and says why', () => {
    const basis = simulationInputBasis({ ...full, horizontalScaleResolved: false });
    expect(mayReportMetricArea(basis)).toBe(false);
    expect(basisLimitations(basis).join(' ')).toMatch(/withheld/);
  });

  it('allows them when the scale is known', () => {
    expect(mayReportMetricArea(simulationInputBasis(full))).toBe(true);
  });
});

describe('cells with no elevation are counted and disclosed', () => {
  it('names the shortfall rather than reporting a full grid', () => {
    const basis = simulationInputBasis({ ...full, measuredCells: 70 });
    expect(basisLimitations(basis).join(' ')).toMatch(/30 of 100 cells carry no elevation/);
  });

  it('says nothing about missing cells when every cell carries an elevation', () => {
    // Not an empty list: an input that has not declared its Withheld handling
    // still owes the reader that sentence, and today none of them has.
    expect(basisLimitations(simulationInputBasis(full)).join(' '))
      .not.toMatch(/carry no elevation/);
  });

  it('falls silent only when the basis has nothing left to disclose', () => {
    const clean = simulationInputBasis({ ...full, withheldExcluded: true });
    expect(basisLimitations(clean)).toEqual([]);
  });
});
