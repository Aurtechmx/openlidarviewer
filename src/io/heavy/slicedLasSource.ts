/**
 * slicedLasSource.ts — feed an uncompressed LAS file to the out-of-core indexer.
 *
 * The indexer wants a re-iterable {@link PointSource} of position-keyed batches
 * carrying the record bytes to spill. `openSlicedLas` already reads a LAS of any
 * size as bounded batches (one {@link RangeSource} range each, never the whole
 * file); this adapter packs every decoded batch into fixed-length tile records
 * and hands the batch's positions over for keying. The schema (whether records
 * carry GPS time and RGB) is fixed once from the header, so every record in the
 * store has the same length.
 *
 * Re-iterable because `openSlicedLas().batches()` re-reads from the range on
 * each call: the indexer's bounds pass and bucketing pass both consume it and
 * see identical points. Pure and RangeSource-only, so the whole build is Node-
 * testable; the browser passes an OPFS-file RangeSource and an OPFS spill store.
 */
import type { RangeSource } from '../range/RangeSource';
import { decodeContext } from '../lasDecodeShared';
import { openSlicedLas, type SlicedLasOptions } from './slicedLasReader';
import type { PointSource, SourceHeader } from './oocIndexer';
import {
  packTileRecord,
  tileRecordBytes,
  tileSchemaForHeader,
  type TileSchema,
} from './tileRecord';

export interface SlicedLasSource {
  readonly source: PointSource;
  readonly schema: TileSchema;
  readonly recordBytes: number;
  readonly readablePointCount: number;
  readonly origin: [number, number, number];
}

/**
 * Open an uncompressed LAS as a {@link PointSource} of packed tile records.
 * Throws whatever `openSlicedLas` throws on a non-LAS or compressed input.
 */
export async function openSlicedLasSource(
  range: RangeSource,
  options: SlicedLasOptions = {},
): Promise<SlicedLasSource> {
  const opened = await openSlicedLas(range, options);
  const ctx = decodeContext(opened.header, opened.origin);
  const schema = tileSchemaForHeader(opened.header.pointFormat, ctx);
  const recordBytes = tileRecordBytes(schema);

  const header = sliceSourceHeader(
    opened.header.min,
    opened.header.max,
    opened.origin,
    opened.readablePointCount,
  );

  const source: PointSource = {
    header,
    async *batches(signal) {
      for await (const batch of opened.batches()) {
        signal?.throwIfAborted();
        const records = new Uint8Array(batch.count * recordBytes);
        const view = new DataView(records.buffer);
        for (let i = 0; i < batch.count; i++) {
          packTileRecord(batch.raw, i, schema, view, i * recordBytes);
        }
        yield { positions: batch.raw.positions, count: batch.count, records, recordBytes };
      }
    },
  };

  return {
    source,
    schema,
    recordBytes,
    readablePointCount: opened.readablePointCount,
    origin: opened.origin,
  };
}

/**
 * The trusted {@link SourceHeader} that lets the indexer skip its bounds pass.
 *
 * The LAS header carries the point count and the axis-aligned bounds in WORLD
 * coordinates; the batches yield positions in the origin-relative, Float32 frame
 * `decodeRecord` produces, `local = (int * scale + offset) - origin` narrowed to
 * Float32 on store. So the header bounds are moved into that same frame here:
 * `Math.fround(worldBound[a] - origin[a])`, one subtraction then a Float32
 * narrowing, mirroring the decode exactly. The writer snaps the header bounds
 * through the same quantisation the point records take, so the world bound of an
 * extreme axis equals that point's `int * scale + offset`; the transform above
 * therefore reproduces the stored Float32 extremum bit-for-bit, and the grid the
 * header builds is the grid the bounds pass would build. `pointCount` is the
 * READABLE count, so it equals what a measuring pass would tally on a truncated
 * file rather than the declared count.
 *
 * When the count is not a finite point or the box is degenerate the header is
 * dropped, so the build keeps its two-pass path. The indexer re-checks both, but
 * declining here keeps a useless header off the source in the first place.
 */
function sliceSourceHeader(
  worldMin: readonly [number, number, number],
  worldMax: readonly [number, number, number],
  origin: readonly [number, number, number],
  pointCount: number,
): SourceHeader | undefined {
  if (!Number.isFinite(pointCount) || pointCount < 1) return undefined;
  const min: [number, number, number] = [
    Math.fround(worldMin[0] - origin[0]),
    Math.fround(worldMin[1] - origin[1]),
    Math.fround(worldMin[2] - origin[2]),
  ];
  const max: [number, number, number] = [
    Math.fround(worldMax[0] - origin[0]),
    Math.fround(worldMax[1] - origin[1]),
    Math.fround(worldMax[2] - origin[2]),
  ];
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a])) return undefined;
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(extent > 0)) return undefined;
  return { pointCount, min, max };
}
