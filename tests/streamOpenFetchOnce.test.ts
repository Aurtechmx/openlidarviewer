/**
 * A remote COPC open fetches each piece of source metadata exactly once:
 * one HEAD probe, one read of the header prefix, one read of the root
 * hierarchy page. Guards against a streaming source being opened twice.
 */
import { test, expect } from 'vitest';
import { HttpRangeSource } from '../src/io/range/HttpRangeSource';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';

test('remote COPC open fetches HEAD, header and root hierarchy once each', async () => {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }],
  });
  const bytes = new Uint8Array(fixture.buffer);
  const total = bytes.byteLength;
  const calls: string[] = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (init?.method === 'HEAD') {
      calls.push('HEAD');
      return new Response(null, {
        status: 200,
        headers: { 'accept-ranges': 'bytes', 'content-length': String(total), etag: '"v1"' },
      });
    }
    const m = /bytes=(\d+)-(\d+)/.exec(h.get('range') ?? '');
    if (!m) throw new Error('unranged GET');
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), total - 1);
    calls.push(`GET ${a}-${b}`);
    return new Response(bytes.slice(a, b + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${a}-${b}/${total}`, etag: '"v1"' },
    });
  }) as unknown as typeof fetch;

  const range = new HttpRangeSource('https://data.example.org/s.copc.laz', { fetchImpl });
  await range.probe();
  const cloud = await StreamingPointCloud.open(range, 's.copc.laz');
  expect(cloud.kind).toBe('copc');

  expect(calls.filter((c) => c === 'HEAD')).toHaveLength(1);
  const gets = calls.filter((c) => c.startsWith('GET'));
  expect(new Set(gets).size).toBe(gets.length); // no range fetched twice
  expect(gets).toHaveLength(2); // header prefix + root hierarchy
});
