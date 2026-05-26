import {
  classificationLabel,
  makePointInfo,
  intensityText,
  classificationText,
  rgbText,
  returnText,
  pointSourceIdText,
  gpsTimeText,
  normalText,
  pointInfoCopyText,
  pointInfoJson,
} from '../src/render/pointInfo';
import type { RawPointInfo } from '../src/render/pointInfo';

/** A raw picked point with every attribute present (origin at zero). */
function fullRaw(): RawPointInfo {
  return {
    layer: '20210916_FLEXIGROBOTS.laz',
    index: 1284392,
    local: [42.38149, 18.20351, 6.91284],
    origin: [0, 0, 0],
    distance: 73.41902,
    intensity: 128,
    classification: 2,
    rgb: [180, 92, 40],
  };
}

test('classificationLabel maps ASPRS codes to names', () => {
  expect(classificationLabel(2)).toBe('Ground');
  expect(classificationLabel(6)).toBe('Building');
  expect(classificationLabel(0)).toBe('Created, never classified');
});

test('classificationLabel falls back for unknown codes', () => {
  expect(classificationLabel(99)).toBe('Class 99');
});

test('makePointInfo rounds coordinates to 3 decimals and distance to 2', () => {
  const info = makePointInfo(fullRaw());
  expect(info.x).toBe(42.381);
  expect(info.y).toBe(18.204);
  expect(info.z).toBe(6.913);
  expect(info.distance).toBe(73.42);
});

test('makePointInfo adds the load-time origin back for real-world coordinates', () => {
  // A georeferenced scan: large UTM origin, small local residual.
  const info = makePointInfo({
    ...fullRaw(),
    local: [0.789, 0.105, 0.34],
    origin: [412345, 4587234, 118],
  });
  expect(info.x).toBe(412345.789);
  expect(info.y).toBe(4587234.105);
  expect(info.z).toBe(118.34);
});

test('makePointInfo passes attributes through unchanged', () => {
  const info = makePointInfo(fullRaw());
  expect(info.intensity).toBe(128);
  expect(info.classification).toBe(2);
  expect(info.rgb).toEqual([180, 92, 40]);
  expect(info.index).toBe(1284392);
  expect(info.layer).toBe('20210916_FLEXIGROBOTS.laz');
});

test('field text helpers show real values when present', () => {
  const info = makePointInfo(fullRaw());
  expect(intensityText(info)).toBe('128');
  expect(classificationText(info)).toBe('Ground');
  expect(rgbText(info)).toBe('180, 92, 40');
});

test('field text helpers show "Not available" when an attribute is missing', () => {
  const info = makePointInfo({
    ...fullRaw(),
    intensity: null,
    classification: null,
    rgb: null,
  });
  expect(intensityText(info)).toBe('Not available');
  expect(classificationText(info)).toBe('Not available');
  expect(rgbText(info)).toBe('Not available');
});

test('pointInfoCopyText produces the documented plain-text block', () => {
  const text = pointInfoCopyText(makePointInfo(fullRaw()));
  expect(text).toBe(
    [
      'OpenLiDARViewer Point Info',
      'Layer: 20210916_FLEXIGROBOTS.laz',
      'Index: 1284392',
      'X: 42.381',
      'Y: 18.204',
      'Z: 6.913',
      'Intensity: 128',
      'Classification: Ground',
      'RGB: 180, 92, 40',
    ].join('\n'),
  );
});

test('pointInfoCopyText marks missing attributes as "Not available"', () => {
  const text = pointInfoCopyText(
    makePointInfo({ ...fullRaw(), intensity: null, classification: null, rgb: null }),
  );
  expect(text).toContain('Intensity: Not available');
  expect(text).toContain('Classification: Not available');
  expect(text).toContain('RGB: Not available');
});

test('pointInfoJson is JSON-friendly with classification as a name', () => {
  const json = pointInfoJson(makePointInfo(fullRaw()));
  expect(json).toEqual({
    layer: '20210916_FLEXIGROBOTS.laz',
    index: 1284392,
    x: 42.381,
    y: 18.204,
    z: 6.913,
    intensity: 128,
    classification: 'Ground',
    rgb: [180, 92, 40],
  });
});

