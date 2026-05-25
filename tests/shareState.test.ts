import { encodeShareState, decodeShareState } from '../src/io/shareState';
import type { ShareState } from '../src/io/shareState';

const FULL: ShareState = {
  camera: { position: [1, 2, 3], target: [4, 5, 6], mode: 'orbit', fov: 55 },
  colorMode: 'height',
  pointSize: 1.5,
  pointSizeMode: 'adaptive',
  selectedAnnotation: 'a_42',
};

test('a full state round-trips through encode/decode unchanged', () => {
  expect(decodeShareState(encodeShareState(FULL))).toEqual(FULL);
});

test('the encoded string is URL-hash safe', () => {
  const encoded = encodeShareState(FULL);
  expect(encoded).not.toMatch(/[+/=]/);
});

test('encode drops unset fields; a camera-only state round-trips', () => {
  const cameraOnly: ShareState = {
    camera: { position: [0, 0, 0], target: [1, 1, 1] },
  };
  const back = decodeShareState(encodeShareState(cameraOnly));
  expect(back).toEqual(cameraOnly);
});

test('an empty state round-trips to an empty state', () => {
  expect(decodeShareState(encodeShareState({}))).toEqual({});
});

test('decode drops a malformed camera but keeps the valid fields', () => {
  // Hand-encode a payload with a bad camera (missing target) and a good size.
  const encoded = encodeShareState({
    pointSize: 2,
  } as ShareState);
  const tampered = btoa(JSON.stringify({ camera: { position: [1, 2, 3] }, pointSize: 2 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  expect(decodeShareState(encoded)).toEqual({ pointSize: 2 });
  expect(decodeShareState(tampered)).toEqual({ pointSize: 2 });
});

test('decode rejects non-JSON and over-long payloads', () => {
  expect(decodeShareState('not%%%base64%%%')).toBeNull();
  expect(decodeShareState('x'.repeat(5000))).toBeNull();
  expect(decodeShareState('')).toBeNull();
});

test('decode tolerates a payload that is valid base64 but not an object', () => {
  const encoded = btoa('42').replace(/=+$/, '');
  expect(decodeShareState(encoded)).toBeNull();
});
