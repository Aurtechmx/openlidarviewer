/**
 * implicitExpand.ts — turn an implicitly tiled `tileset.json` into the explicit
 * document the rest of this reader already understands.
 *
 * WHY REWRITE THE DOCUMENT RATHER THAN TEACH THE PARSER. `parseTileset` is
 * synchronous and pure, and it is where every structural refusal in this format
 * lives: the bounding-volume forms, the finite geometric error, the refine
 * vocabulary, the depth and tile-count ceilings, the multi-content refusal. An
 * implicit tree needs the network to know which of its tiles exist, so it
 * cannot be resolved inside that function. Expanding to an equivalent explicit
 * document instead means every tile this module invents is then checked by the
 * same parser that checks an authored one, and `tilesetNodes` and the scheduler
 * downstream cannot tell the two apart. Nothing here relaxes a refusal; the
 * output goes through all of them.
 *
 * WHAT IS FETCHED, AND THROUGH WHAT. Subtree files and the external
 * availability buffers they name. Both go through `resolveTilesetContentUrl`,
 * the same gate a tile's `content.uri` passes: http/https only, no embedded
 * credentials, the tileset's own origin, no path escaping the tileset's own
 * directory, and a length cap. A subtree URI is authored by the same untrusted
 * document a content URI is, and it is fetched EARLIER, so a separate fetch
 * path here would be a hole in front of the one guard the format has. The bytes
 * come back through the caller's `fetchSubtreeBytes`, which is the transport's
 * bounded read with its per-attempt deadline and refused redirects.
 *
 * WHAT IS REFUSED BY NAME, rather than half-served:
 *
 *   a sphere bounding volume        no exact implicit subdivision exists
 *   an implicit tile with children  the rule and the list state two hierarchies
 *   an implicit tile with no content template   the tree would name no data
 *   a child subtree whose root tile is unavailable   the two disagree
 *   every ceiling below
 *
 * WHAT IS IGNORED, stated because silence is the failure mode this file is
 * written against: `tileMetadata`, `contentMetadata`, `subtreeMetadata` and
 * `propertyTables` in a subtree carry semantics about tiles, not tiles, so
 * dropping them changes what a reader could say about the scene and not which
 * tiles are in it. Nothing else in a subtree document is skipped.
 */

import {
  childCoordinates,
  geometricErrorForLevel,
  isAvailable,
  subdivideBoundingVolume,
  tileIdFor,
  tileIndexWithinSubtree,
  type SubdivisionScheme,
  type TileCoordinate,
} from './implicitCoordinates';
import { parseImplicitTiling, substituteTemplateUri, type ImplicitTiling } from './implicitTiling';
import {
  readSubtreeDocument,
  resolveSubtreeAvailability,
  subtreeExternalBuffers,
  subtreeTileCount,
  type SubtreeAvailability,
} from './subtree';
import { MAX_SUBTREE_BYTES } from './tilesetTransport';
import { resolveTilesetContentUrl, tilesetBaseUrl, tilesetUrlSearch } from './tilesetUrl';
import { DEFAULT_TILESET_MAX_DEPTH, type BoundingVolume } from './tileset';

/**
 * Ceilings, and the shape of document each one is here for.
 *
 * An implicit tileset is the one place in this format where a very small
 * document describes an unbounded amount of work. Three hundred bytes of JSON
 * plus one subtree file can name an eight-level octree, and each subtree it
 * names can name more. So the count of subtree DOCUMENTS is bounded (that is
 * the fetch fan-out), the count of expanded TILES is bounded (that is the
 * allocation), and the bytes of one subtree BODY are bounded (that is the
 * single read). All three refuse. None truncates, for the reason the explicit
 * ceilings give: a hierarchy silently pruned mid-expansion renders as a
 * plausible scene with geometry quietly missing.
 */
export const MAX_IMPLICIT_SUBTREES = 512;
export const MAX_IMPLICIT_TILES = 100_000;

