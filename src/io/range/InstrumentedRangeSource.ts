/**
 * InstrumentedRangeSource.ts
 *
 * A thin delegating wrapper around any {@link RangeSource} that reports each
 * read's byte length to a callback. The streaming benchmark uses this to
 * accumulate cumulative network bytes for a session, while the inner source
 * (a local file, an in-memory buffer, or an HTTP range source) is unchanged.
 *
 * Pure — no DOM, no three.js.
 */

import type { RangeSource, RangeSourceKind } from './RangeSource';

/** A {@link RangeSource} that emits a `bytes` callback for each completed read. */
export class InstrumentedRangeSource implements RangeSource {
  private readonly _inner: RangeSource;
  private readonly _onBytes: (bytes: number) => void;

  constructor(inner: RangeSource, onBytes: (bytes: number) => void) {
    this._inner = inner;
    this._onBytes = onBytes;
  }

  id(): string {
    return this._inner.id();
  }

  kind(): RangeSourceKind {
    return this._inner.kind();
  }

  size(): Promise<number> {
    return this._inner.size();
  }

  async readRange(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const buffer = await this._inner.readRange(offset, length, signal);
    this._onBytes(buffer.byteLength);
    return buffer;
  }

  async close(): Promise<void> {
    if (this._inner.close) await this._inner.close();
  }
}
