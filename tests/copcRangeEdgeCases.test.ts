/**
 * copcRangeEdgeCases.test.ts
 *
 * laspy's `simple_with_page.copc.laz` (laspy/laspy `tests/data/`,
 * BSD-2-Clause, vendored in `tests/fixtures/las-laspy/`) streamed from a real
 * HTTP server on 127.0.0.1 through OLV's own transport: `HttpRangeSource`
 * under `CopcSource`, with node chunks decoded by `decompressChunk` and
 * `decodeRecords`. Nothing here stubs `fetch`.
 *
 * The file's hierarchy is split across pages: the root page lists child
 * pages, so a reader that only reads the root finds a fraction of the points.
 * laspy's `test_querying_copc_local_file_with_page` asserts a full query
 * returns the header's 1,065 points; the same total is the reference here.
 *
 * The server then misbehaves one way per test: it ignores Range, answers 416,
 * cuts a body short, stalls until the client cancels, or swaps the object for
 * another version partway through the load. In every case OLV has to fail
 * with a named reason or recover, and must never hand back points decoded
 * from bytes it did not ask for.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { HttpRangeSource } from '../src/io/range/HttpRangeSource';
import { RangeReadError } from '../src/io/range/RangeSource';
import { CopcSource } from '../src/io/copc/CopcSource';
import type { HierarchyPage } from '../src/io/copc/copcHierarchy';
import type { StreamingNodeRecord } from '../src/io/copc/copcTypes';
import { decompressChunk } from '../src/io/copc/copcChunkDecompress';
import { decodeRecords } from '../src/io/copc/copcChunkDecode';
import { getLazPerf } from '../src/io/lazDecode';

const FILE = readFileSync(new URL('./fixtures/las-laspy/simple_with_page.copc.laz', import.meta.url));
const SIZE = FILE.byteLength;

// ─────────────────────────────────────────────────────────────────────────────
// The server
// ─────────────────────────────────────────────────────────────────────────────

interface ObjectVersion {
  readonly bytes: Buffer;
  readonly etag?: string;
  readonly lastModified?: string;
}

interface Behaviour {
  /** The object served for request number `n` (0-based, HEAD included). */
  version(n: number): ObjectVersion;
  /** Answer a ranged GET with 200 and the whole object. */
  ignoreRange?: boolean;
  /** Leave out `Accept-Ranges` on HEAD. */
  hideAcceptRanges?: boolean;
  /** Answer 416 for a range that ends past this many bytes. */
  rangeLimit?: (n: number) => number | undefined;
  /** Send this many bytes of a range body, then cut the connection. */
  cutAfter?: number;
  /** Send only this many bytes and declare that length honestly. */
  shortBody?: number;
  /** For a range starting at this offset, send half the body and hold the rest until the client goes away. */
  stallAt?: number;
  /** Ignore If-Match (a server that does not evaluate preconditions). */
  ignoreIfMatch?: boolean;
}

interface LoggedRequest {
  readonly method: string;
  readonly range: string | undefined;
  readonly ifMatch: string | undefined;
  readonly status: number;
}

const V1: ObjectVersion = { bytes: FILE, etag: '"v1"', lastModified: 'Mon, 05 Oct 2026 10:00:00 GMT' };

let server: Server;
let url: string;
let behaviour: Behaviour = { version: () => V1 };
let log: LoggedRequest[] = [];
let stalledClosed: Promise<void> = Promise.resolve();
let onStallClosed: () => void = () => {};
let stallReached: Promise<void> = Promise.resolve();
let onStallReached: () => void = () => {};