/** What {@link expandImplicitTileset} needs to resolve an implicit document. */
export interface ExpandImplicitOptions {
  /** The entry `tileset.json` URL, which every derived URL is resolved against. */
  readonly entryUrl: string;
  /**
   * Read one `.subtree` body or one external availability buffer.
   *
   * This is `TilesetTransport.fetchSubtreeBytes`. It is injected rather than
   * constructed so this module fetches nothing on its own and a test can drive
   * every path with no network.
   */
  readonly fetchSubtreeBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  readonly signal?: AbortSignal;
  /** Override {@link MAX_IMPLICIT_SUBTREES}. */
  readonly maxSubtrees?: number;
  /** Override {@link MAX_IMPLICIT_TILES}. */
  readonly maxTiles?: number;
  /** Override the per-body byte ceiling. Defaults to the transport's. */
  readonly maxSubtreeBytes?: number;
}

/** The raw tile shape this module reads and writes. Deliberately loose. */
interface RawTile {
  boundingVolume?: Record<string, unknown>;
  geometricError?: number;
  refine?: unknown;
  transform?: unknown;
  content?: { uri?: unknown; url?: unknown };
  contents?: unknown;
  children?: unknown;
  implicitTiling?: unknown;
  [key: string]: unknown;
}

/** The subtree covering a tile, and the coordinate of that subtree's own root. */
interface SubtreeContext {
  readonly root: TileCoordinate;
  readonly availability: SubtreeAvailability;
}

/** The mutable budget threaded through one expansion. */
interface ExpandBudget {
  readonly maxSubtrees: number;
  readonly maxTiles: number;
  subtrees: number;
  tiles: number;
}

/** The level-0 coordinate of an implicit tree, per scheme. */
function rootCoordinate(scheme: SubdivisionScheme): TileCoordinate {
  return scheme === 'QUADTREE' ? { level: 0, x: 0, y: 0 } : { level: 0, x: 0, y: 0, z: 0 };
}

/**
 * The bounding volume an implicit tile may be subdivided from.
 *
 * `subdivideBoundingVolume` returns null for a sphere because an eighth of a
 * sphere is not a sphere, and a bounding volume that is merely close is no
 * longer a bound. Refusing here names the reason once, rather than producing a
 * null volume per tile that the parser would then report as a missing
 * boundingVolume.
 */
function implicitRootVolume(raw: Record<string, unknown> | undefined): BoundingVolume {
  if (!raw) throw new Error('3D Tiles: an implicitly tiled tile has no boundingVolume.');
  if (raw.sphere !== undefined) {
    throw new Error(
      '3D Tiles: an implicitly tiled tile declares a sphere bounding volume, which has no ' +
        'exact subdivision; this reader expands box and region volumes only.',
    );
  }
  const finite = (v: unknown, want: number): boolean =>
    Array.isArray(v) && v.length === want && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (finite(raw.box, 12)) return { box: raw.box as number[] };
  if (finite(raw.region, 6)) return { region: raw.region as number[] };
  throw new Error(
    '3D Tiles: an implicitly tiled tile has no box of 12 finite components or region of 6.',
  );
}

/** The authored `content.uri`, which on an implicit tile is a template. */
function contentTemplate(tile: RawTile): string {
  const raw = tile.content?.uri ?? tile.content?.url;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      '3D Tiles: an implicitly tiled tile names no content template, so its rule describes a ' +
        'hierarchy with no data in it.',
    );
  }
  return raw;
}

/** One expansion, holding the URLs and the budget every subtree fetch shares. */
class ImplicitExpansion {
  private readonly base: string;
  private readonly search: string;
  private readonly maxSubtreeBytes: number;
  private readonly loaded = new Map<string, SubtreeAvailability>();
  private readonly options: ExpandImplicitOptions;
  private readonly budget: ExpandBudget;

