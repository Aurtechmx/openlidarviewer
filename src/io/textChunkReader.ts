/**
 * textChunkReader.ts
 *
 * Streaming line reader for large text point clouds (XYZ / CSV / PTS). It walks
 * an `ArrayBuffer` in fixed-size byte chunks, stream-decodes each as UTF-8, and
 * invokes a callback per complete line — carrying a partial last line between
 * chunks.
 *
 * Why: the former approach decoded the whole file into one giant string and
 * then split it into one giant array of line strings — two transient copies on
 * top of the point data. For a multi-hundred-megabyte text cloud that is the
 * difference between loading and an out-of-memory failure. Here, only the point
 * data accumulates; the file is never restated whole as strings.
 *
 * Pure (no DOM, no three.js) — runs in the parse worker.
 */

/** Default chunk size — large enough to be efficient, small enough to bound memory. */
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Smallest permitted chunk — guards against a pathologically tiny value. */
const MIN_CHUNK_BYTES = 64 * 1024;

/** Options for {@link readTextLines}. */
export interface TextLineReaderOptions {
  /** Bytes decoded per chunk. Defaults to 4 MiB. */
  chunkBytes?: number;
  /** Called with a 0–1 progress fraction after each chunk. */
  onProgress?: (fraction: number) => void;
}

/**
 * Walk `buffer` as UTF-8 text, calling `onLine` once per line. A trailing
 * carriage return (`\r`) is stripped, so the callback always receives a clean
 * line. The final line is delivered even when the file has no trailing newline.
 */
export function readTextLines(
  buffer: ArrayBuffer,
  onLine: (line: string) => void,
  options: TextLineReaderOptions = {},
): void {
  const chunkBytes = Math.max(MIN_CHUNK_BYTES, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const bytes = new Uint8Array(buffer);
  const total = bytes.length;
  const decoder = new TextDecoder();
  // The partial last line of a chunk, prepended to the next chunk's text.
  let carry = '';
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + chunkBytes, total);
    const isLast = end >= total;
    // `stream: true` until the final chunk, so a multi-byte UTF-8 character
    // split across a chunk boundary is decoded correctly.
    const text = carry + decoder.decode(bytes.subarray(offset, end), { stream: !isLast });

    let lineStart = 0;
    let nl = text.indexOf('\n');
    while (nl !== -1) {
      let lineEnd = nl;
      if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd--; // strip \r
      onLine(text.slice(lineStart, lineEnd));
      lineStart = nl + 1;
      nl = text.indexOf('\n', lineStart);
    }
    carry = text.slice(lineStart);
    offset = end;
    options.onProgress?.(total > 0 ? offset / total : 1);
  }

  // The file's final line, when it is not newline-terminated.
  if (carry.length > 0) {
    let end = carry.length;
    if (carry.charCodeAt(end - 1) === 13) end--;
    onLine(carry.slice(0, end));
  }
}
