import {
  LoadError,
  GRAPHICS_UNAVAILABLE_MESSAGE,
  describeLoadError,
  classifyLoadError,
  graphicsReady,
  messageForCategory,
} from '../src/io/loadErrors';
import type { LoadErrorCategory } from '../src/io/loadErrors';

const ALL_CATEGORIES: LoadErrorCategory[] = [
  'unsupported-format',
  'malformed-file',
  'memory-constraint',
  'gpu-limitation',
  'decode-failure',
  'resource-load',
];

test('a typed LoadError is described by its own category', () => {
  expect(describeLoadError(new LoadError('unsupported-format', 'raw detail'))).toBe(
    messageForCategory('unsupported-format'),
  );
  expect(describeLoadError(new LoadError('memory-constraint', 'oom at 0x0'))).toBe(
    messageForCategory('memory-constraint'),
  );
});

test('a message written for the user reaches the toast as it is; a developer detail does not', () => {
  expect(messageForCategory('unsupported-format')).toBe("This file type isn't supported yet.");
  for (const msg of [
    'Not an E57 file: bad signature',
    'Paste the tileset.json URL to open 3D Tiles',
    'PNTS Draco data is not supported',
    'This URL is not a COPC file',
  ]) {
    // Unmarked: the category's general message, and the detail stays in the console.
    expect(describeLoadError(new LoadError('unsupported-format', msg))).toBe("This file type isn't supported yet.");
    // A copyable report, or the user-facing flag, shows the message verbatim.
    expect(describeLoadError(new LoadError('unsupported-format', msg, 'report'))).toBe(msg);
    expect(describeLoadError(new LoadError('unsupported-format', msg, undefined, { userFacing: true }))).toBe(msg);
  }
  const refusal = 'PLY too large for this device: the file is 3.1 GB, past the 2.0 GB this tab can be given. Convert to COPC/EPT to stream it instead.';
  const e = new LoadError('memory-constraint', refusal, undefined, { userFacing: true });
  expect(e.userFacing).toBe(true);
  expect(describeLoadError(e)).toBe(refusal);
  expect(new LoadError('memory-constraint', refusal).userFacing).toBe(false);
});

test('a graphics backend that cannot start is described as such, never as a fault in the file', async () => {
  const boom = new Error('WebGPU adapter request failed');
  await expect(graphicsReady(Promise.reject(boom))).rejects.toMatchObject({ category: 'gpu-limitation', userFacing: true, cause: boom });
  const err = await graphicsReady(Promise.reject(boom)).catch((x: unknown) => x);
  expect(describeLoadError(err)).toBe(GRAPHICS_UNAVAILABLE_MESSAGE);
  await expect(graphicsReady(Promise.resolve())).resolves.toBeUndefined();
  await expect(graphicsReady(undefined)).resolves.toBeUndefined();
});

test('every category maps to a non-empty, user-facing message', () => {
  for (const category of ALL_CATEGORIES) {
    expect(messageForCategory(category).length).toBeGreaterThan(0);
  }
});

test('untyped errors are classified best-effort from their message text', () => {
  expect(classifyLoadError('Unrecognised file format: a.foo')).toBe('unsupported-format');
  expect(classifyLoadError('LAS public header is invalid')).toBe('malformed-file');
  expect(classifyLoadError('WebAssembly memory allocation failed')).toBe(
    'memory-constraint',
  );
  expect(classifyLoadError('something else entirely')).toBe('decode-failure');
});

test('a failed code-chunk fetch is a resource-load error, not file corruption', () => {
  // The phrasings browsers use when a dynamically-imported chunk fails.
  expect(
    classifyLoadError('Failed to fetch dynamically imported module: https://x/y.js'),
  ).toBe('resource-load');
  expect(
    classifyLoadError('error loading dynamically imported module: /assets/a.js'),
  ).toBe('resource-load');
  expect(classifyLoadError('Importing a module script failed.')).toBe('resource-load');
  expect(classifyLoadError('Loading chunk 42 failed')).toBe('resource-load');
});

test('describeLoadError maps a plain Error through the classifier', () => {
  expect(describeLoadError(new Error('PCD header could not be read'))).toBe(
    messageForCategory('malformed-file'),
  );
  expect(describeLoadError(new Error('truncated record stream'))).toBe(
    messageForCategory('decode-failure'),
  );
});

test('describeLoadError tolerates a non-Error value and an empty message', () => {
  expect(describeLoadError('just a string')).toBe(messageForCategory('decode-failure'));
  expect(describeLoadError(new Error(''))).toBe(messageForCategory('decode-failure'));
  expect(describeLoadError(null)).toBeTruthy();
});

test('a LoadError carries its category and is a real Error', () => {
  const e = new LoadError('decode-failure', 'detail');
  expect(e).toBeInstanceOf(Error);
  expect(e.category).toBe('decode-failure');
  expect(e.name).toBe('LoadError');
  expect(e.message).toBe('detail');
});
