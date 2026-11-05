import { describe, it, expect } from 'vitest';
import { readinessOnBasis } from '../src/terrain/export/analysedBasis';

describe('readinessOnBasis', () => {
  it('does not state Ready on a sampled grid', () => {
    expect(readinessOnBasis('Ready', '', null, 'sampled').tier).toBe('Preview');
  });
  it('keeps Ready on a full read and leaves other tiers alone', () => {
    expect(readinessOnBasis('Ready', '', null, 'full').tier).toBe('Ready');
    expect(readinessOnBasis('Blocked', 'why', null, 'sampled')).toEqual({ tier: 'Blocked', reason: 'why' });
  });
});
