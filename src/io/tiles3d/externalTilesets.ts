/**
 * externalTilesets.ts — follow a tile whose content is another `tileset.json`.
 *
 * 3D Tiles lets a tile point its content at an external tileset rather than a
 * geometry file: the referenced document's root tile stands in for the tile's
 * content, in that tile's coordinate frame. The explicit reader classifies a
 * `.json` content as `tileset` and, on its own, refuses to follow it — so a set
 * split across several `tileset.json` files opens as "a tile this reader cannot
 * serve" even though every leaf is a point tile it could stream.
 *
 * This expander rewrites those references away before the tree is parsed, the
 * same shape the implicit expander uses: it fetches each external document,
 * expands ITS implicit and external references in turn, and splices the fetched
 * root in as a child of the referencing tile with the `.json` content removed.
 * A child inherits the referencing tile's transform, so the external root lands
 * in the referencing tile's frame exactly as the specification requires, and
 * every existing refusal (a mesh content, a bad URL, a point budget) then
 * applies to the spliced-in result unchanged.
 *
 * The three things a small document can make unbounded are all capped and none
 * is truncated, for the reason the implicit ceilings give: a hierarchy pruned
 * mid-expansion renders as a plausible scene with geometry quietly missing. The
 * fetch fan-out (how many external documents), the nesting depth (how deep the
 * references chain), and the bytes of one document (the transport's own
 * `MAX_TILESET_JSON_BYTES`) each refuse. A document that references itself,
 * directly or around a cycle, is refused rather than followed forever.
 */

import { expandImplicitTileset } from './implicitExpand';
import { contentKind } from './tilesetNodes';
import { resolveTilesetContentUrl, tilesetBaseUrl, tilesetUrlSearch } from './tilesetUrl';
import { DEFAULT_TILESET_MAX_DEPTH } from './tileset';

/** How many external `tileset.json` documents one open may fetch in total. */
export const MAX_EXTERNAL_TILESETS = 256;

/** How deeply external references may nest before the open is refused. */
export const MAX_EXTERNAL_DEPTH = 16;

interface RawContent {
  uri?: string;
  url?: string;
}

interface RawTile {
  boundingVolume?: unknown;
  geometricError?: number;
  refine?: string;
  transform?: number[];
  content?: RawContent;
  contents?: unknown;
  children?: RawTile[];
  implicitTiling?: unknown;
}

export interface ExpandExternalOptions {
  /** The tileset entry URL. External URIs resolve against its directory. */
  readonly entryUrl: string;
  /** Fetch an external `tileset.json` body as text. */
  readonly fetchTilesetJson: (url: string, signal?: AbortSignal) => Promise<string>;
  /** Fetch a subtree body, forwarded to the implicit expander per document. */
  readonly fetchSubtreeBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  readonly signal?: AbortSignal;
  /** Override {@link MAX_EXTERNAL_TILESETS}. */
  readonly maxExternalTilesets?: number;
  /** Override {@link MAX_EXTERNAL_DEPTH}. */
  readonly maxExternalDepth?: number;
}

interface Budget {
  readonly maxExternal: number;
  readonly maxDepth: number;
  fetched: number;
}

/** The content URI a content entry names, or null when it names none. */
function contentUri(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const c = entry as RawContent;
  const uri = typeof c.uri === 'string' ? c.uri : typeof c.url === 'string' ? c.url : null;
  return uri !== null && uri.length > 0 ? uri : null;
}

/** True when a content URI points at an external tileset rather than geometry. */
function isExternalTileset(uri: string): boolean {
  return contentKind(uri) === 'tileset';
}

/**
 * Split a tile's contents into the external-tileset URIs to follow and the
 * content entries to keep (geometry, or anything not a `.json`). Reads the 1.0
 * single `content` and the 1.1 `contents` array uniformly.
 */
function partitionContents(tile: RawTile): { external: string[]; keep: unknown[] } {
  const external: string[] = [];
  const keep: unknown[] = [];
  const classify = (entry: unknown): void => {
    const uri = contentUri(entry);
    if (uri !== null && isExternalTileset(uri)) external.push(uri);
    else keep.push(entry);
  };
  if (tile.content !== undefined) classify(tile.content);
  if (Array.isArray(tile.contents)) for (const entry of tile.contents) classify(entry);
  return { external, keep };
}

/** Rebuild a tile's content fields from the entries that survive following. */
function withKeptContents(tile: RawTile, keep: unknown[]): RawTile {
  const next: RawTile = { ...tile };
  delete next.content;
  delete next.contents;
  if (keep.length === 1) next.content = keep[0] as RawContent;
  else if (keep.length > 1) next.contents = keep;
  return next;
}