function headersFor(v: ObjectVersion): Record<string, string> {
  return {
    ...(v.etag ? { ETag: v.etag } : {}),
    ...(v.lastModified ? { 'Last-Modified': v.lastModified } : {}),
  };
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const n = log.length;
  const v = behaviour.version(n);
  const range = req.headers.range;
  const ifMatch = req.headers['if-match'] as string | undefined;
  const record = (status: number): void => { log.push({ method: req.method ?? '', range, ifMatch, status }); };

  if (req.method === 'HEAD') {
    record(200);
    res.writeHead(200, {
      'Content-Length': String(v.bytes.byteLength),
      ...(behaviour.hideAcceptRanges ? {} : { 'Accept-Ranges': 'bytes' }),
      ...headersFor(v),
    });
    res.end();
    return;
  }
  if (ifMatch !== undefined && !behaviour.ignoreIfMatch && v.etag !== undefined && ifMatch !== v.etag) {
    record(412);
    res.writeHead(412, headersFor(v));
    res.end();
    return;
  }
  const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
  if (!m || behaviour.ignoreRange) {
    record(200);
    res.writeHead(200, { 'Content-Length': String(v.bytes.byteLength), ...headersFor(v) });
    res.end(v.bytes);
    return;
  }
  const start = Number(m[1]);
  const end = Number(m[2]);
  const limit = behaviour.rangeLimit?.(n) ?? v.bytes.byteLength;
  if (end >= limit || start >= v.bytes.byteLength) {
    record(416);
    res.writeHead(416, { 'Content-Range': `bytes */${limit}`, ...headersFor(v) });
    res.end();
    return;
  }
  const body = v.bytes.subarray(start, end + 1);
  const head = { 'Content-Range': `bytes ${start}-${end}/${v.bytes.byteLength}`, ...headersFor(v) };
  if (behaviour.stallAt !== undefined && start === behaviour.stallAt) {
    record(206);
    res.writeHead(206, { ...head, 'Content-Length': String(body.byteLength) });
    req.socket.once('close', () => onStallClosed());
    res.write(body.subarray(0, Math.floor(body.byteLength / 2)), () => onStallReached());
    return;
  }
  if (behaviour.cutAfter !== undefined && body.byteLength > behaviour.cutAfter) {
    record(206);
    res.writeHead(206, { ...head, 'Content-Length': String(body.byteLength) });
    res.write(body.subarray(0, behaviour.cutAfter), () => req.socket.destroy());
    return;
  }
  if (behaviour.shortBody !== undefined && body.byteLength > behaviour.shortBody) {
    record(206);
    res.writeHead(206, { ...head, 'Content-Length': String(behaviour.shortBody) });
    res.end(body.subarray(0, behaviour.shortBody));
    return;
  }
  record(206);
  res.writeHead(206, { ...head, 'Content-Length': String(body.byteLength) });
  res.end(body);
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/simple_with_page.copc.laz`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  behaviour = { version: () => V1 };
  log = [];
});

function serve(b: Behaviour): void {
  behaviour = b;
  log = [];
  stalledClosed = new Promise<void>((resolve) => { onStallClosed = resolve; });
  stallReached = new Promise<void>((resolve) => { onStallReached = resolve; });
}

/** A source with short retry backoff so failure paths finish quickly. */
function source(): HttpRangeSource {
  return new HttpRangeSource(url, { retryBaseMs: 1, requestTimeoutMs: 5_000 });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

// ─────────────────────────────────────────────────────────────────────────────
// Walking and decoding the whole hierarchy
// ─────────────────────────────────────────────────────────────────────────────

interface Walk {
  readonly nodes: StreamingNodeRecord[];
  readonly childPagesFollowed: number;
}

async function walk(copc: CopcSource, signal?: AbortSignal): Promise<Walk> {
  const nodes: StreamingNodeRecord[] = [];
  let childPagesFollowed = 0;
  const visit = async (page: HierarchyPage): Promise<void> => {
    expect(page.errors).toEqual([]);
    nodes.push(...page.nodes);
    for (const ref of page.childPages) {
      childPagesFollowed++;
      await visit(await copc.loadChildPage(ref, signal));
    }
  };
  await visit(copc.rootPage);
  return { nodes, childPagesFollowed };
}

/** Decode every node; return the point count and the world-space extent. */
async function decodeAll(copc: CopcSource, nodes: readonly StreamingNodeRecord[]) {
  const lazPerf = await getLazPerf();
  const { header } = copc.metadata;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let points = 0;
  for (const node of nodes) {
    const meta = {
      pointDataRecordFormat: header.pointDataRecordFormat,
      pointRecordLength: header.pointRecordLength,
      pointCount: node.pointCount,
      scale: header.scale,
      offset: header.offset,
      renderOrigin: [0, 0, 0] as [number, number, number],
    };
    const raw = decompressChunk(lazPerf, await copc.readNodeChunk(node), meta);
    const decoded = decodeRecords(raw, meta);
    points += decoded.pointCount;
    // Float32 positions at world scale lose centimetres; read the records'
    // integers directly for the extent.
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < decoded.pointCount; i++) {
      for (let k = 0; k < 3; k++) {
        const v = view.getInt32(i * meta.pointRecordLength + k * 4, true) * header.scale[k] + header.offset[k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return { points, min, max };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('COPC over HTTP: a server that answers 206', () => {
  it('follows every hierarchy page and decodes all 1,065 points', async () => {
    serve({ version: () => V1 });
    const range = source();
    expect(await range.probe()).toBe(SIZE);
    const copc = await CopcSource.open(range);
    expect(copc.metadata.header.pointCount).toBe(1065);

    // The root page alone does not hold every point: paging is real here.
    const rootPoints = copc.rootPage.nodes.reduce((s, n) => s + n.pointCount, 0);
    expect(copc.rootPage.childPages.length).toBeGreaterThan(0);
    expect(rootPoints).toBeLessThan(1065);

    const { nodes, childPagesFollowed } = await walk(copc);
    expect(childPagesFollowed).toBeGreaterThanOrEqual(copc.rootPage.childPages.length);
    expect(nodes.reduce((s, n) => s + n.pointCount, 0)).toBe(1065);

    const { points, min, max } = await decodeAll(copc, nodes);
    expect(points).toBe(1065);
    // laspy tests/test_reading_1_2.py X/Y/Z ranges for the same cloud.
    expect(min.map((v) => Math.round(v * 100))).toEqual([63561985, 84889970, 40659]);
    expect(max.map((v) => Math.round(v * 100))).toEqual([63898255, 85353543, 58638]);

    // Every GET was a range read, and none of them asked for the whole file.
    const gets = log.filter((r) => r.method === 'GET');
    expect(gets.length).toBeGreaterThan(0);
    expect(gets.every((r) => r.range !== undefined && r.status === 206)).toBe(true);
    // A strong ETag was pinned at probe time and sent as a precondition.
    expect(gets.every((r) => r.ifMatch === '"v1"')).toBe(true);
  });
});

describe('COPC over HTTP: a server that ignores Range and returns 200', () => {
  it('is refused at the probe when HEAD does not advertise ranges', async () => {
    serve({ version: () => V1, ignoreRange: true, hideAcceptRanges: true });
    const err = await rejection(source().probe());
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('range-unsupported');
  });

  it('is refused at the first read when HEAD claims ranges it does not serve', async () => {
    serve({ version: () => V1, ignoreRange: true });
    const range = source();
    await range.probe();
    const err = await rejection(CopcSource.open(range));
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('range-unsupported');
    expect((err as Error).message).toMatch(/ignored the range request/);
  });
});

describe('COPC over HTTP: 416 Range Not Satisfiable', () => {
  it('a 416 naming a different object size is reported as the object having changed', async () => {
    // The object shrank on the server after the probe: every range read past
    // its new end is answered 416 with the new size.
    const shrunk = 20_000;
    serve({ version: () => V1, rangeLimit: (n) => (n === 0 ? undefined : shrunk) });
    const range = source();
    expect(await range.probe()).toBe(SIZE);
    const copc = await CopcSource.open(range).catch((e: unknown) => e);
    // The root hierarchy page sits near the end of the file, past 20,000.
    expect(copc).toBeInstanceOf(RangeReadError);
    expect((copc as RangeReadError).code).toBe('resource-changed');
  });
});

describe('COPC over HTTP: a truncated body', () => {
  it('a connection cut partway through a node is refused, with no points decoded', async () => {
    serve({ version: () => V1 });
    const range = source();
    const copc = await CopcSource.open(range);
    const { nodes } = await walk(copc);
    const node = [...nodes].sort((a, b) => b.byteSize - a.byteSize)[0];
    behaviour = { version: () => V1, cutAfter: Math.floor(node.byteSize / 2) };
    const err = await rejection(copc.readNodeChunk(node));
    expect(err).toBeInstanceOf(RangeReadError);
    expect(['transport', 'content-mismatch']).toContain((err as RangeReadError).code);
  });

  it('a body shorter than the range, with its length declared, is refused', async () => {
    serve({ version: () => V1 });
    const copc = await CopcSource.open(source());
    const { nodes } = await walk(copc);
    const node = [...nodes].sort((a, b) => b.byteSize - a.byteSize)[0];
    behaviour = { version: () => V1, shortBody: node.byteSize - 7 };
    const err = await rejection(copc.readNodeChunk(node));
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('content-mismatch');
  });
});

describe('COPC over HTTP: cancellation mid-request', () => {
  it('an abort while a node body is arriving rejects promptly, and the next read succeeds', async () => {
    serve({ version: () => V1 });
    const range = source();
    const copc = await CopcSource.open(range);
    const { nodes } = await walk(copc);
    const node = nodes[0];
    serve({ version: () => V1, stallAt: node.byteOffset });

    const controller = new AbortController();
    const started = Date.now();
    const pending = rejection(copc.readNodeChunk(node, controller.signal));
    // Cancel while the body is arriving: half of it has been sent.
    await stallReached;
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const err = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('aborted');
    // The client let go of the connection.
    await stalledClosed;

    // Recovery: the same source reads the node once the server answers.
    behaviour = { version: () => V1 };
    const chunk = await copc.readNodeChunk(node);
    expect(chunk.byteLength).toBe(node.byteSize);
  });
});

describe('COPC over HTTP: the object changes between requests', () => {
  const V2_SAME_SIZE: ObjectVersion = {
    // A different object of the same size: every byte past the header flipped.
    bytes: Buffer.concat([FILE.subarray(0, 375), Buffer.from(FILE.subarray(375).map((b) => b ^ 0xff))]),
    etag: '"v2"',
    lastModified: 'Tue, 06 Oct 2026 10:00:00 GMT',
  };

  it('a server that evaluates If-Match answers 412, reported as the object having changed', async () => {
    serve({ version: (n) => (n < 2 ? V1 : V2_SAME_SIZE) });
    const range = source();
    await range.probe();
    const err = await rejection(CopcSource.open(range).then(walk));
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('resource-changed');
    expect(log.some((r) => r.status === 412)).toBe(true);
  });

  it('a server that ignores If-Match but sends the new ETag is caught by the client check', async () => {
    serve({ version: (n) => (n < 2 ? V1 : V2_SAME_SIZE), ignoreIfMatch: true });
    const range = source();
    await range.probe();
    const err = await rejection(CopcSource.open(range).then(walk));
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('resource-changed');
    expect(log.every((r) => r.status !== 412)).toBe(true);
  });

  it('with no ETag, a changed Last-Modified is caught', async () => {
    const v1 = { bytes: FILE, lastModified: V1.lastModified };
    const v2 = { bytes: V2_SAME_SIZE.bytes, lastModified: V2_SAME_SIZE.lastModified };
    serve({ version: (n) => (n < 2 ? v1 : v2) });
    const range = source();
    await range.probe();
    const err = await rejection(CopcSource.open(range).then(walk));
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('resource-changed');
  });

  it('a change between node reads stops the decode instead of mixing versions', async () => {
    serve({ version: () => V1 });
    const range = source();
    await range.probe();
    const copc = await CopcSource.open(range);
    const { nodes } = await walk(copc);
    const served = log.length;
    behaviour = { version: (n) => (n < served + 1 ? V1 : V2_SAME_SIZE), ignoreIfMatch: true };
    const first = await copc.readNodeChunk(nodes[0]);
    expect(Buffer.from(first).equals(FILE.subarray(nodes[0].byteOffset, nodes[0].byteOffset + nodes[0].byteSize))).toBe(true);
    const err = await rejection(copc.readNodeChunk(nodes[1]));
    expect(err).toBeInstanceOf(RangeReadError);
    expect((err as RangeReadError).code).toBe('resource-changed');
  });
});
