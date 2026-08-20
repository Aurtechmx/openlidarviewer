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
import type { PointSource } from './oocIndexer';
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

  const source: PointSource = {
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