export async function expandExternalTilesets(
  doc: object,
  options: ExpandExternalOptions,
): Promise<object> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('3D Tiles: tileset.json is not an object.');
  }
  const budget: Budget = {
    maxExternal: options.maxExternalTilesets ?? MAX_EXTERNAL_TILESETS,
    maxDepth: options.maxExternalDepth ?? MAX_EXTERNAL_DEPTH,
    fetched: 0,
  };

  function abortIfCancelled(): void {
    const signal = options.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('3D Tiles external expansion aborted', 'AbortError');
    }
  }

  /**
   * Fetch one external document, resolved against `base`, and expand its own
   * implicit and external references. `chain` is the set of URLs already open
   * above this one, so a reference back into the chain is refused as a cycle.
   */
  async function follow(
    resolvedUrl: string,
    depth: number,
    chain: ReadonlySet<string>,
  ): Promise<RawTile> {
    if (depth > budget.maxDepth) {
      throw new Error(
        `3D Tiles: external tilesets nest deeper than ${budget.maxDepth} levels; ` +
          'refusing to follow them.',
      );
    }
    if (chain.has(resolvedUrl)) {
      throw new Error(`3D Tiles: external tileset "${resolvedUrl}" references itself in a cycle.`);
    }
    if (budget.fetched >= budget.maxExternal) {
      throw new Error(
        `3D Tiles: a set of tilesets references more than ${budget.maxExternal} external ` +
          'documents; refusing to fetch further.',
      );
    }
    budget.fetched += 1;
    abortIfCancelled();
    const json = await options.fetchTilesetJson(resolvedUrl, options.signal);
    abortIfCancelled();
    const expandedImplicit = await expandImplicitTileset(JSON.parse(json) as object, {
      entryUrl: resolvedUrl,
      fetchSubtreeBytes: options.fetchSubtreeBytes,
      signal: options.signal,
    });
    const source = expandedImplicit as { root?: RawTile };
    if (source.root === undefined || source.root === null || typeof source.root !== 'object') {
      throw new Error(`3D Tiles: external tileset "${resolvedUrl}" declares no root tile.`);
    }
    const nextChain = new Set(chain).add(resolvedUrl);
    return walk(source.root, resolvedUrl, depth, nextChain);
  }

  /**
   * Walk a tile, following each external-tileset content it names and recursing
   * into its children. `docUrl` is the URL of the document this tile came from;
   * external URIs on it resolve against that document's directory, not the entry.
   */
  async function walk(
    tile: RawTile,
    docUrl: string,
    depth: number,
    chain: ReadonlySet<string>,
  ): Promise<RawTile> {
    if (depth > DEFAULT_TILESET_MAX_DEPTH) {
      throw new Error(
        `3D Tiles: tile hierarchy is deeper than ${DEFAULT_TILESET_MAX_DEPTH} levels; ` +
          'refusing to expand it.',
      );
    }
    if (tile === null || typeof tile !== 'object' || Array.isArray(tile)) {
      throw new Error('3D Tiles: a tile is not an object.');
    }
    if (tile.children !== undefined && !Array.isArray(tile.children)) {
      throw new Error('3D Tiles: a tile children field is not an array.');
    }

    const base = tilesetBaseUrl(docUrl);
    const search = tilesetUrlSearch(docUrl);
    const { external, keep } = partitionContents(tile);

    const spliced: RawTile[] = [];
    for (const uri of external) {
      const resolved = resolveTilesetContentUrl(base, uri, search);
      if (!resolved.ok) {
        throw new Error(`3D Tiles: external tileset "${uri}": ${resolved.reason}`);
      }
      spliced.push(await follow(resolved.url, depth + 1, chain));
    }

    const walkedChildren: RawTile[] = [];
    for (const child of (tile.children ?? []) as RawTile[]) {
      walkedChildren.push(await walk(child, docUrl, depth + 1, chain));
    }

    if (external.length === 0) {
      // No external content here: return the tile with its children walked, and
      // only rebuild the children field when there were any to walk.
      return tile.children === undefined ? tile : { ...tile, children: walkedChildren };
    }
    const children = [...walkedChildren, ...spliced];
    return withKeptContents({ ...tile, children }, keep);
  }

  const source = doc as { root?: RawTile };
  if (source.root === undefined) return doc;
  const root = await walk(source.root, options.entryUrl, 0, new Set<string>());
  return { ...doc, root };
}
