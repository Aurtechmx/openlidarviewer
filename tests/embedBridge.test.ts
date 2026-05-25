import { interpretEmbedMessage } from '../src/ui/embedBridge';

test('a valid jump-camera message is interpreted', () => {
  const cmd = interpretEmbedMessage({
    type: 'jump-camera',
    camera: { position: [1, 2, 3], target: [0, 0, 0], mode: 'orbit', fov: 60 },
  });
  expect(cmd).toEqual({
    kind: 'jump-camera',
    camera: { position: [1, 2, 3], target: [0, 0, 0], mode: 'orbit', fov: 60 },
  });
});

test('a jump-camera with optional mode/fov omitted still parses', () => {
  const cmd = interpretEmbedMessage({
    type: 'jump-camera',
    camera: { position: [1, 1, 1], target: [2, 2, 2] },
  });
  expect(cmd).toEqual({
    kind: 'jump-camera',
    camera: { position: [1, 1, 1], target: [2, 2, 2] },
  });
});

test('a jump-camera missing its target is rejected', () => {
  expect(interpretEmbedMessage({ type: 'jump-camera', camera: { position: [1, 2, 3] } }))
    .toBeNull();
});

test('a camera with a non-finite component is rejected', () => {
  expect(
    interpretEmbedMessage({
      type: 'jump-camera',
      camera: { position: [1, NaN, 3], target: [0, 0, 0] },
    }),
  ).toBeNull();
});

test('toggle-layer requires a string id and a boolean visible', () => {
  expect(interpretEmbedMessage({ type: 'toggle-layer', id: 'cloud_0', visible: false }))
    .toEqual({ kind: 'toggle-layer', id: 'cloud_0', visible: false });
  expect(interpretEmbedMessage({ type: 'toggle-layer', id: 'cloud_0', visible: 'no' }))
    .toBeNull();
});

test('focus-annotation requires a string id', () => {
  expect(interpretEmbedMessage({ type: 'focus-annotation', id: 'a1' }))
    .toEqual({ kind: 'focus-annotation', id: 'a1' });
  expect(interpretEmbedMessage({ type: 'focus-annotation', id: 42 })).toBeNull();
});

test('load-file requires an ArrayBuffer and a name', () => {
  const buffer = new ArrayBuffer(8);
  expect(interpretEmbedMessage({ type: 'load-file', buffer, name: 'a.las' }))
    .toEqual({ kind: 'load-file', buffer, name: 'a.las' });
  expect(interpretEmbedMessage({ type: 'load-file', buffer: 'not-a-buffer', name: 'a.las' }))
    .toBeNull();
});

test('unrecognised, malformed, and non-object messages are rejected', () => {
  expect(interpretEmbedMessage({ type: 'delete-everything' })).toBeNull();
  expect(interpretEmbedMessage({ type: 'jump-camera' })).toBeNull();
  expect(interpretEmbedMessage(null)).toBeNull();
  expect(interpretEmbedMessage('jump-camera')).toBeNull();
  expect(interpretEmbedMessage(undefined)).toBeNull();
});
