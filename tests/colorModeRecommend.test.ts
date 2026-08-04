import { describe, it, expect } from 'vitest';
import { recommendColorMode } from '../src/render/colorModeRecommend';
import { cloudSupportsColorMode } from '../src/render/colorModeSupport';

describe('recommendColorMode', () => {
  it('prefers rgb when the scan carries colour, even alongside classification', () => {
    const r = recommendColorMode({
      colors: new Uint8Array([1, 2, 3]),
      classification: new Uint8Array([2, 6]),
    });
    expect(r.mode).toBe('rgb');
    expect(r.reason).toMatch(/colour/);
  });

  it('recommends classification when present and there is no rgb', () => {
    const r = recommendColorMode({ classification: new Uint8Array([2, 6]) });
    expect(r.mode).toBe('classification');
  });

  it('recommends intensity when there is neither rgb nor classification', () => {
    const r = recommendColorMode({ intensity: new Uint16Array([10, 20]) });
    expect(r.mode).toBe('intensity');
  });

  it('falls back to a positions-only mode for a scan with no colour channel', () => {
    const r = recommendColorMode({});
    expect(['elevation', 'density']).toContain(r.mode);
  });

  it('never returns a mode the facts say is unsupported', () => {
    // Sweep a spread of attribute combinations; whatever mode comes back, the
    // support rule the recommender gates on must agree the cloud can render it.
    const facts = [
      {},
      { colors: new Uint8Array([1, 2, 3]) },
      { classification: new Uint8Array([2]) },
      { intensity: new Uint16Array([7]) },
      { classification: new Uint8Array([2]), intensity: new Uint16Array([7]) },
    ] as const;
    for (const f of facts) {
      const r = recommendColorMode(f);
      expect(cloudSupportsColorMode(f, r.mode)).toBe(true);
    }
  });

  it('treats a present-but-empty attribute as absent (same rule as cloudSupportsColorMode)', () => {
    // A zero-length array is a declared-but-unfilled field; colouring by it
    // yields a uniform wash, so it must not win the recommendation.
    const r = recommendColorMode({ colors: new Uint8Array(0), intensity: new Uint16Array([5]) });
    expect(r.mode).toBe('intensity');
  });
});
