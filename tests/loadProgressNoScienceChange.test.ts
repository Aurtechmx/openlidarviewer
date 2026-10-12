/**
 * loadProgressNoScienceChange.test.ts: reporting read progress changes nothing
 * a load produces.
 *
 * The same file is loaded twice through `loadFile`, once with every progress
 * callback attached (which turns on the byte-progress read) and once with
 * none. The parse runs in-process through the same `parseBuffer` the worker
 * runs. The plan sent to the decode, the stride, the positions, the origin, the
 * counts and every attribute must be identical. Two cases: a LAS read as a
 * sample (stride plan), and an E57 whose scan carries a pose.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildLas } from './helpers/rawLas';
import { loadFile, __setParseWorkerFactoryForTests } from '../src/io/loadFile';
import type { LoadResult, ProgressUpdate } from '../src/io/loadFile';
import { parseBuffer } from '../src/io/parseBuffer';
import { crc32c } from '../src/io/e57/crc32c';

/** Runs the real parse in-process and replies the way the worker does. */
class InProcessParseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    const req = message as Record<string, unknown>;
    this.requests.push(req);
    void (async () => {
      const { cloud, originalPointCount, downsampled } = await parseBuffer(
        req.buffer as ArrayBuffer,
        req.format as never,
        req.name as string,
        req.budget as number,
        req.plan as never,
        undefined,
        req.e57Plan as never,
      );
      const payload: Record<string, unknown> = {};
      for (const key of Object.keys(cloud)) payload[key] = (cloud as unknown as Record<string, unknown>)[key];
      payload.origin = cloud.sourceOrigin ?? (cloud as unknown as { origin: unknown }).origin;
      this.onmessage?.({ data: { type: 'done', cloud: payload, originalPointCount, downsampled, telemetry: {} } } as MessageEvent);
    })().catch((err) => this.onmessage?.({ data: { type: 'error', error: String(err) } } as MessageEvent));
  }
  terminate(): void { /* nothing held */ }
}

afterEach(() => __setParseWorkerFactoryForTests(undefined));

async function loadTwice(make: () => File, options: Parameters<typeof loadFile>[2]) {
  const run = async (withProgress: boolean) => {
    const worker = new InProcessParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const updates: ProgressUpdate[] = [];
    const result = await loadFile(
      make(),
      withProgress ? { onProgress: (u) => updates.push(u), onPreload: () => {} } : {},
      options,
    );
    return { result, request: worker.requests[0], updates };
  };
  return { on: await run(true), off: await run(false) };
}

/** Every array-valued and scalar field of a cloud that a decode decides. */
function science(r: LoadResult) {
  const c = r.cloud as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(c).sort()) {
    const v = c[key];
    if (ArrayBuffer.isView(v)) fields[key] = digest(v);
    else if (typeof v !== 'function') fields[key] = v;
  }
  return {
    fields,
    origin: r.cloud.sourceOrigin,
    count: r.cloud.pointCount,
    originalPointCount: r.originalPointCount,
    downsampled: r.downsampled,
  };
}

function planOf(req: Record<string, unknown>) {
  const { buffer, ...rest } = req;
  return { ...rest, bytes: digest(new Uint8Array(buffer as ArrayBuffer)) };
}

