import { describe, it, expect } from 'vitest';
import { recommendColorMode } from '../src/render/colorModeRecommend';
import { cloudSupportsColorMode, type ColorModeCloudFacts } from '../src/render/colorModeSupport';

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

  describe('a class channel that labels almost nothing', () => {
    /**
     * An airborne tile in the proportions that exposed this: a full class
     * array in which all but a few per cent of points are ASPRS 0 / 1, with a
     * thin ground return. Colouring by class paints it one flat grey.
     */
    const airborneClasses = (): Uint8Array => {
      const cls = new Uint8Array(1000).fill(0);
      for (let i = 0; i < 28; i++) cls[i] = 2; // 2.8% ground, as measured
      return cls;
    };

    it('does not open into classification when nearly every point is unclassified', () => {
      const r = recommendColorMode({ classification: airborneClasses() });
      expect(r.mode).not.toBe('classification');
    });

    it('opens into the height ramp, not intensity, for such a scan', () => {
      // Height is position-derived and always readable; airborne intensity is
      // uncalibrated, so it is not the better opening view here.
      const r = recommendColorMode({
        classification: airborneClasses(),
        intensity: new Uint16Array([10, 20, 30]),
      });
      expect(r.mode).toBe('elevation');
      expect(r.reason).toMatch(/height/);
    });

    it('still opens into classification when the scan is meaningfully classified', () => {
      // Half ground, half building: the classes genuinely shape the scene.
      const cls = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) cls[i] = i % 2 === 0 ? 2 : 6;
      expect(recommendColorMode({ classification: cls }).mode).toBe('classification');
    });

    it('leaves a true-colour scan on rgb even when its class channel is degenerate', () => {
      const r = recommendColorMode({
        colors: new Uint8Array([10, 120, 240]),
        classification: airborneClasses(),
      });
      expect(r.mode).toBe('rgb');
    });
  });

  describe('derived-colour provenance', () => {
    it('marks rgb as the only measured colour', () => {
      const r = recommendColorMode({ colors: new Uint8Array([10, 120, 240]) });
      expect(r.mode).toBe('rgb');
      expect(r.derived).toBe(false);
    });

    it('marks every applied ramp or palette as derived', () => {
      // Nothing but rgb carries the scan's own colour, so every other opening
      // mode must be flagged so a caller cannot present it as measured data.
      const cases: ColorModeCloudFacts[] = [
        {},
        { intensity: new Uint16Array([5, 9]) },
        { classification: new Uint8Array([2, 6]) },
        { colors: new Uint8Array([250, 250, 250]) },
      ];
      for (const facts of cases) {
        const r = recommendColorMode(facts);
        if (r.mode === 'rgb') continue;
        expect(r.derived).toBe(true);
      }
    });
  });
});
