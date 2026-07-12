import {
  availableStreamingModes,
  defaultStreamingMode,
  intensityRangeOf,
  scalarRangeOf,
  streamingNodeColors,
  type StreamingColorRanges,
} from '../src/render/streaming/streamingColors';
import type { CopcMetadata } from '../src/io/copc/copcTypes';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';

function metadata(hasRgb: boolean, hasGpsTime = true): CopcMetadata {
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
      hasGpsTime,
      crs: null,
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

/** Full cloud-global ranges with overridable fields — keeps literals short. */
function ranges(overrides: Partial<StreamingColorRanges> = {}): StreamingColorRanges {
  return {
    minZ: 0,
    maxZ: 1,
    minIntensity: 0,
    maxIntensity: 1,
    minGpsTime: 0,
    maxGpsTime: 1,
    minReturnNumber: 0,
    maxReturnNumber: 1,
    ...overrides,
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
  const rgb = streamingNodeColors('rgb', c, ranges());
  expect(rgb).toBe(c.rgb);
});

test('streamingNodeColors falls back to elevation when RGB is absent', () => {
  const c = chunk(2, false);
  const out = streamingNodeColors('rgb', c, ranges({ maxZ: 10 }));
  expect(out.length).toBe(6); // 3 bytes per point — the elevation fallback
});

test('streamingNodeColors produces 3 bytes per point for every mode', () => {
  const c = chunk(4, true);
  const r = ranges({ maxIntensity: 255 });
  for (const mode of ['intensity', 'elevation', 'classification', 'gpsTime', 'returnNumber'] as const) {
    expect(streamingNodeColors(mode, c, r).length).toBe(12);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Scalar modes — gpsTime / returnNumber against cloud-GLOBAL ranges
// ────────────────────────────────────────────────────────────────────────────

// Cividis endpoints — the CVD-safe default the scalar modes ramp on.
const CIVIDIS_LO = [0, 32, 76];
const CIVIDIS_HI = [253, 231, 37];

test('scalarRangeOf finds the min and max of an arbitrary per-point array', () => {
  expect(scalarRangeOf(new Float64Array([5, 1, 9, 3]), 4)).toEqual({ min: 1, max: 9 });
  expect(scalarRangeOf(new Uint8Array(0), 0)).toEqual({ min: 0, max: 0 });
});

test('intensityRangeOf still matches the generic scalar range', () => {
  const c = chunk(3, false);
  c.intensity.set([10, 200, 55]);
  expect(intensityRangeOf(c)).toEqual(scalarRangeOf(c.intensity, c.pointCount));
});

test('gpsTime mode normalises huge Float64 times against the GLOBAL range', () => {
  // Two nodes of one cloud, each holding a different half of the acquisition.
  // Both colour against the same cloud-global range, so a node-local min never
  // rebases the ramp — the banding-at-node-edges failure the file guards.
  const base = 3.2e8;
  const global = ranges({ minGpsTime: base, maxGpsTime: base + 10 });
  const early = chunk(2, false);
  early.gpsTime.set([base, base + 5]);
  const late = chunk(2, false);
  late.gpsTime.set([base + 5, base + 10]);
  const outEarly = streamingNodeColors('gpsTime', early, global);
  const outLate = streamingNodeColors('gpsTime', late, global);
  // The shared timestamp (base + 5) colours identically in both nodes.
  expect([outEarly[3], outEarly[4], outEarly[5]]).toEqual([outLate[0], outLate[1], outLate[2]]);
  // Endpoints hit the Cividis stops — the sub-range Float64 deltas survived.
  expect([outEarly[0], outEarly[1], outEarly[2]]).toEqual(CIVIDIS_LO);
  expect([outLate[3], outLate[4], outLate[5]]).toEqual(CIVIDIS_HI);
});

test('returnNumber mode colours against the GLOBAL return range', () => {
  const global = ranges({ minReturnNumber: 1, maxReturnNumber: 3 });
  const c = chunk(3, false);
  c.returnNumber.set([1, 2, 3]);
  const out = streamingNodeColors('returnNumber', c, global);
  expect([out[0], out[1], out[2]]).toEqual(CIVIDIS_LO);
  expect([out[6], out[7], out[8]]).toEqual(CIVIDIS_HI);
});

test('availableStreamingModes gates gpsTime on the header flag, always offers returnNumber', () => {
  expect(availableStreamingModes(metadata(false, true))).toContain('gpsTime');
  expect(availableStreamingModes(metadata(false, false))).not.toContain('gpsTime');
  expect(availableStreamingModes(metadata(false, false))).toContain('returnNumber');
});