  constructor(options: ExpandImplicitOptions, budget: ExpandBudget) {
    this.options = options;
    this.budget = budget;
    this.base = tilesetBaseUrl(options.entryUrl);
    this.search = tilesetUrlSearch(options.entryUrl);
    this.maxSubtreeBytes = options.maxSubtreeBytes ?? MAX_SUBTREE_BYTES;
  }

  /** Resolve one authored URI through the gate every content URI passes. */
  private resolve(uri: string, what: string): string {
    const check = resolveTilesetContentUrl(this.base, uri, this.search);
    if (!check.ok) throw new Error(`3D Tiles: ${what} refused: ${check.reason}`);
    return check.url;
  }

  private throwIfAborted(): void {
    const signal = this.options.signal;
    if (signal?.aborted) {
      throw (signal.reason ?? new DOMException('3D Tiles implicit expansion aborted', 'AbortError'));
    }
  }

  private async read(url: string, what: string): Promise<Uint8Array> {
    this.throwIfAborted();
    const bytes = await this.options.fetchSubtreeBytes(url, this.options.signal);
    if (bytes.byteLength > this.maxSubtreeBytes) {
      throw new Error(
        `3D Tiles: ${what} is ${bytes.byteLength} bytes, above the ceiling of ` +
          `${this.maxSubtreeBytes}; refusing to read it.`,
      );
    }
    return new Uint8Array(bytes);
  }

  /**
   * Fetch and resolve the subtree rooted at `coord`, once per coordinate.
   *
   * External availability buffers are resolved against the SUBTREE's own URL,
   * because that is what the buffer `uri` is relative to, and the absolute
   * result is then put through the tileset-directory gate. Resolving straight
   * against the tileset root would misplace a buffer beside a nested subtree;
   * skipping the second check would let a `../` in a buffer uri leave the
   * tileset's own directory.
   */
  private async subtreeAt(tiling: ImplicitTiling, coord: TileCoordinate): Promise<SubtreeAvailability> {
    const key = tileIdFor(tiling.scheme, coord);
    const already = this.loaded.get(key);
    if (already) return already;
    if (++this.budget.subtrees > this.budget.maxSubtrees) {
      throw new Error(
        `3D Tiles: this tileset needs more than ${this.budget.maxSubtrees} subtree files; ` +
          'refusing to expand it.',
      );
    }
    const uri = substituteTemplateUri(tiling.subtreeUriTemplate, tiling.scheme, coord);
    const url = this.resolve(uri, `the subtree URI "${uri}"`);
    const doc = readSubtreeDocument(await this.read(url, `the subtree at ${uri}`));
    const external = new Map<number, Uint8Array>();
    for (const request of subtreeExternalBuffers(doc)) {
      let absolute: string;
      try {
        absolute = new URL(request.uri, url).toString();
      } catch {
        throw new Error(
          `3D Tiles: a subtree availability buffer URI is not resolvable: ${request.uri}`,
        );
      }
      const bufferUrl = this.resolve(
        absolute,
        `the subtree availability buffer "${request.uri}"`,
      );
      external.set(
        request.index,
        await this.read(bufferUrl, `the availability buffer at ${request.uri}`),
      );
    }
    const availability = resolveSubtreeAvailability(doc, {
      scheme: tiling.scheme,
      subtreeLevels: tiling.subtreeLevels,
    }, external);
    this.loaded.set(key, availability);
    return availability;
  }

  /** Whether the tile at `coord` carries content, per its subtree. */
  private hasContent(tiling: ImplicitTiling, context: SubtreeContext, coord: TileCoordinate): boolean {
    const content = context.availability.content;
    if (content === null) return false;
    return isAvailable(content, tileIndexWithinSubtree(tiling.scheme, coord, context.root.level));
  }