/** A typed array's exact bytes, as type, length and SHA-256. */
function digest(v: ArrayBufferView): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return `${v.constructor.name}:${v.byteLength}:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('progress reporting leaves a load unchanged', () => {
  it('a sampled LAS: same plan, stride, positions, origin, counts and attributes', async () => {
    // More records than the budget band holds, so the plan samples (stride 2).
    const points = Array.from({ length: 760_000 }, (_, i) => ({ cls: i % 7, angle: (i % 30) - 15 }));
    const bytes = buildLas({ version: '1.2', pdrf: 3, points });
    const { on, off } = await loadTwice(() => new File([bytes as Uint8Array<ArrayBuffer>], 'sampled.las'), { budget: 250_000 });
    const plan = on.request.plan as { mode: string; stride: number };
    expect(plan.mode).toBe('stride');
    expect(plan.stride).toBeGreaterThan(1);
    expect(planOf(on.request)).toEqual(planOf(off.request));
    expect(science(on.result)).toEqual(science(off.result));
    // The run with progress did report the read, in bytes, ending at the size.
    const reads = on.updates.filter((u) => u.stage === 'reading-file');
    expect(reads.at(-1)?.fraction).toBe(1);
  });

  it('an E57 with a scan pose: same plan, positions, origin, counts and attributes', async () => {
    const file = buildPosedE57(3000);
    const { on, off } = await loadTwice(() => new File([file], 'posed.e57'), {});
    expect(on.request.e57Plan).toBeDefined();
    expect(planOf(on.request)).toEqual(planOf(off.request));
    const a = science(on.result);
    expect(a).toEqual(science(off.result));
    expect(a.count).toBe(3000);
    // The pose was applied (a 90° turn about Z and a translation), so this
    // compares posed geometry, not raw records.
    const p = on.result.cloud.positions;
    const o = on.result.cloud.sourceOrigin ?? [0, 0, 0];
    expect(p[3] + o[0]).toBeCloseTo(100 - 2, 3); // record 1 is (1, 2, 3): x' = tx - y
    expect(p[4] + o[1]).toBeCloseTo(200 + 1, 3); //                         y' = ty + x
    expect(p[5] + o[2]).toBeCloseTo(300 + 3, 3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A small checksum-correct E57 with one posed scan (same layout as the builder
// in e57StrideDecode.test.ts, plus a <pose>).
// ────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1024;
const PAGE_PAYLOAD = PAGE_SIZE - 4;

function logicalToPhysical(logical: number): number {
  return Math.floor(logical / PAGE_PAYLOAD) * PAGE_SIZE + (logical % PAGE_PAYLOAD);
}

function posedXml(records: number, fileOffset: number): string {
  const h = Math.SQRT1_2;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<e57Root type="Structure">\n' +
    '  <formatName type="String">ASTM E57 3D Imaging Data File</formatName>\n' +
    '  <guid type="String">posed-fixture-0000-0000-000000000001</guid>\n' +
    '  <data3D type="Vector" allowHeterogeneousChildren="1">\n' +
    '    <vectorChild type="Structure">\n' +
    '      <guid type="String">posed-fixture-scan-0000-000000000001</guid>\n' +
    '      <name type="String">posed</name>\n' +
    '      <pose type="Structure">' +
    `<rotation type="Structure"><w type="Float">${h}</w><x type="Float">0</x><y type="Float">0</y><z type="Float">${h}</z></rotation>` +
    '<translation type="Structure"><x type="Float">100</x><y type="Float">200</y><z type="Float">300</z></translation>' +
    '</pose>\n' +
    `      <points type="CompressedVector" fileOffset="${fileOffset}" recordCount="${records}">\n` +
    '        <prototype type="Structure">\n' +
    '          <cartesianX type="Float" precision="single"/>\n' +
    '          <cartesianY type="Float" precision="single"/>\n' +
    '          <cartesianZ type="Float" precision="single"/>\n' +
    '          <intensity type="Integer" minimum="0" maximum="255"/>\n' +
    '        </prototype>\n' +
    '        <codecs type="Vector" allowHeterogeneousChildren="1"/>\n' +
    '      </points>\n' +
    '    </vectorChild>\n' +
    '  </data3D>\n' +
    '</e57Root>\n'
  );
}

function posedSection(records: number, sectionLogicalStart: number): Uint8Array {
  const axes = [0, 1, 2].map(() => new Uint8Array(records * 4));
  const views = axes.map((a) => new DataView(a.buffer));
  const intensity = new Uint8Array(records);
  for (let i = 0; i < records; i++) {
    views[0].setFloat32(i * 4, i, true);
    views[1].setFloat32(i * 4, 2 * i, true);
    views[2].setFloat32(i * 4, 3 * i, true);
    intensity[i] = (i * 7) % 256;
  }
  const streams = [...axes, intensity];
  const headerLen = 6 + streams.length * 2;
  const packetLength = headerLen + streams.reduce((a, s) => a + s.length, 0);
  const packet = new Uint8Array(packetLength);
  const pv = new DataView(packet.buffer);
  packet[0] = 1;
  pv.setUint16(2, packetLength - 1, true);
  pv.setUint16(4, streams.length, true);
  streams.forEach((s, f) => pv.setUint16(6 + f * 2, s.length, true));
  let at = headerLen;
  for (const s of streams) { packet.set(s, at); at += s.length; }
  const sectionLength = 32 + packet.length;
  const section = new Uint8Array(sectionLength);
  const dv = new DataView(section.buffer);
  section[0] = 1;
  dv.setBigUint64(8, BigInt(sectionLength), true);
  dv.setBigUint64(16, BigInt(logicalToPhysical(sectionLogicalStart + 32)), true);
  section.set(packet, 32);
  return section;
}

function buildPosedE57(records: number): ArrayBuffer {
  const HEADER_LEN = 48;
  let fileOffset = 0;
  let xml = posedXml(records, fileOffset);
  for (let pass = 0; pass < 4; pass++) {
    const next = logicalToPhysical(HEADER_LEN + Buffer.byteLength(xml, 'utf8'));
    if (next === fileOffset) break;
    fileOffset = next;
    xml = posedXml(records, fileOffset);
  }
  const xmlBytes = Buffer.from(xml, 'utf8');
  const sectionLogicalStart = HEADER_LEN + xmlBytes.length;
  if (logicalToPhysical(sectionLogicalStart) !== fileOffset) throw new Error('fileOffset did not converge');
  const section = posedSection(records, sectionLogicalStart);
  const logicalLength = sectionLogicalStart + section.length;
  const logical = new Uint8Array(logicalLength);
  const hv = new DataView(logical.buffer);
  const sig = 'ASTM-E57';
  for (let i = 0; i < sig.length; i++) logical[i] = sig.charCodeAt(i);
  hv.setUint32(8, 1, true);
  hv.setUint32(12, 0, true);
  hv.setBigUint64(24, BigInt(logicalToPhysical(HEADER_LEN)), true);
  hv.setBigUint64(32, BigInt(xmlBytes.length), true);
  hv.setBigUint64(40, BigInt(PAGE_SIZE), true);
  logical.set(xmlBytes, HEADER_LEN);
  logical.set(section, sectionLogicalStart);
  const pageCount = Math.ceil(logicalLength / PAGE_PAYLOAD);
  hv.setBigUint64(16, BigInt(pageCount * PAGE_SIZE), true);
  const physical = new Uint8Array(pageCount * PAGE_SIZE);
  for (let p = 0; p < pageCount; p++) {
    const dst = physical.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    dst.set(logical.subarray(p * PAGE_PAYLOAD, (p + 1) * PAGE_PAYLOAD), 0);
    new DataView(dst.buffer, dst.byteOffset + PAGE_PAYLOAD, 4).setUint32(0, crc32c(dst, 0, PAGE_PAYLOAD), false);
  }
  return physical.buffer;
}
