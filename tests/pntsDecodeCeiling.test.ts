import { describe, expect, it } from 'vitest';

import { MAX_PNTS_TILE_POINTS, parsePnts } from '../src/io/tiles3d/pnts';

/**
 * A PNTS tile declaring more points than the decoder is willing to allocate for.
 *
 * The transport caps a tile body at 128 MiB, which bounds the DOWNLOAD and not the
 * decode. POSITION_QUANTIZED costs six bytes a point on the wire, so that cap admits
 * about 22.4 million points, and each one is expanded into a Float32 position plus the
 * intensity, classification, return and GPS channels the generic chunk contract carries.
 * The scheduler cannot see the real figure beforehand either: every tile is admitted as
 * ASSUMED_TILE_POINTS. The refusal therefore has to happen on POINTS_LENGTH, before the
 * first array is allocated.
 */
function pntsWithDeclaredPoints(pointsLength: number): ArrayBuffer {
  const featureTable = JSON.stringify({
    POINTS_LENGTH: pointsLength,
    POSITION: { byteOffset: 0 },
  });
  // Pad the JSON to a 4-byte boundary, as the spec requires.
  const padded = featureTable.padEnd(Math.ceil(featureTable.length / 4) * 4, ' ');
  const jsonBytes = new TextEncoder().encode(padded);
  const HEADER = 28;
  // No binary section: the refusal must land before any accessor reads one.
  const buffer = new ArrayBuffer(HEADER + jsonBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x73746e70, true); // "pnts"
  view.setUint32(4, 1, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buffer, HEADER).set(jsonBytes);
  return buffer;
}

describe('PNTS decoded-point ceiling', () => {
  it('refuses a tile declaring more points than the ceiling', () => {
    const tile = pntsWithDeclaredPoints(MAX_PNTS_TILE_POINTS + 1);
    expect(() => parsePnts(tile)).toThrow(/POINTS_LENGTH/);
  });

  it('names the ceiling and the declared figure so the refusal is actionable', () => {
    const tile = pntsWithDeclaredPoints(22_369_621);
    expect(() => parsePnts(tile)).toThrow(/22369621/);
    expect(() => parsePnts(tile)).toThrow(new RegExp(String(MAX_PNTS_TILE_POINTS)));
  });

  it('refuses before allocating, so an absurd declaration costs no memory', () => {
    // UINT32_MAX points would be ~100 GiB of channels if it reached the allocator.
    const tile = pntsWithDeclaredPoints(4_294_967_295);
    expect(() => parsePnts(tile)).toThrow(/POINTS_LENGTH/);
  });

  it('lets a caller lower the ceiling for a constrained device', () => {
    const tile = pntsWithDeclaredPoints(1_000);
    expect(() => parsePnts(tile, { maxPoints: 999 })).toThrow(/POINTS_LENGTH/);
  });

  it('accepts a tile at exactly the ceiling rather than off by one', () => {
    // Reaching the position accessor proves the ceiling passed; the truncated
    // buffer then fails on the section bounds, which is a different refusal.
    const tile = pntsWithDeclaredPoints(MAX_PNTS_TILE_POINTS);
    expect(() => parsePnts(tile)).toThrow(/past the feature-table binary section/);
  });
});
