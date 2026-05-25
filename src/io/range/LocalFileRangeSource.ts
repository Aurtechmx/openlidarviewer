/**
 * LocalFileRangeSource.ts
 *
 * A {@link RangeSource} backed by a dropped or picked `File`. Each read is a
 * `File.slice()` — the browser serves the bytes straight from disk with no
 * full-file read, which is exactly what COPC streaming needs.
 *
 * Browser-bound (wraps a `File`) — not imported in Node unit tests; the
 * `ArrayBufferRangeSource` is the test substrate.
 */

import type { RangeSource, RangeSourceKind } from './RangeSource';
import { RangeReadError, clampRange } from './RangeSource';

/** A range-readable source over a local `File`, read via `File.slice`. */
export class LocalFileRangeSource implements RangeSource {
  private readonly _file: File;

  constructor(file: File) {
    this._file = file;
  }

  id(): string {
    return this._file.name;
  }

  kind(): RangeSourceKind {
    return 'local-file';
  }

  size(): Promise<number> {
    return Promise.resolve(this._file.size);
  }

  async readRange(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new RangeReadError('aborted', 'Range read aborted');
    const clamped = clampRange(offset, length, this._file.size);
    // File.slice is a cheap, lazy view; arrayBuffer() performs the actual read.
    const buffer = await this._file.slice(offset, offset + clamped).arrayBuffer();
    if (signal?.aborted) throw new RangeReadError('aborted', 'Range read aborted');
    return buffer;
  }
}
