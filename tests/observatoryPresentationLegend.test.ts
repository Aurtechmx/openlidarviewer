import { describe, expect, it } from 'vitest';

import { OBSERVATION_STATES } from '../src/observation/types';
import {
  BOUNDED_UNIT_RANGE,
  fixedRangeFor,
  formatProbeText,
  observationStateLegend,
  OBSERVATION_STATE_GLYPH,
  OBSERVATION_STATE_LABEL,
  STRENGTH_COMPONENT_IDS,
} from '../src/observation/presentationLegend';

describe('OB-PR-01/04 — presentation legend', () => {
  it('lists every ObservationState, including ones with zero voxels — none omitted', () => {
    const legend = observationStateLegend();
    expect(legend.map((e) => e.state)).toEqual(OBSERVATION_STATES);
  });

  it('gives every state a distinct glyph — colour is never the only carrier (OB-PR-04)', () => {
    const glyphs = OBSERVATION_STATES.map((s) => OBSERVATION_STATE_GLYPH[s]);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('gives every state a distinct, non-empty label', () => {
    const labels = OBSERVATION_STATES.map((s) => OBSERVATION_STATE_LABEL[s]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
  });

  it('gives every legend entry an in-range RGB triple', () => {
    for (const entry of observationStateLegend()) {
      for (const channel of entry.rgb) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('OB-PR-05 — fixed ranges for bounded quantities', () => {
  it('categorical observationState carries no range at all', () => {
    expect(fixedRangeFor('observationState')).toBeNull();
  });

  it('observationStrength and observationHitFraction are fixed to [0, 1], never adaptive', () => {
    expect(fixedRangeFor('observationStrength')).toEqual(BOUNDED_UNIT_RANGE);
    expect(fixedRangeFor('observationHitFraction')).toEqual(BOUNDED_UNIT_RANGE);
    expect(BOUNDED_UNIT_RANGE).toEqual({ min: 0, max: 1 });
  });

  it('names all five SPEC §2.5 strength components', () => {
    expect(STRENGTH_COMPONENT_IDS).toEqual(['sources', 'angularSpread', 'incidence', 'rangeFit', 'consistency']);
  });
});

describe('OB-UI-03 — voxel probe text', () => {
  it('prints state, rule, one line per source, method and basis, in that order', () => {
    const text = formatProbeText({
      decision: { state: 'SHADOWED', ruleId: 'SHADOWED', detail: 'no hit or pass from any source; behind-evidence from 3 of 4' },
      perSource: [
        { sourceIndex: 0, hit: 0, pass: 0, behind: 212, nearestBlockerMetres: 12.42 },
        { sourceIndex: 1, hit: 0, pass: 0, behind: 0, nearestBlockerMetres: null },
      ],
      methodTag: 'olv.observation.states@1',
      basis: 'measured',
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('State: SHADOWED');
    expect(lines[1]).toBe('Rule: no hit or pass from any source; behind-evidence from 3 of 4');
    expect(lines[2]).toBe('Station 1  hit 0  pass 0  behind 212   nearest blocker 12.42 m');
    expect(lines[3]).toBe('Station 2  hit 0  pass 0  behind 0   nearest blocker n/a');
    expect(lines[4]).toBe('Method: olv.observation.states@1');
    expect(lines[5]).toBe('Basis: measured');
  });
});
