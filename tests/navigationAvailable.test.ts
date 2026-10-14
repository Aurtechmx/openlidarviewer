import { describe, it, expect } from 'vitest';
import { navigationAvailable } from '../src/render/navMath';

describe('navigationAvailable', () => {
  it('is on for a static layer, a streaming scene, or both', () => {
    expect(navigationAvailable(1, false)).toBe(true);
    expect(navigationAvailable(0, true)).toBe(true);
    expect(navigationAvailable(2, true)).toBe(true);
  });

  it('is off only when nothing is loaded', () => {
    expect(navigationAvailable(0, false)).toBe(false);
  });

  it('stays on when the last static layer goes while a streaming scene remains', () => {
    // A streaming file opened over a static scan: the attach enables navigation,
    // then the static layer is retired. A static-only check switched keyboard
    // flight off here although the streaming scene was still on screen.
    let staticLayers = 1;
    const streaming = true;
    staticLayers -= 1;
    expect(navigationAvailable(staticLayers, streaming)).toBe(true);
  });
});