  /**
   * Build the explicit tile at `coord`, and everything available below it.
   *
   * The volume is subdivided from the parent's rather than recomputed from the
   * root, which is what makes a child's bound exactly the parent's half rather
   * than an independently rounded approximation of it.
   */
  private async buildTile(
    tiling: ImplicitTiling,
    context: SubtreeContext,
    coord: TileCoordinate,
    volume: BoundingVolume,
    rootGeometricError: number,
    contentUriTemplate: string,
  ): Promise<RawTile> {
    if (++this.budget.tiles > this.budget.maxTiles) {
      throw new Error(
        `3D Tiles: this implicit tileset expands to more than ${this.budget.maxTiles} tiles; ` +
          'refusing to expand it.',
      );
    }
    const tile: RawTile = {
      boundingVolume: volume as unknown as Record<string, unknown>,
      geometricError: geometricErrorForLevel(rootGeometricError, coord.level),
    };
    if (this.hasContent(tiling, context, coord)) {
      tile.content = { uri: substituteTemplateUri(contentUriTemplate, tiling.scheme, coord) };
    }
    const children = await this.buildChildren(
      tiling,
      context,
      coord,
      volume,
      rootGeometricError,
      contentUriTemplate,
    );
    if (children.length > 0) tile.children = children;
    return tile;
  }

  /**
   * The available children of one tile.
   *
   * Two cases meet here. While the child stays inside the current subtree its
   * presence is a bit of that subtree's `tileAvailability`. At the subtree's
   * deepest level the child is instead the ROOT of another subtree, and its
   * presence is a bit of `childSubtreeAvailability` addressing the level below
   * the deepest, which is a different bitstream of a different length. Reading
   * one where the other belongs is how a reader loses or invents a whole level.
   */
  private async buildChildren(
    tiling: ImplicitTiling,
    context: SubtreeContext,
    coord: TileCoordinate,
    volume: BoundingVolume,
    rootGeometricError: number,
    contentUriTemplate: string,
  ): Promise<RawTile[]> {
    if (coord.level + 1 > tiling.availableLevels - 1) return [];
    const depthInSubtree = coord.level + 1 - context.root.level;
    const crossesSubtree = depthInSubtree === tiling.subtreeLevels;
    const perSubtree = subtreeTileCount({
      scheme: tiling.scheme,
      subtreeLevels: tiling.subtreeLevels,
    });
    const out: RawTile[] = [];
    const kids = childCoordinates(tiling.scheme, coord);
    for (let index = 0; index < kids.length; index++) {
      const child = kids[index] as TileCoordinate;
      const childVolume = subdivideBoundingVolume(tiling.scheme, volume, index);
      if (childVolume === null) {
        throw new Error(
          '3D Tiles: an implicitly tiled bounding volume has no exact subdivision.',
        );
      }
      // Both indices come from the same function; only the frame differs. Inside
      // the subtree it addresses `tileAvailability`; at the boundary the count
      // of every tile in the subtree is subtracted, which turns it into the
      // Morton index of the child-subtree root within `childSubtreeAvailability`.
      const withinSubtree = tileIndexWithinSubtree(tiling.scheme, child, context.root.level);
      if (!crossesSubtree) {
        if (!isAvailable(context.availability.tile, withinSubtree)) continue;
        out.push(
          await this.buildTile(
            tiling,
            context,
            child,
            childVolume,
            rootGeometricError,
            contentUriTemplate,
          ),
        );
        continue;
      }
      if (!isAvailable(context.availability.childSubtree, withinSubtree - perSubtree)) continue;
      const availability = await this.subtreeAt(tiling, child);
      // The two documents state the same fact from opposite sides. A parent
      // that promises a child subtree whose own root tile is absent is not a
      // tileset with a hole in it; it is two documents that disagree, and
      // picking either answer would be a guess.
      if (!isAvailable(availability.tile, 0)) {
        throw new Error(
          `3D Tiles: the subtree at ${tileIdFor(tiling.scheme, child)} is declared available by ` +
            'its parent but states its own root tile is not.',
        );
      }
      out.push(
        await this.buildTile(
          tiling,
          { root: child, availability },
          child,
          childVolume,
          rootGeometricError,
          contentUriTemplate,
        ),
      );
    }
    return out;
  }

