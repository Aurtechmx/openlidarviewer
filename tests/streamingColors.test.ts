import {
  availableStreamingModes,
  defaultStreamingMode,
  intensityRangeOf,
  streamingNodeColors,
} from '../src/render/streaming/streamingColors';
import type { CopcMetadata } from '../src/io/copc/copcTypes';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

function metadata(hasRgb: boolean): CopcMetadata {
  return {
    header: {
      pointDataRecordFormat: hasRgb ? 7 : 6,
      pointRecordLength: hasRgb ? 36 : 30,
      pointCount: 100,
      scale: [1, 1, 1],
      offset: [0, 0, 0],
      min: [0, 0, 0],
      max: [1, 1, 1],
      hasRgb,
      hasGpsTime: true,
    },
    info: {
      center: [0, 0, 0],
      halfsize: 1,
      spacing: 1,
      rootHierOffset: 1,
      rootHierSize: 32,
      gpsTimeRange: [0, 0],
    },
  };
}

function chunk(n: number, withRgb: boolean): DecodedChunk {
  return {
    pointCount: n,
    positions: new Float32Array(n * 3),
    intensity: new Uint16Array(n),
    classification: new Uint8Array(n),
    returnNumber: new Uint8Array(n),
    returnCount: new Uint8Array(n),
    gpsTime: new Float64Array(n),
    rgb: withRgb ? new Uint8Array(n * 3) : undefined,
  };
}

test('availableStreamingModes includes rgb only for an RGB point format', () => {
  expect(availableStreamingModes(metadata(true))).toContain('rgb');
  expect(availableStreamingModes(metadata(false))).not.toContain('rgb');
  expect(availableStreamingModes(metadata(false))).toEqual(
    expect.arrayContaining(['intensity', 'elevation', 'classification']),
  );
});

test('defaultStreamingMode prefers rgb when the format carries it', () => {
  expect(defaultStreamingMode(metadata(true))).toBe('rgb');
  expect(defaultStreamingMode(metadata(false))).toBe('elevation');
});

test('intensityRangeOf finds the min and max of a chunk', () => {
  const c = chunk(3, false);
  c.intensity[0] = 10;
  c.intensity[1] = 200;
  c.intensity[2] = 55;
  expect(intensityRangeOf(c)).toEqual({ min: 10, max: 200 });
});

test('streamingNodeColors returns the decoded RGB directly in rgb mode', () => {
  const c = chunk(2, true);
  const rgb = streamingNodeColors('rgb', c, {
    minZ: 0,
    maxZ: 1,
    minIntensity: 0,
    maxIntensity: 1,
  });
  expect(rgb).toBe(c.rgb);
});

test('streamingNodeColors falls back to elevation when RGB is absent', () => {
  const c = chunk(2, false);
  const out = streamingNodeColors('rgb', c, {
    minZ: 0,
    maxZ: 10,
    minIntensity: 0,
    maxIntensity: 1,
  });
  expect(out.length).toBe(6); // 3 bytes per point — the elevation fallback
});

test('streamingNodeColors produces 3 bytes per point for every mode', () => {
  const c = chunk(4, true);
  const ranges = { minZ: 0, maxZ: 1, minIntensity: 0, maxIntensity: 255 };
  for (const mode of ['intensity', 'elevation', 'classification'] as const) {
    expect(streamingNodeColors(mode, c, ranges).length).toBe(12);
  }
});
