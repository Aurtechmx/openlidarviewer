/**
 * Node half of the Zenodo 15421291 small-file study. Run by
 * `scripts/zenodo-study/run.mjs`, never by the default test run.
 *
 * Inputs (environment): ZENODO_STUDY_INPUT, the hash-checked iPhone.laz;
 * ZENODO_STUDY_OUT, the results folder.
 *
 * Paths exercised, all through production modules:
 *   serial  loadLazFromFile with the pool refused, so the whole-file laz-perf
 *           decode and the loader's own frame handling run
 *   copc    StreamingPointCloud.open over a local range source (hierarchy
 *           walk, node range reads), then every data node decoded once with
 *           the decompress and record-decode functions the COPC worker runs
 *   export  convertCloud to LAS 1.4 from the serial cloud, CRS kept, assigned
 *           and taken from a user override
 *   crs     CrsService resolution with no declaration, with a catalogue
 *           record, and with a user override; session round trip
 *
 * Each path writes canonical records (canonical.mjs) and a JSON summary. The
 * comparison itself is done by run.mjs, so a failed path still leaves its
 * output for inspection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadLas, loadLazFromFile, type LazLoadStats } from '../../src/io/loadLas';
import { ArrayBufferRangeSource } from '../../src/io/range/ArrayBufferRangeSource';
import { recommendColorMode } from '../../src/render/colorModeRecommend';
import { readRgbReadability } from '../../src/render/rgbReadability';
import { groundMetresPermitted, horizontalGroundRefusal } from '../../src/geo/SpatialContext';
import { DEV_FLAG_DEFAULTS, primeDevFlags } from '../../src/perf/devFlags';
import { cloudToGlobal } from '../../src/convert/globalPoints';
import { sourcePositions } from '../../src/model/pointFrames';
import { LocalFileRangeSource } from '../../src/io/range/LocalFileRangeSource';
import { StreamingPointCloud } from '../../src/render/streaming/StreamingPointCloud';
import { getLazPerf } from '../../src/io/lazDecode';
import { decompressChunk } from '../../src/io/copc/copcChunkDecompress';
import { decodeRecords } from '../../src/io/copc/copcChunkDecode';
import { keyId } from '../../src/io/copc/voxelKey';
import { convertCloud } from '../../src/convert/convertCloud';
import { CrsService, type CrsOverridePort } from '../../src/geo/CrsService';
import { parseResolvedCrs } from '../../src/io/sessionCrs';
import { crsFromEpsg } from '../../src/io/crs';
import { exportDigests } from '../../src/science/exportDigestRecord';
import type { PointCloud } from '../../src/model/PointCloud';
// @ts-expect-error plain ESM helper without type declarations
import { canonicalFromGlobal, integerBounds } from './canonical.mjs';

const INPUT = process.env.ZENODO_STUDY_INPUT ?? '';
const OUT = process.env.ZENODO_STUDY_OUT ?? '';
const NAME = 'iPhone.laz';

/** The publisher's statement of the frame, recorded with where it was read. */
const PUBLISHER_ASSERTION = 'Zenodo 10.5281/zenodo.15421291 record description (EPSG:5514)';

function inputFile(): File {
  const b = readFileSync(INPUT);
  return new File([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer], NAME);
}

function write(name: string, canonical: { records: Uint8Array; count: number; fields: string[]; stats: unknown }, extra: Record<string, unknown>): void {
  writeFileSync(join(OUT, `${name}.records.bin`), canonical.records);
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({
    canonical: { file: `${name}.records.bin`, count: canonical.count, fields: canonical.fields },
    representation: canonical.stats,
    integerBounds: integerBounds(canonical),
    ...extra,
  }, null, 2));
}

function quantisation(cloud: PointCloud): { scale: number[]; offset: number[] } {
  const q = cloud.metadata?.sourceQuantisation;
  if (!q) throw new Error('the loader kept no source quantisation');
  return { scale: [...q.scale], offset: [...q.offset] };
}

