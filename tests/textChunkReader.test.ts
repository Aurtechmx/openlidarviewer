import { readTextLines } from '../src/io/textChunkReader';

/** Encode text to an ArrayBuffer. */
function buf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

/** Collect every line `readTextLines` emits for `text` at a given chunk size. */
function lines(text: string, chunkBytes?: number): string[] {
  const out: string[] = [];
  readTextLines(buf(text), (line) => out.push(line), chunkBytes ? { chunkBytes } : {});
  return out;
}

test('splits lines correctly across many tiny chunk boundaries', () => {
  const text = 'one\ntwo\nthree\nfour\nfive';
  // A tiny chunk forces line boundaries to fall mid-chunk repeatedly.
  expect(lines(text, 64 * 1024)).toEqual(['one', 'two', 'three', 'four', 'five']);
});

test('strips trailing carriage returns (CRLF files)', () => {
  expect(lines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
});

test('delivers the final line when the file has no trailing newline', () => {
  expect(lines('alpha\nbeta')).toEqual(['alpha', 'beta']);
});

test('a trailing newline does not yield a spurious empty final line', () => {
  expect(lines('alpha\nbeta\n')).toEqual(['alpha', 'beta']);
});

test('an empty buffer yields no lines', () => {
  expect(lines('')).toEqual([]);
});

test('a multi-byte UTF-8 character split across a chunk boundary survives', () => {
  // "café" then a newline then "ünï" — forced through 8-byte chunks so a
  // multi-byte character lands across a boundary.
  const text = 'café\nünï\nok';
  expect(lines(text, 8)).toEqual(['café', 'ünï', 'ok']);
});

test('progress runs from above zero to exactly 1', () => {
  const fractions: number[] = [];
  readTextLines(
    buf('a\nb\nc\nd\ne\nf'),
    () => {},
    { chunkBytes: 64 * 1024, onProgress: (f) => fractions.push(f) },
  );
  expect(fractions.length).toBeGreaterThan(0);
  expect(fractions[fractions.length - 1]).toBe(1);
  expect(fractions.every((f) => f > 0 && f <= 1)).toBe(true);
});
