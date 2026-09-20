/**
 * The tier ladder's input, now that something produces it.
 *
 * Until this module the struct was built by hand at every call site, so the
 * ladder had never been driven by a measurement. These tests pin the two
 * conditions apart, because collapsing them would delete the `closure` rung:
 * a device that refuses the float colour attachment still reads neighbouring
 * depths and still closes gaps.
 */
import { describe, it, expect } from 'vitest';
import {
  probeBackendSupport,
  historyTexturesAvailable,
  depthNeighbourhoodAvailable,
  webgl2Probe,
  webgpuProbe,
  type DeviceProbe,
} from '../src/render/continuity/probeBackendSupport';
import { tierFor } from '../src/render/continuity/continuityTier';
import { historyFits } from '../src/render/continuity/historyBudget';

const gl = (ext: unknown, w = 1920, h = 1080) => ({
  getExtension: () => ext,
  drawingBufferWidth: w,
  drawingBufferHeight: h,
});

describe('the float colour attachment', () => {
  it('is unconditional on WebGPU', () => {
    expect(historyTexturesAvailable(webgpuProbe({ widthPx: 1920, heightPx: 1080 }))).toBe(true);
  });

  it('needs the extension on WebGL 2', () => {
    expect(historyTexturesAvailable(webgl2Probe(gl({})))).toBe(true);
    expect(historyTexturesAvailable(webgl2Probe(gl(null)))).toBe(false);
  });

  it('treats a context that throws as not having said yes', () => {
    const hostile: DeviceProbe = {
      backend: 'webgl2',
      colorBufferFloat: () => { throw new Error('context lost'); },
      backingStorePx: () => ({ widthPx: 800, heightPx: 600 }),
    };
    expect(historyTexturesAvailable(hostile)).toBe(false);
  });

  it('does not consult the extension on WebGPU', () => {
    let asked = false;
    const probe: DeviceProbe = {
      backend: 'webgpu',
      colorBufferFloat: () => { asked = true; return false; },
      backingStorePx: () => ({ widthPx: 800, heightPx: 600 }),
    };
    expect(historyTexturesAvailable(probe)).toBe(true);
    expect(asked).toBe(false);
  });
});

describe('reading neighbouring depths', () => {
  it('holds on both backends, which is what keeps closure below full', () => {
    expect(depthNeighbourhoodAvailable(webgpuProbe({ widthPx: 8, heightPx: 8 }))).toBe(true);
    expect(depthNeighbourhoodAvailable(webgl2Probe(gl(null)))).toBe(true);
  });

  it('gives a WebGL 2 device without the extension the closure rung, not source', () => {
    const support = probeBackendSupport(webgl2Probe(gl(null)));
    expect(support.historyTextures).toBe(false);
    expect(support.depthNeighbourhood).toBe(true);
    expect(tierFor(support)).toBe('closure');
  });

  it('gives a capable WebGPU device the full rung', () => {
    const support = probeBackendSupport(webgpuProbe({ widthPx: 1920, heightPx: 1080 }));
    expect(tierFor(support)).toBe('full');
  });
});

describe('the budget half', () => {
  it('reads the real backing store rather than a CSS size', () => {
    const support = probeBackendSupport(webgl2Probe(gl({}, 3840, 2160)));
    expect(support.historyFits).toBe(historyFits(3840, 2160));
  });

  it('reports no fit for a backing store that overruns the ceiling', () => {
    const huge = probeBackendSupport(webgpuProbe({ widthPx: 16384, heightPx: 16384 }));
    expect(huge.historyFits).toBe(false);
    expect(tierFor(huge)).toBe('closure');
  });

  it('reports no fit when the size cannot be read, which drops a rung safely', () => {
    const blind: DeviceProbe = {
      backend: 'webgpu',
      colorBufferFloat: () => true,
      backingStorePx: () => { throw new Error('no context'); },
    };
    const support = probeBackendSupport(blind);
    expect(support.historyFits).toBe(false);
    expect(tierFor(support)).toBe('closure');
  });
});
