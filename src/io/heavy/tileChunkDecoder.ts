/**
 * tileChunkDecoder.ts — the seam that lets the streaming scheduler render tiles.
 *
 * The streaming scheduler drives every format through one injected
 * {@link ChunkDecoder}: it reads a node's bytes and hands them, with metadata,
 * to `decode`, which returns a {@link DecodedChunk} the renderer uploads. COPC
 * and EPT decoders decompress LAZ; this one has nothing to decompress. An
 * out-of-core tile is already the decoded, source-local record the build wrote,
 * so decoding is a straight reinterpretation of the bytes into the parallel
 * arrays the scheduler expects — positions copied as-is (no scale/offset/origin
 * transform, unlike LAZ), attributes read by the fixed record layout.
 *
 * Because the decoder is a plain injectable, a `TileStreamingSource` reuses the
 * existing scheduler — residency, eviction, scoring, backpressure, GPU commit —
 * unchanged, and this whole path is exercised against the real scheduler in Node
 * with a fake node store, the same way the COPC/EPT paths are.
 */
import type { ChunkDecodeMetadata, ChunkDecoder, DecodedChunk } from '../copc/copcChunkDecode';
import { decodeTile, type TileSchema } from './tileRecord';

/** A {@link ChunkDecoder} over out-of-core tile records. */
export class TileChunkDecoder implements ChunkDecoder {
  private readonly schema: TileSchema;
  private readonly recordBytes: number;

  constructor(schema: TileSchema, recordBytes: number) {
    this.schema = schema;
    this.recordBytes = recordBytes;
  }

  async decode(
    chunk: ArrayBuffer,
    meta: ChunkDecodeMetadata,
    signal?: AbortSignal,
  ): Promise<DecodedChunk> {
    signal?.throwIfAborted();
    const tile = decodeTile(new Uint8Array(chunk), this.schema, this.recordBytes, meta.pointCount);
    return {
      pointCount: tile.pointCount,
      positions: tile.positions,
      intensity: tile.intensity,
      classification: tile.classification,
      returnNumber: tile.returnNumber,
      returnCount: tile.returnCount,
      gpsTime: tile.gpsTime,
      pointSourceId: tile.pointSourceId,
      rgb: tile.rgb ?? undefined,
      // Tile RGB was narrowed to 8-bit by finalizeRawColors at build time, so it
      // copies verbatim; undefined when the tile carries no colour.
      rgbEightBit: this.schema.hasRgb ? true : undefined,
    };
  }
}
