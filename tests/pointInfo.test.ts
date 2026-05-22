import {
  classificationLabel,
  makePointInfo,
  intensityText,
  classificationText,
  rgbText,
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
