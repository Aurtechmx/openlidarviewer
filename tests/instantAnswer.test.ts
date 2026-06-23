/**
 * instantAnswer.test.ts — the drop → instant-analysis routing policy.
 */

import { describe, it, expect } from 'vitest';
import { planInstantAnswer } from '../src/intelligence/instantAnswer';

describe('planInstantAnswer', () => {
  it('a second scan offers the before/after compare, naming both scans', () => {
    const a = planInstantAnswer({
      cloudCount: 2,
      scanShape: 'terrain',
      scanLabel: 'after.las',
      priorScanLabel: 'before.las',
    });
    expect(a.action).toBe('compare');
    expect(a.message).toContain('before.las');
    expect(a.message).toContain('after.las');
  });

  it('compare wins regardless of the new scan shape', () => {
    for (const shape of ['terrain', 'object', 'interior', null] as const) {
      expect(planInstantAnswer({ cloudCount: 2, scanShape: shape }).action).toBe('compare');
    }
  });

  it('a single terrain scan offers terrain analysis', () => {
    const a = planInstantAnswer({ cloudCount: 1, scanShape: 'terrain' });
    expect(a.action).toBe('terrain');
    expect(a.actionLabel).toMatch(/terrain/i);
  });

  it('a single object scan offers volume', () => {
    expect(planInstantAnswer({ cloudCount: 1, scanShape: 'object' }).action).toBe('volume');
  });

  it('a single interior scan offers the floor plan', () => {
    expect(planInstantAnswer({ cloudCount: 1, scanShape: 'interior' }).action).toBe('floorplan');
  });

  it('an undecidable shape falls back to terrain', () => {
    expect(planInstantAnswer({ cloudCount: 1, scanShape: null }).action).toBe('terrain');
  });

  it('every answer carries the no-upload promise', () => {
    const cases: Parameters<typeof planInstantAnswer>[0][] = [
      { cloudCount: 1, scanShape: 'terrain' },
      { cloudCount: 1, scanShape: 'object' },
      { cloudCount: 1, scanShape: 'interior' },
      { cloudCount: 2, scanShape: 'terrain' },
    ];
    for (const c of cases) {
      expect(planInstantAnswer(c).message.toLowerCase()).toMatch(/nothing (uploaded|leaves)/);
    }
  });
});
