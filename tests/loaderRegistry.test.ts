import { loaderFor } from '../src/io/loaderRegistry';
import {
  formatInfo,
  isRegisteredFormat,
  registeredFormats,
} from '../src/io/formatInfo';

const ALL_FORMATS = [
  'las', 'laz', 'e57', 'ply', 'obj', 'glb', 'gltf', 'xyz', 'pcd', 'ptx', 'pts',
] as const;

test('every format resolves to a loader function', () => {
  for (const format of ALL_FORMATS) {
    expect(typeof loaderFor(format)).toBe('function');
  }
});

test('registeredFormats lists exactly the registered formats', () => {
  expect(registeredFormats().sort()).toEqual(
    ['e57', 'glb', 'gltf', 'las', 'laz', 'obj', 'pcd', 'ply', 'pts', 'ptx', 'xyz'],
  );
});

test('isRegisteredFormat accepts known formats and rejects others', () => {
  for (const format of ALL_FORMATS) expect(isRegisteredFormat(format)).toBe(true);
  expect(isRegisteredFormat('unknown')).toBe(false);
  expect(isRegisteredFormat('zzz')).toBe(false);
});

test('format facts: text vs binary and header-count are recorded correctly', () => {
  // LAS/LAZ headers reveal a point count up front; nothing else does (yet).
  expect(formatInfo('las').hasHeaderCount).toBe(true);
  expect(formatInfo('laz').hasHeaderCount).toBe(true);
  expect(formatInfo('e57').hasHeaderCount).toBe(false);
  expect(formatInfo('pcd').hasHeaderCount).toBe(false);
  // XYZ/CSV is the only line-text format.
  expect(formatInfo('xyz').isText).toBe(true);
  expect(formatInfo('las').isText).toBe(false);
  expect(formatInfo('pcd').isText).toBe(false);
});

test('every format carries a non-empty display label', () => {
  for (const format of registeredFormats()) {
    expect(formatInfo(format).label.length).toBeGreaterThan(0);
  }
});