function memoryPort(seed?: Record<string, unknown>): CrsOverridePort {
  const m = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: (k) => m.get(k) as ReturnType<CrsOverridePort['get']>,
    set: (k, v) => void m.set(k, v),
    clear: (k) => void m.delete(k),
  };
}

function digest(a: ArrayBufferView): string {
  return createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
}

let serialCloud: PointCloud | undefined;

describe.runIf(INPUT && OUT)('Zenodo 15421291 iPhone.laz, Node paths', () => {
  it('serial: whole-file decode with the pool refused', async () => {
    let stats: LazLoadStats | undefined;
    const policy = { flags: { ...DEV_FLAG_DEFAULTS, decodePoolOff: true }, isMobile: false };
    const t0 = performance.now();
    const cloud = await loadLazFromFile(inputFile(), NAME, 1, undefined, undefined, (s) => { stats = s; }, policy, undefined, true);
    const ms = performance.now() - t0;
    serialCloud = cloud;
    const g = cloudToGlobal(cloud);
    const c = canonicalFromGlobal(g, quantisation(cloud), { local: sourcePositions(cloud) });
    write('serial', c, {
      path: 'serial',
      decodePath: stats?.decodePath,
      poolFallbackReason: stats?.poolFallbackReason,
      declaredPointCount: cloud.declaredPointCount,
      decodedPointCount: cloud.decodedPointCount,
      pointCount: cloud.pointCount,
      loadStride: cloud.loadStride,
      origin: [...cloud.sourceOrigin],
      sourceQuantisation: cloud.metadata?.sourceQuantisation,
      pointFormat: cloud.metadata?.pointFormat,
      crs: cloud.metadata?.crs ?? null,
      normals: cloud.normals ? 'present' : 'absent',
      loadWarning: cloud.metadata?.loadWarning ?? null,
      decodeMs: Math.round(ms),
    });
    expect(stats?.decodePath).toBe('whole-file');
    expect(cloud.pointCount).toBe(cloud.declaredPointCount);
  });

  const copcRun = async (name: string, rangeKind: 'array-buffer' | 'local-file', order: 'hierarchy' | 'reversed') => {
    const file = inputFile();
    const range = rangeKind === 'array-buffer' ? new ArrayBufferRangeSource(await file.arrayBuffer(), NAME) : new LocalFileRangeSource(file);
    const stream = await StreamingPointCloud.open(range, NAME);
    const octree = stream.octree;
    const nodes = octree.nodes().map((n) => n.record);
    // Every hierarchy entry, read again from the pages, so a duplicate key the
    // store collapsed would show as a count difference.
    const pageEntries: string[] = [...stream.source.rootPage.nodes.map((r) => keyId(r.key))];
    let frontier = stream.source.rootPage.childPages.slice();
    const emptyKeys = stream.source.rootPage.emptyKeys.length;
    let pages = 1;
    let pageErrors = stream.source.rootPage.errors.length;
    while (frontier.length) {
      const next: typeof frontier = [];
      for (const ref of frontier) {
        const page = await stream.source.loadChildPage(ref);
        pages++;
        pageErrors += page.errors.length;
        pageEntries.push(...page.nodes.map((r) => keyId(r.key)));
        next.push(...page.childPages);
      }
      frontier = next;
    }
    const ids = nodes.map((r) => r.id);
    const byOffset = [...nodes].sort((a, b) => a.byteOffset - b.byteOffset);
    let overlaps = 0;
    for (let i = 1; i < byOffset.length; i++) {
      if (byOffset[i].byteOffset < byOffset[i - 1].byteOffset + byOffset[i - 1].byteSize) overlaps++;
    }
    const declared = stream.metadata.header.pointCount;
    const hierarchySum = nodes.reduce((s, r) => s + r.pointCount, 0);

    const lazPerf = await getLazPerf();
    const total = hierarchySum;
    const x = new Float64Array(total);
    const y = new Float64Array(total);
    const z = new Float64Array(total);
    const attrs: Record<string, Uint8Array | Uint16Array | Float64Array | Float32Array> = {};
    const present = new Set<string>();
    let at = 0;
    let decodedNodes = 0;
    let shortNodes = 0;
    const [rx, ry, rz] = stream.renderOrigin;
    const t0 = performance.now();
    const visit = order === 'reversed' ? [...nodes].reverse() : nodes;
    let firstRgbEightBit: boolean | undefined;
    for (const r of visit) {
      const chunk = await stream.readNodeChunk(r);
      const meta = stream.decodeMeta(r);
      const d = decodeRecords(decompressChunk(lazPerf, chunk, meta), meta);
      stream.noteDecodedRgbDepth(d.rgbEightBit);
      if (firstRgbEightBit === undefined) firstRgbEightBit = d.rgbEightBit;
      decodedNodes++;
      if (d.pointCount !== r.pointCount) shortNodes++;
      for (let i = 0; i < d.pointCount; i++) {
        // The renderer's frame: float32 local about the render origin.
        x[at + i] = d.positions[i * 3] + rx;
        y[at + i] = d.positions[i * 3 + 1] + ry;
        z[at + i] = d.positions[i * 3 + 2] + rz;
      }
      const copy = (key: string, src: ArrayLike<number> | undefined, width: number, Ctor: new (n: number) => Uint8Array | Uint16Array | Float64Array | Float32Array) => {
        if (!src) return;
        present.add(key);
        attrs[key] ??= new Ctor(total * width);
        (attrs[key] as unknown as { set(a: ArrayLike<number>, o: number): void }).set(src, at * width);
      };
      copy('intensity', d.intensity, 1, Uint16Array);
      copy('classification', d.classification, 1, Uint8Array);
      copy('classificationFlags', d.classificationFlags, 1, Uint8Array);
      copy('returnNumber', d.returnNumber, 1, Uint8Array);
      copy('returnCount', d.returnCount, 1, Uint8Array);
      copy('pointSourceId', d.pointSourceId, 1, Uint16Array);
      copy('gpsTime', d.gpsTime, 1, Float64Array);
      copy('colors', d.rgb, 3, Uint8Array);
      copy('scanAngle', d.scanAngle, 1, Float32Array);
      copy('userData', d.userData, 1, Uint8Array);
      copy('scannerChannel', d.scannerChannel, 1, Uint8Array);
      copy('scanDirection', d.scanDirection, 1, Uint8Array);
      copy('edgeOfFlightLine', d.edgeOfFlightLine, 1, Uint8Array);
      at += d.pointCount;
    }
    const ms = performance.now() - t0;
    const local = new Float32Array(at * 3);
    for (let i = 0; i < at; i++) {
      local[i * 3] = x[i] - rx;
      local[i * 3 + 1] = y[i] - ry;
      local[i * 3 + 2] = z[i] - rz;
    }
    const h = stream.metadata.header;
    const g = { count: at, x: x.subarray(0, at), y: y.subarray(0, at), z: z.subarray(0, at), ...attrs };
    const c = canonicalFromGlobal(g, { scale: [...h.scale], offset: [...h.offset] }, { local });
    write(name, c, {
      path: name,
      rangeSource: rangeKind,
      nodeOrder: order,
      firstNodeId: visit[0]?.id,
      rgbEightBitDecision: firstRgbEightBit ?? null,
      declaredPointCount: declared,
      hierarchy: {
        pages,
        pageErrors,
        octreeErrors: octree.errors,
        isComplete: octree.isComplete,
        pointTotals: octree.pointTotals,
        dataNodes: nodes.length,
        pageEntries: pageEntries.length,
        distinctPageEntries: new Set(pageEntries).size,
        distinctNodeIds: new Set(ids).size,
        emptyRootKeys: emptyKeys,
        overlappingByteRanges: overlaps,
        hierarchyPointSum: hierarchySum,
        maxDepth: Math.max(...nodes.map((r) => r.key.depth)),
      },
      decodedNodes,
      shortNodes,
      decodedPoints: at,
      renderOrigin: [rx, ry, rz],
      crs: h.crs ?? null,
      attributesDecoded: [...present].sort(),
      decodeMs: Math.round(ms),
    });
    expect(decodedNodes).toBe(nodes.length);
    return { stream, nodes, lazPerf };
  };

  it('copc: hierarchy, node coverage and every data node decoded once (ArrayBufferRangeSource)', async () => {
    await copcRun('copc', 'array-buffer', 'hierarchy');
  });

  it('copc: the same nodes in reverse order over a local File range source', async () => {
    await copcRun('copc-reversed', 'local-file', 'reversed');
  });

  it('copc negative controls: truncated node, cancelled read, invalid range', async () => {
    const { stream, nodes, lazPerf } = await copcRun('copc-controls', 'array-buffer', 'hierarchy');
    const big = [...nodes].sort((a, b) => b.pointCount - a.pointCount)[0];
    const outcome = async (f: () => Promise<unknown>) => {
      try {
        const v = await f();
        return { threw: false, result: v };
      } catch (e) {
        return { threw: true, name: (e as Error).name, code: (e as { code?: string }).code ?? null, message: String((e as Error).message).slice(0, 200) };
      }
    };
    const chunk = await stream.readNodeChunk(big);
    const truncated = await outcome(async () => {
      const meta = stream.decodeMeta(big);
      const d = decodeRecords(decompressChunk(lazPerf, chunk.slice(0, Math.floor(chunk.byteLength / 2)), meta), meta);
      // Count decoded points that fall outside the header bounds: the decoder
      // has no end-of-chunk marker to check, so what it makes of missing bytes
      // is recorded rather than assumed.
      const h = stream.metadata.header;
      let outside = 0;
      for (let i = 0; i < d.pointCount; i++) {
        for (let a = 0; a < 3; a++) {
          const w = d.positions[i * 3 + a] + stream.renderOrigin[a];
          if (w < h.min[a] - 0.001 || w > h.max[a] + 0.001) { outside++; break; }
        }
      }
      return { decodedPoints: d.pointCount, nodePoints: big.pointCount, outsideHeaderBounds: outside };
    });
    const ac = new AbortController();
    ac.abort();
    const cancelled = await outcome(() => stream.readNodeChunk(big, ac.signal));
    const invalid = await outcome(() => stream.readNodeChunk({ ...big, byteOffset: 50_000_000, byteSize: 4096 }));
    const negative = await outcome(() => stream.readNodeChunk({ ...big, byteOffset: -1, byteSize: 4096 }));
    writeFileSync(join(OUT, 'negative-controls.json'), JSON.stringify({ node: big.id, nodePoints: big.pointCount, chunkBytes: chunk.byteLength, truncated, cancelled, rangePastEnd: invalid, negativeOffset: negative }, null, 2));
  });

  it('full file: loadLas on the whole buffer', async () => {
    const b = readFileSync(INPUT);
    const hadWorker = typeof (globalThis as { Worker?: unknown }).Worker !== 'undefined';
    // Node has no Worker, so refuse the pool the way the app's ?decodePool=off does.
    primeDevFlags('?decodePool=off');
    const cloud = await loadLas(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, 'laz', NAME, 1, undefined, true);
    const c = canonicalFromGlobal(cloudToGlobal(cloud), quantisation(cloud), { local: sourcePositions(cloud) });
    write('fullfile', c, {
      path: 'fullfile',
      workerGlobalPresent: hadWorker,
      note: 'Serial decode through loadLas; not pooled coverage.',
      declaredPointCount: cloud.declaredPointCount,
      pointCount: cloud.pointCount,
      origin: [...cloud.sourceOrigin],
      crs: cloud.metadata?.crs ?? null,
      decodePool: 'refused by ?decodePool=off (Node has no Worker)',
      recommendedColour: recommendColorMode(cloud),
      rgbReadability: readRgbReadability(cloud.colors),
    });
  });

  it('export: LAS 1.4 through convertCloud, and CRS provenance', async () => {
    const cloud = serialCloud;
    expect(cloud).toBeDefined();
    if (!cloud) return;
    const posBefore = digest(sourcePositions(cloud));
    const originBefore = [...cloud.sourceOrigin];

    // 1. The file as declared: no CRS anywhere.
    const svc = new CrsService(memoryPort());
    const fromFile = svc.resolveForScan({ name: NAME, detected: cloud.metadata?.crs, source: 'las-vlr' });

    // 2. The publisher's statement. OLV has no catalogue entry for this record,
    // so the study supplies it the way a catalogue assertion reaches the
    // resolver for a streamed tile: a CrsInfo labelled with who asserted it.
    const asserted = { ...crsFromEpsg(5514), catalogue: PUBLISHER_ASSERTION };
    const catSvc = new CrsService(memoryPort());
    const fromCatalogue = catSvc.resolveForScan({ name: NAME, detected: asserted, source: 'las-vlr' });
    // A stored catalogue record is bound to a catalogue pick; on a file opened
    // from disk it must not apply.
    const recordSvc = new CrsService(memoryPort({
      [NAME.toLowerCase()]: { epsg: 5514, kind: 'projected', catalogue: PUBLISHER_ASSERTION, updatedAt: 0 },
    }));
    const catalogueRecordOnLocalFile = recordSvc.resolveForScan({ name: NAME, detected: cloud.metadata?.crs, source: 'las-vlr' });

    // 3. The user's explicit choice.
    const userSvc = new CrsService(memoryPort());
    userSvc.resolveForScan({ name: NAME, detected: cloud.metadata?.crs, source: 'las-vlr' });
    const fromUser = userSvc.setOverride({ override: { epsg: 5514, kind: 'projected' }, detected: cloud.metadata?.crs, source: 'las-vlr' });

    const session = {
      catalogue: parseResolvedCrs(JSON.parse(JSON.stringify(fromCatalogue))),
      user: parseResolvedCrs(JSON.parse(JSON.stringify(fromUser))),
      unresolved: parseResolvedCrs(JSON.parse(JSON.stringify(fromFile))),
    };

    const exports: Record<string, unknown> = {};
    const run = (name: string, opts: Parameters<typeof convertCloud>[1]) => {
      const { file, report } = convertCloud(cloud, opts);
      exports[name] = { ok: report.ok, crsNote: report.crsNote, log: report.log.map((l) => `${l.level}: ${l.message}`) };
      if (file) writeFileSync(join(OUT, `export-${name}.las`), file.bytes as Uint8Array);
    };
    run('keep', { format: 'las14', crsMode: 'keep', resolvedSourceCrs: fromFile, digests: exportDigests(null, fromFile) });
    run('catalogue', { format: 'las14', crsMode: 'keep', resolvedSourceCrs: fromCatalogue, digests: exportDigests(null, fromCatalogue) });
    run('user', { format: 'las14', crsMode: 'keep', resolvedSourceCrs: fromUser, digests: exportDigests(null, fromUser) });
    run('assign', { format: 'las14', crsMode: 'assign', targetEpsg: 5514, resolvedSourceCrs: fromFile, digests: exportDigests(null, fromFile) });

    // What measurement and ground-metre claims are allowed under each frame.
    const ground = (svcX: CrsService) => ({ groundMetresPermitted: groundMetresPermitted(svcX.context()), refusal: horizontalGroundRefusal(svcX.context()) });
    const measurement = { fromFile: ground(svc), fromCatalogue: ground(catSvc), fromUser: ground(userSvc) };
    const posAfter = digest(sourcePositions(cloud));
    writeFileSync(join(OUT, 'crs.json'), JSON.stringify({
      declaredInFile: cloud.metadata?.crs ?? null,
      resolved: { fromFile, fromCatalogue, fromUser, catalogueRecordOnLocalFile },
      publisherAssertion: PUBLISHER_ASSERTION,
      measurement,
      session,
      positionsSha256Before: posBefore,
      positionsSha256After: posAfter,
      originBefore,
      originAfter: [...cloud.sourceOrigin],
      exports,
    }, null, 2));
    expect(posAfter).toBe(posBefore);
  });
});
