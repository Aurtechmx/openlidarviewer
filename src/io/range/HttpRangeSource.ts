/**
 * HttpRangeSource.ts
 *
 * A {@link RangeSource} backed by HTTP Range requests against a remote URL.
 *
 * `probe()` performs the HEAD request and verifies the server can serve byte
 * ranges; `readRange()` issues real `Range:` requests. This drives the v0.3.0
 * remote-COPC flow — the "open from URL" field and the `?copc=<url>` deep
 * link — so a Cloud Optimized Point Cloud hosted on a CORS-enabled server
 * streams exactly like a local file.
 *
 * Pure of three.js; uses `fetch`, which is available on both the main thread
 * and in workers.
 */

import type { RangeSource, RangeSourceKind } from './RangeSource';
import { RangeReadError, clampRange } from './RangeSource';

/** A range-readable source over a remote URL using HTTP Range requests. */
export class HttpRangeSource implements RangeSource {
  private readonly _url: string;
  private _size: number | undefined;

  constructor(url: string) {
    this._url = url;
  }

  id(): string {
    return this._url;
  }

  kind(): RangeSourceKind {
    return 'http-range';
  }

  /**
   * HEAD the URL and verify the server can serve byte ranges: it must report
   * `Accept-Ranges: bytes` and a usable `Content-Length`. Throws a clear,
   * categorised {@link RangeReadError} otherwise — `range-unsupported` for a
   * server that cannot do ranges, `transport` for an unreachable or erroring
   * URL — so the caller can show an honest message instead of a silent
   * full-file fallback.
   */
  async probe(signal?: AbortSignal): Promise<number> {
    let response: Response;
    try {
      response = await fetch(this._url, { method: 'HEAD', signal });
    } catch {
      if (signal?.aborted) throw new RangeReadError('aborted', 'Probe aborted');
      throw new RangeReadError(
        'transport',
        `Could not reach ${this._url} — check the URL and that the server allows cross-origin requests.`,
      );
    }
    if (!response.ok) {
      throw new RangeReadError(
        'transport',
        `Server returned ${response.status} for ${this._url}`,
      );
    }
    if (response.headers.get('accept-ranges') !== 'bytes') {
      throw new RangeReadError(
        'range-unsupported',
        'This server does not support HTTP range requests, so it cannot stream COPC.',
      );
    }
    const length = Number(response.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0) {
      throw new RangeReadError(
        'range-unsupported',
        'This server did not report a usable Content-Length.',
      );
    }
    this._size = length;
    return length;
  }

  async size(): Promise<number> {
    if (this._size === undefined) await this.probe();
    return this._size as number;
  }

  async readRange(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new RangeReadError('aborted', 'Range read aborted');
    const total = await this.size();
    const clamped = clampRange(offset, length, total);
    if (clamped === 0) return new ArrayBuffer(0);

    const end = offset + clamped - 1;
    let response: Response;
    try {
      response = await fetch(this._url, {
        headers: { Range: `bytes=${offset}-${end}` },
        signal,
      });
    } catch {
      if (signal?.aborted) throw new RangeReadError('aborted', 'Range read aborted');
      throw new RangeReadError('transport', `Range read failed for ${this._url}`);
    }
    // 206 Partial Content is the expected success. A 200 means the server
    // ignored the Range header and is sending the whole file — that defeats
    // streaming, so it is treated as range-unsupported rather than accepted.
    if (response.status === 200) {
      throw new RangeReadError(
        'range-unsupported',
        'This server ignored the range request and returned the whole file.',
      );
    }
    if (response.status !== 206) {
      throw new RangeReadError(
        'transport',
        `Range read returned an unexpected status ${response.status}`,
      );
    }
    return response.arrayBuffer();
  }
}