test('pointInfoJson keeps nulls for missing attributes', () => {
  const json = pointInfoJson(
    makePointInfo({ ...fullRaw(), intensity: null, classification: null, rgb: null }),
  );
  expect(json.intensity).toBeNull();
  expect(json.classification).toBeNull();
  expect(json.rgb).toBeNull();
});

// ────────────────────────────────────────────────────────────────────────────
// LAS inspection extras — return, point source, GPS time, normal (v0.2.8)
// ────────────────────────────────────────────────────────────────────────────

/** A raw picked point that also carries every v0.2.8 inspection extra. */
function rawWithExtras(): RawPointInfo {
  return {
    ...fullRaw(),
    returnNumber: 2,
    returnCount: 3,
    pointSourceId: 4097,
    gpsTime: 312456.789012,
    normal: [0.1234567, -0.7654321, 0.5],
  };
}

test('makePointInfo threads the LAS extras through, rounding GPS time and the normal', () => {
  const info = makePointInfo(rawWithExtras());
  expect(info.returnNumber).toBe(2);
  expect(info.returnCount).toBe(3);
  expect(info.pointSourceId).toBe(4097);
  expect(info.gpsTime).toBe(312456.789); // rounded to 3 decimals
  expect(info.normal).toEqual([0.1235, -0.7654, 0.5]); // rounded to 4 decimals
});

test('makePointInfo leaves the extras undefined when the raw point has none', () => {
  const info = makePointInfo(fullRaw());
  expect(info.returnNumber).toBeUndefined();
  expect(info.pointSourceId).toBeUndefined();
  expect(info.gpsTime).toBeUndefined();
  expect(info.normal).toBeUndefined();
});

test('extra text helpers format a value, or return null when absent', () => {
  const withExtras = makePointInfo(rawWithExtras());
  expect(returnText(withExtras)).toBe('2 of 3');
  expect(pointSourceIdText(withExtras)).toBe('4097');
  expect(gpsTimeText(withExtras)).toBe('312456.789');
  expect(normalText(withExtras)).toBe('0.1235, -0.7654, 0.5');

  const none = makePointInfo(fullRaw());
  expect(returnText(none)).toBeNull();
  expect(pointSourceIdText(none)).toBeNull();
  expect(gpsTimeText(none)).toBeNull();
  expect(normalText(none)).toBeNull();
});

test('pointInfoCopyText appends the extras only when present', () => {
  const text = pointInfoCopyText(makePointInfo(rawWithExtras()));
  expect(text).toContain('Return: 2 of 3');
  expect(text).toContain('Point source: 4097');
  expect(text).toContain('GPS time: 312456.789');
  expect(text).toContain('Normal: 0.1235, -0.7654, 0.5');
  // A point with no extras keeps the v0.2.7 nine-line block exactly.
  expect(pointInfoCopyText(makePointInfo(fullRaw())).split('\n')).toHaveLength(9);
});

test('pointInfoJson adds the extras only when present', () => {
  const json = pointInfoJson(makePointInfo(rawWithExtras()));
  expect(json.returnNumber).toBe(2);
  expect(json.returnCount).toBe(3);
  expect(json.pointSourceId).toBe(4097);
  expect(json.gpsTime).toBe(312456.789);
  expect(json.normal).toEqual([0.1235, -0.7654, 0.5]);
  // A non-LAS point's JSON keeps exactly the v0.2.7 shape.
  expect(Object.keys(pointInfoJson(makePointInfo(fullRaw()))).sort()).toEqual(
    ['classification', 'index', 'intensity', 'layer', 'rgb', 'x', 'y', 'z'].sort(),
  );
});

// --- Phase 6 Task 24 — "still refining" hint passthrough --------------------

test('makePointInfo carries the streamingRefining flag through unchanged', () => {
  // Static-cloud picks (no streaming context) carry no hint.
  const off = makePointInfo(fullRaw());
  expect(off.streamingRefining).toBeUndefined();

  // A streaming pick on a coarse node sets the flag; the inspector card
  // reads it to render the "still refining" row.
  const on = makePointInfo({ ...fullRaw(), streamingRefining: true });
  expect(on.streamingRefining).toBe(true);

  // An explicit `false` normalises to absent — the flag is positive-only,
  // matching the omit-when-absent shape of the other optional fields.
  const explicitFalse = makePointInfo({ ...fullRaw(), streamingRefining: false });
  expect(explicitFalse.streamingRefining).toBeUndefined();
});
