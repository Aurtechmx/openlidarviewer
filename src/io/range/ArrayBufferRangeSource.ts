/**
 * ArrayBufferRangeSource.ts
 *
 * A {@link RangeSource} backed by an in-memory `ArrayBuffer` — the substrate
 * for reproducible, network-free unit and integration tests (the synthetic
 * COPC fixture is an `ArrayBuffer`). Also useful for an already-loaded buffer.
 *
 * Pure — no DOM, no three.js — safe in Node.
 */

import type { RangeSource, RangeSourceKind } from './RangeSource';
import { RangeReadError, clampRange } from './RangeSource';

/** A range-readable source over an in-memory `ArrayBuffer`. */
export class ArrayBufferRangeSource implements RangeSource {
  private readonly _buffer: ArrayBuffer;
  private readonly _id: string;

  constructor(buffer: ArrayBuffer, id = 'array-buffer') {
    this._buffer = buffer;
    this._id = id;
  }

  id(): string {
    return this._id;
  }

  kind(): RangeSourceKind {
    return 'array-buffer';
  }

  size(): Promise<number> {
    return Promise.resolve(this._buffer.byteLength);
  }

  readRange(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) {
      return Promise.reject(new RangeReadError('aborted', 'Range read aborted'));
    }
    const clamped = clampRange(offset, length, this._buffer.byteLength);
    return Promise.resolve(this._buffer.slice(offset, offset + clamped));
  }
}
