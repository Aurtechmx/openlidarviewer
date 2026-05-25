import {
  LoadError,
  describeLoadError,
  classifyLoadError,
  messageForCategory,
} from '../src/io/loadErrors';
import type { LoadErrorCategory } from '../src/io/loadErrors';

const ALL_CATEGORIES: LoadErrorCategory[] = [
  'unsupported-format',
  'malformed-file',
  'memory-constraint',
  'gpu-limitation',
  'decode-failure',
];

test('a typed LoadError is described by its own category', () => {
  expect(describeLoadError(new LoadError('unsupported-format', 'raw detail'))).toBe(
    messageForCategory('unsupported-format'),
  );
  expect(describeLoadError(new LoadError('memory-constraint', 'oom at 0x0'))).toBe(
    messageForCategory('memory-constraint'),
  );
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
