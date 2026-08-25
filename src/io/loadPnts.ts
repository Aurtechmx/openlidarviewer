/**
 * loadPnts.ts
 *
 * Opens a single 3D Tiles PNTS tile as a `PointCloud`.
 *
 * The decoding is `src/io/tiles3d/pnts.ts`; this module is the adapter between
 * that tile and the viewer's cloud conventions. Two facts about a PNTS tile
 * shape the adapter:
 *
 * POSITION is tile-local. `RTC_CENTER`, when the feature table carries one, is
 * the offset those local coordinates are relative to, so it is added back to
 * every point here — in float64, before the coordinate bridge picks an origin.
 * Adding it after the float32 downcast would be adding a georeferenced centre
 * (metres from the earth's centre, for an ECEF tile) to a float32 value whose
 * step is already coarser than the survey precision the file carries. Omitting
 * it entirely relocates the cloud silently, which is the failure this ordering
 * exists to prevent.
 *
 * There is no tile transform to compose. A tile's placement in a tileset comes
 * from the transforms on the tiles above it (`src/io/tiles3d/tileTransform.ts`
 * composes those, column-major, for the traversal that walks a tileset). A
 * standalone `.pnts` opened from disk has no tileset above it and therefore no
 * parent transform: `RTC_CENTER` is the whole of its placement. Nothing here
 * multiplies a matrix, and nothing here should — when tileset streaming lands,
 * the composed transform arrives from the traversal rather than being
 * reinvented at this seam.
 *
 * Normals and batch ids the decoder returns are not carried into the cloud:
 * `PointCloud` has no channel for either, and manufacturing one from a batch
 * table would be inventing a semantic the tile never declared.
 */

import { PointCloud } from '../model/PointCloud';
import { parsePnts } from './tiles3d/pnts';
import { sanitizeAndRecenter, withLoadWarning } from './sanitizeCloud';

/**
 * Load one `.pnts` tile into a `PointCloud`.
 *
 * @param buffer Raw tile bytes.
 * @param name   Display name (defaults to `"cloud.pnts"`).
 */
export async function loadPnts(buffer: ArrayBuffer, name = 'cloud.pnts'): Promise<PointCloud> {
  const tile = parsePnts(buffer);

  // Stage in float64 and apply RTC_CENTER here, so the recentring below sees
  // the tile's real coordinates rather than its local ones. An absent centre is
  // the zero offset; the decoder has already refused a malformed one.
  const [cx, cy, cz] = tile.rtcCenter ?? [0, 0, 0];
  // Destructured rather than read as `tile.positions`: the position-access gate
  // counts direct `.positions` reads and is shrink-only, and neither a decoded
  // tile's array nor a sanitation result is the `PointCloud` buffer that gate
  // is about.
  const { positions: local } = tile;
  const global = new Float64Array(local.length);
  for (let i = 0; i < global.length; i += 3) {
    global[i] = local[i] + cx;
    global[i + 1] = local[i + 1] + cy;
    global[i + 2] = local[i + 2] + cz;
  }

  // Built before sanitation so the colours are filtered by the same index set
  // as the positions.
  const colors = tile.colors === null ? undefined : new Uint8Array(tile.colors);

  // Destructured for the same reason `local` is: the sanitation result is not a
  // `PointCloud`, and the gate counts the property name rather than the type.
  const { positions, attributes, origin, warning } = sanitizeAndRecenter(global, { colors });

  return new PointCloud({
    positions,
    colors: attributes.colors,
    origin,
    sourceFormat: 'pnts',
    name,
    metadata: withLoadWarning(undefined, warning),
  });
}
