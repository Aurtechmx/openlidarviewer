/**
 * candidateReview.test.ts
 *
 * The review state over extracted candidates. The load-bearing property is that
 * a judgment SURVIVES a re-extraction and re-attaches to the thing it was made
 * about — which only works because candidate ids are derived from geometry
 * rather than list position. The re-run tests below are what would have failed
 * under the old index-based ids, so they pin the pair together.
 */

import { describe, it, expect } from 'vitest';
import {
  CandidateReviewStore,
  DEFAULT_STATUS,
  type CandidateStatus,
} from '../src/features/candidateReview';
import { extractBuildingCandidates } from '../src/features/FeatureExtractionService';
import type { BuildingPoint } from '../src/features/buildingFootprints';
import { knownUnit } from '../src/units/units';

const METRE = knownUnit(1);
const GRID = { originX: 0, originY: 0, cellSizeM: 1, minPointsPerCell: 1, minAreaM2: 4 };

function block(ox = 0, oy = 0, n = 10): BuildingPoint[] {
  const pts: BuildingPoint[] = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) pts.push({ x: ox + x, y: oy + y });
  return pts;
}
const idc = (id: string) => ({ id });

describe('CandidateReviewStore — decisions', () => {
  it('everything starts pending, and an unknown id is pending too', () => {
    const s = new CandidateReviewStore();
    expect(s.statusOf('nobody')).toBe(DEFAULT_STATUS);
    expect(DEFAULT_STATUS).toBe('review');
  });

  it('accept and reject are recorded and readable', () => {
    const s = new CandidateReviewStore();
    expect(s.accept('a')).toBe('accepted');
    expect(s.reject('b')).toBe('rejected');
    expect(s.statusOf('a')).toBe('accepted');
    expect(s.statusOf('b')).toBe('rejected');
  });

  it('reset returns a candidate to pending and forgets the decision', () => {
    const s = new CandidateReviewStore();
    s.accept('a');
    expect(s.reset('a')).toBe('review');
    expect(s.statusOf('a')).toBe('review');
    expect(s.decisions().has('a')).toBe(false);
  });

  it('a decision can be changed', () => {
    const s = new CandidateReviewStore();
    s.accept('a');
    s.reject('a');
    expect(s.statusOf('a')).toBe('rejected');
  });

  it('only real decisions are stored — pending is the absence of one', () => {
    const s = new CandidateReviewStore();
    s.accept('a');
    expect([...s.decisions().keys()]).toEqual(['a']);
  });
});

describe('CandidateReviewStore — joining onto a candidate set', () => {
  const cands = [idc('x'), idc('y'), idc('z')];

  it('apply pairs each candidate with its standing decision, in extraction order', () => {
    const s = new CandidateReviewStore();
    s.accept('y');
    const rows = s.apply(cands);
    expect(rows.map((r) => r.candidate.id)).toEqual(['x', 'y', 'z']);
    expect(rows.map((r) => r.status)).toEqual(['review', 'accepted', 'review']);
  });

  it('accepted() is what a deliverable would ship', () => {
    const s = new CandidateReviewStore();
    s.accept('x');
    s.reject('y');
    expect(s.accepted(cands).map((c) => c.id)).toEqual(['x']);
  });

  it('summarise counts the set and reports completeness', () => {
    const s = new CandidateReviewStore();
    expect(s.summarise(cands)).toEqual({
      total: 3, accepted: 0, rejected: 0, pending: 3, complete: false,
    });
    s.accept('x'); s.reject('y'); s.accept('z');
    expect(s.summarise(cands)).toEqual({
      total: 3, accepted: 2, rejected: 1, pending: 0, complete: true,
    });
  });

  it('summarise ignores decisions about candidates outside the set', () => {
    const s = new CandidateReviewStore();
    s.accept('not-in-this-set');
    expect(s.summarise(cands).accepted).toBe(0);
    expect(s.summarise(cands).pending).toBe(3);
  });
});

describe('CandidateReviewStore — surviving a re-extraction', () => {
  it('a judgment re-attaches to the SAME building after a re-run', () => {
    const s = new CandidateReviewStore();
    const first = extractBuildingCandidates(block(), GRID, METRE);
    s.accept(first[0].id);

    // Re-run over the same data: fresh objects, same geometry.
    const second = extractBuildingCandidates(block(), GRID, METRE);
    expect(second[0]).not.toBe(first[0]);
    expect(s.statusOf(second[0].id)).toBe('accepted');
  });

  it('a judgment follows its own building when a larger one REORDERS the list', () => {
    // This is the case index-based ids got wrong: the accept would slide onto
    // whichever building happened to take the old position.
    const s = new CandidateReviewStore();
    const small = block(0, 0, 6);
    const before = extractBuildingCandidates(small, GRID, METRE);
    s.accept(before[0].id);

    const after = extractBuildingCandidates([...small, ...block(40, 40, 14)], GRID, METRE);
    expect(after[0].areaSource).toBeGreaterThan(after[1].areaSource); // reordered
    const rows = s.apply(after);
    const acceptedIds = rows.filter((r) => r.status === 'accepted').map((r) => r.candidate.id);
    // Exactly one accept, and it is still the SMALL building.
    expect(acceptedIds).toEqual([before[0].id]);
    // The newly-appeared larger building is untouched.
    expect(rows.find((r) => r.candidate.id !== before[0].id)!.status).toBe('review');
  });

  it('a decision is KEPT for a candidate a later run does not produce', () => {
    const s = new CandidateReviewStore();
    const seen = extractBuildingCandidates(block(), GRID, METRE);
    s.reject(seen[0].id);
    // A run that finds nothing must not erase the judgment...
    expect(s.summarise([]).total).toBe(0);
    // ...so when the candidate reappears it is still rejected.
    const again = extractBuildingCandidates(block(), GRID, METRE);
    expect(s.statusOf(again[0].id)).toBe('rejected');
  });
});

describe('CandidateReviewStore — persistence', () => {
  it('decisions round-trip through restore', () => {
    const s = new CandidateReviewStore();
    s.accept('a'); s.reject('b');
    const saved = [...s.decisions()];

    const restored = new CandidateReviewStore();
    restored.restore(saved);
    expect(restored.statusOf('a')).toBe('accepted');
    expect(restored.statusOf('b')).toBe('rejected');
  });

  it('restore REPLACES, and never stores a pending entry', () => {
    const s = new CandidateReviewStore();
    s.accept('old');
    s.restore([['new', 'accepted'], ['idle', DEFAULT_STATUS as CandidateStatus]]);
    expect(s.statusOf('old')).toBe('review'); // replaced, not merged
    expect(s.statusOf('new')).toBe('accepted');
    expect(s.decisions().has('idle')).toBe(false); // pending is not a decision
  });

  it('clear drops everything', () => {
    const s = new CandidateReviewStore();
    s.accept('a');
    s.clear();
    expect(s.decisions().size).toBe(0);
  });
});