  /** Expand one implicitly tiled tile into an explicit one. */
  async expandTile(tile: RawTile): Promise<RawTile> {
    const tiling = parseImplicitTiling(tile.implicitTiling);
    if (Array.isArray(tile.children) && tile.children.length > 0) {
      throw new Error(
        '3D Tiles: a tile declares both implicitTiling and children, which state two different ' +
          'hierarchies for the same tile.',
      );
    }
    const template = contentTemplate(tile);
    const volume = implicitRootVolume(tile.boundingVolume);
    if (typeof tile.geometricError !== 'number' || !Number.isFinite(tile.geometricError)) {
      throw new Error('3D Tiles: an implicitly tiled tile has no finite geometricError.');
    }
    const root = rootCoordinate(tiling.scheme);
    const availability = await this.subtreeAt(tiling, root);
    const context: SubtreeContext = { root, availability };
    const expanded = await this.buildTile(
      tiling,
      context,
      root,
      volume,
      tile.geometricError,
      template,
    );
    // Everything the authored tile stated for itself is kept: its transform, its
    // refine, its own bounding volume and geometric error. Only the rule and the
    // content TEMPLATE are replaced, by the tree and the content the rule named.
    const out: RawTile = { ...tile };
    delete out.implicitTiling;
    delete out.content;
    delete out.children;
    if (expanded.content !== undefined) out.content = expanded.content;
    if (expanded.children !== undefined) out.children = expanded.children;
    // An implicit root whose own tileAvailability bit is 0 exists in the
    // document but not in the tree. It keeps its bounds so the hierarchy above
    // it still places it, and carries neither content nor children.
    if (!isAvailable(availability.tile, 0)) {
      delete out.content;
      delete out.children;
    }
    return out;
  }
}

/**
 * Rewrite a `tileset.json` document so no tile declares `implicitTiling`.
 *
 * Takes and returns the RAW document, before `parseTileset`. The result is an
 * ordinary explicit tileset: hand it to `parseTileset`, which applies every
 * structural refusal and both of its ceilings to the expansion exactly as it
 * would to an authored hierarchy.
 *
 * A document that declares no implicit tiling anywhere is returned unchanged,
 * so a caller can run this unconditionally.
 */
export async function expandImplicitTileset(
  doc: object,
  options: ExpandImplicitOptions,
): Promise<object> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('3D Tiles: tileset.json is not an object.');
  }
  const budget: ExpandBudget = {
    maxSubtrees: options.maxSubtrees ?? MAX_IMPLICIT_SUBTREES,
    maxTiles: options.maxTiles ?? MAX_IMPLICIT_TILES,
    subtrees: 0,
    tiles: 0,
  };
  const expansion = new ImplicitExpansion(options, budget);

  /** Walk the authored tree, expanding each implicit tile where it stands. */
  async function walk(tile: RawTile, depth: number): Promise<RawTile> {
    if (depth > DEFAULT_TILESET_MAX_DEPTH) {
      throw new Error(
        `3D Tiles: tile hierarchy is deeper than ${DEFAULT_TILESET_MAX_DEPTH} levels; ` +
          'refusing to expand it.',
      );
    }
    if (tile === null || typeof tile !== 'object' || Array.isArray(tile)) {
      throw new Error('3D Tiles: a tile is not an object.');
    }
    // An expanded tile holds no implicitTiling below it, so it is not re-walked.
    if (tile.implicitTiling !== undefined) return expansion.expandTile(tile);
    if (tile.children === undefined) return tile;
    if (!Array.isArray(tile.children)) {
      throw new Error('3D Tiles: a tile children field is not an array.');
    }
    const children: RawTile[] = [];
    for (const child of tile.children as RawTile[]) {
      children.push(await walk(child, depth + 1));
    }
    return { ...tile, children };
  }

  const source = doc as { root?: RawTile };
  if (source.root === undefined) return doc;
  return { ...doc, root: await walk(source.root, 0) };
}
