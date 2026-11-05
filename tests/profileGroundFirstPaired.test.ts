/**
 * The paired injection-recovery test of the profile's ground-first rule, run
 * through the app's sampler on the committed fixtures. The protocol is
 * validation/protocols/profile-ground-first-paired-v1.md, with the outcome in
 * profile-ground-first-paired-v1-result.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILE_SERIES_METHOD_TAG } from '../src/render/measure/profileSampler';
import { LABEL_SETS, PAIRED_DIR, pairedDecision, pairedTable, RULES, type PairedTable, type Rule } from './support/profilePaired';

const recorded = JSON.parse(readFileSync(join(PAIRED_DIR, 'results.json'), 'utf8')) as {
  table: PairedTable;
  decision: { rule: Rule };
};
const table = pairedTable();

describe('profile ground-first rule, paired test', () => {
  it('reproduces the recorded figures', () => {
    for (const [bg, bySet] of Object.entries(recorded.table)) {
      for (const set of LABEL_SETS) {
        for (const rule of RULES) {
          const want = bySet[set][rule];
          const got = table[bg]![set][rule];
          expect(got.E, `${bg} ${set} ${rule} E`).toBeCloseTo(want.E, 9);
          expect(got.G, `${bg} ${set} ${rule} G`).toBeCloseTo(want.G, 9);
          expect(got.H, `${bg} ${set} ${rule} H`).toBeCloseTo(want.H, 9);
          expect(got.emptyStations).toBe(want.emptyStations);
        }
      }
    }
  });

  it('gives the same series under both rules when non-ground is classified (the control)', () => {
    for (const bySet of Object.values(table)) {
      expect(bySet.classified['ground-first']).toEqual(bySet.classified['all-returns']);
    }
  });

  it('a filter costs more on flat ground than on the 30 % slope, for the ground-first rule', () => {
    const cost = (bg: string): number => table[bg]!.filter['ground-first'].E - table[bg]!.classified['ground-first'].E;
    expect(cost('flat')).toBeGreaterThan(cost('rampx30') + 0.05);
  });

  it('reproduces the protocol\'s outcome, and the app keeps the all-returns rule', () => {
    expect(pairedDecision(table).rule).toBe(recorded.decision.rule);
    expect(PROFILE_SERIES_METHOD_TAG).toBe('olv.profile.corridor-percentile@2');
  });
});
