/**
 * implicitTiling.ts — a tile's `implicitTiling` object, and the template URIs
 * it addresses subtrees and content with.
 *
 * An implicitly tiled tile replaces `children` with a rule: a subdivision
 * scheme, how many levels one subtree file covers, how many levels the whole
 * tree has, and a template URI that turns a coordinate into a subtree address.
 * The tile's own `content.uri` is a template too, so one string names every
 * body in the tree.
 *
 * TEMPLATES ARE SUBSTITUTED, NOT INTERPOLATED. Only `{level}`, `{x}`, `{y}` and
 * `{z}` are replaced, each by a decimal integer, and anything else left in
 * braces afterwards is refused by name. A reader that ignored an unknown
 * placeholder would assemble a URI containing a literal `{...}`, fetch it, and
 * report the 404 as a missing tile rather than as a template it did not
 * understand. `{z}` in a QUADTREE template is refused for the same reason: a
 * quadtree coordinate has no z, so any value substituted there is invented.
 *
 * WHAT IS REFUSED BY NAME. The `3DTILES_implicit_tiling` extension spells the
 * depth limit `maximumLevel` (the deepest level index) where 1.1 spells it
 * `availableLevels` (a count, one greater). Reading one as the other is an
 * off-by-one that costs or invents an entire level of tiles, so a document
 * carrying the extension spelling is named rather than guessed at.
 *
 * Pure: no fetch, no DOM.
 */

import { MAX_LEVEL, type SubdivisionScheme, type TileCoordinate } from './implicitCoordinates';

/**
 * Deepest implicit tree this reader will expand, counted in levels.
 *
 * The expansion becomes explicit tiles, and `parseTileset` refuses a hierarchy
 * deeper than DEFAULT_TILESET_MAX_DEPTH. Bounding `availableLevels` here means
 * the document is refused for the reason it is actually wrong (it asks for more
 * levels than this reader expands) rather than for the shape of the tree that
 * request happened to produce.
 */
export const MAX_IMPLICIT_LEVELS = 24;

/** A validated `implicitTiling` object. */
export interface ImplicitTiling {
  readonly scheme: SubdivisionScheme;
  /** Levels one subtree file covers, counting its own root as one. */
  readonly subtreeLevels: number;
  /** Levels the whole tree has. The deepest addressable level is one less. */
  readonly availableLevels: number;
  /** Template URI for a subtree file, in the tileset's own directory. */
  readonly subtreeUriTemplate: string;
}

const PLACEHOLDER = /\{(level|x|y|z)\}/g;
const ANY_PLACEHOLDER = /\{[^}]*\}/;

/**
 * Validate one `implicitTiling` object.
 *
 * Every field is remote input and every field sizes work: the scheme fixes the
 * branching factor, `subtreeLevels` is an exponent over it, and
 * `availableLevels` multiplies the whole tree again. None of them is defaulted.
 */
export function parseImplicitTiling(raw: unknown): ImplicitTiling {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('3D Tiles: a tile implicitTiling is not an object.');
  }
  const obj = raw as {
    subdivisionScheme?: unknown;
    subtreeLevels?: unknown;
    availableLevels?: unknown;
    maximumLevel?: unknown;
    subtrees?: { uri?: unknown };
  };
  const scheme = obj.subdivisionScheme;
  if (scheme !== 'QUADTREE' && scheme !== 'OCTREE') {
    throw new Error(
      `3D Tiles: implicitTiling declares subdivisionScheme ${JSON.stringify(scheme)}, ` +
        'which is not QUADTREE or OCTREE.',
    );
  }
  const subtreeLevels = obj.subtreeLevels;
  if (!Number.isInteger(subtreeLevels) || (subtreeLevels as number) < 1) {
    throw new Error('3D Tiles: implicitTiling.subtreeLevels is not an integer of at least 1.');
  }
  if (obj.availableLevels === undefined && obj.maximumLevel !== undefined) {
    throw new Error(
      '3D Tiles: implicitTiling declares the 3DTILES_implicit_tiling extension\'s ' +
        '`maximumLevel` rather than 1.1\'s `availableLevels`; this reader implements 1.1 only.',
    );
  }
  const availableLevels = obj.availableLevels;
  if (!Number.isInteger(availableLevels) || (availableLevels as number) < 1) {
    throw new Error('3D Tiles: implicitTiling.availableLevels is not an integer of at least 1.');
  }
  if ((availableLevels as number) > MAX_IMPLICIT_LEVELS) {
    throw new Error(
      `3D Tiles: implicitTiling declares ${availableLevels as number} availableLevels, above ` +
        `the ceiling of ${MAX_IMPLICIT_LEVELS}; refusing to expand it.`,
    );
  }
  // The deepest level the tree addresses must still have an exact Morton index,
  // which is what `implicitCoordinates` bounds per scheme.
  if ((availableLevels as number) - 1 > MAX_LEVEL[scheme]) {
    throw new Error(
      `3D Tiles: implicitTiling addresses ${scheme} level ${(availableLevels as number) - 1}, ` +
        `above the exact-integer limit of ${MAX_LEVEL[scheme]}.`,
    );
  }
  const uri = obj.subtrees?.uri;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('3D Tiles: implicitTiling.subtrees.uri is not a non-empty string.');
  }
  return {
    scheme,
    subtreeLevels: subtreeLevels as number,
    availableLevels: availableLevels as number,
    subtreeUriTemplate: uri,
  };
}

/**
 * Substitute a coordinate into a template URI.
 *
 * A template with no placeholder at all is refused: it names one file for every
 * tile in the tree, so a reader that accepted it would fetch the same body
 * under many identities and call the result a tileset.
 */
export function substituteTemplateUri(
  template: string,
  scheme: SubdivisionScheme,
  coord: TileCoordinate,
): string {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error('3D Tiles: an implicit template URI is empty.');
  }
  if (!PLACEHOLDER.test(template)) {
    // `PLACEHOLDER` is global, so its lastIndex survives a test; reset it.
    PLACEHOLDER.lastIndex = 0;
    throw new Error(
      `3D Tiles: the implicit template URI "${template}" carries no {level}, {x}, {y} or {z} ` +
        'placeholder, so it names one file for the whole tree.',
    );
  }
  PLACEHOLDER.lastIndex = 0;
  if (scheme === 'QUADTREE' && template.includes('{z}')) {
    throw new Error(
      `3D Tiles: the implicit template URI "${template}" substitutes {z}, which a QUADTREE ` +
        'coordinate does not have.',
    );
  }
  const out = template.replace(PLACEHOLDER, (_match, name: string) => {
    switch (name) {
      case 'level':
        return String(coord.level);
      case 'x':
        return String(coord.x);
      case 'y':
        return String(coord.y);
      default:
        return String(coord.z as number);
    }
  });
  const leftover = ANY_PLACEHOLDER.exec(out);
  if (leftover) {
    throw new Error(
      `3D Tiles: the implicit template URI "${template}" carries the placeholder ` +
        `"${leftover[0]}", which this reader does not substitute.`,
    );
  }
  return out;
}
