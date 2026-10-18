/**
 * glTF / GLB loader.
 *
 * Reads a (binary) glTF asset with `@loaders.gl/gltf`, walks every node in the
 * scene graph applying world transforms, and concatenates all mesh-primitive
 * `POSITION` attributes into a single point set. glTF assets carry local
 * coordinates, so the origin is the zero vector.
 */

import { parse } from '@loaders.gl/core';
import { GLTFLoader, postProcessGLTF } from '@loaders.gl/gltf';
import { LOCAL_ONLY_LOADER_OPTIONS } from './loaderConfig';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { PointCloud } from '../model/PointCloud';
import { sanitizeLocalCloud, withLoadWarning } from './sanitizeCloud';
import { authoredNormals } from './authoredNormals';
import type { SourceFormat } from './sniffFormat';
import { LoadError } from './loadErrors';

/** A postprocessed glTF node — only the fields this loader touches. */
interface GltfNode {
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  children?: GltfNode[];
  mesh?: GltfMesh;
}

/** A postprocessed glTF mesh. */
interface GltfMesh {
  primitives: GltfPrimitive[];
}

/** A postprocessed glTF mesh primitive with typed-array attribute values. */
interface GltfPrimitive {
  attributes: Record<
    string,
    { value: ArrayLike<number>; size?: number; components?: number } | undefined
  >;
}

/**
 * sRGB OETF (IEC 61966-2-1) for one linear value, clamped to [0, 1]: the
 * inverse of the EOTF `render/colorEncode.ts` applies on upload, kept here so
 * the loader does not import from the render layer.
 * `tests/loadGltfColourNormals.test.ts` checks the round trip through that EOTF.
 */
function linearToSrgb(v: number): number {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Build the local transform of a node from either `matrix` or its TRS parts. */
function localMatrix(node: GltfNode): Matrix4 {
  const m = new Matrix4();
  if (node.matrix?.length === 16) {
    // glTF matrices are column-major; three's `fromArray` reads column-major.
    m.fromArray(node.matrix);
    return m;
  }
  // Compose from translation/rotation/scale. `Matrix4.compose` reads three's
  // private fields, so real Vector3 / Quaternion instances are required —
  // plain object literals produce a NaN matrix.
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  m.compose(
    new Vector3(t[0], t[1], t[2]),
    new Quaternion(r[0], r[1], r[2], r[3]),
    new Vector3(s[0], s[1], s[2]),
  );
  return m;
}

/**
 * Depth cap for the node walk. The glTF spec requires the node hierarchy to be
 * a tree ("nodes must not form loops"), so no conforming asset comes near this
 * — a 64-deep rig is already extraordinary. The cap exists only so a malformed
 * or hostile file fails with a sentence that names the problem instead of a
 * bare `RangeError: Maximum call stack size exceeded` from a cyclic `children`
 * graph, which reads as a viewer crash rather than a bad asset. Deliberately
 * not a full graph validation: the failure mode we owe the user a name for is
 * the runaway recursion, not an inventory of which nodes formed the cycle.
 */
const MAX_NODE_DEPTH = 256;

/**
 * Most vertices one glTF open emits. Mesh reuse is legal, so a small file can
 * place one mesh under many nodes; the total is bounded here rather than by
 * the file size. It matches the per-tile PNTS ceiling (`MAX_PNTS_TILE_POINTS`):
 * twice the display point budget, and at most 216 MB across the float32
 * positions, sRGB colours and float32 normals staged for it. The total is
 * summed from the primitives' vertex counts before any of them is staged.
 */
export const MAX_GLTF_VERTICES = 8_000_000;

/** State shared across one scene walk. */
interface NodeWalk {
  /** Nodes already walked; glTF forbids a node having two parents. */
  visited: Set<GltfNode>;
  maxVertices: number;
  /** Every primitive the walk emits, in order, with its node's world matrix. */
  placed: PlacedPrimitive[];
  /** Sum of the placed primitives' vertex counts. */
  vertexCount: number;
}

/** One mesh primitive under one node, as the walk found it. */
interface PlacedPrimitive {
  primitive: GltfPrimitive;
  /** The primitive's POSITION values. */
  src: ArrayLike<number>;
  world: Matrix4;
  vertexCount: number;
}

/** Output arrays sized from the walk's vertex total, and the cursor into them. */
interface Staging {
  /** Transformed vertex positions, xyz per vertex. */
  xyz: Float32Array;
  /** sRGB colour bytes, rgb per vertex. */
  rgb: Uint8Array | null;
  /** Unit normals, xyz per vertex. */
  nrm: Float32Array | null;
  /** Vertices written so far. */
  at: number;
}

/** Refuse a node reached a second time in one walk. */
function notATree(): Error {
  return new Error(
    'glTF node hierarchy is not a tree: a node is reached more than once, so the ' +
      "asset's node graph is cyclic or malformed (the glTF spec requires each node to have at most one parent).",
  );
}

/**
 * Recursively list the mesh primitives a node and its descendants place, with
 * each node's world matrix, and refuse the walk once their summed vertex count
 * passes the cap. Nothing is staged here, so the refusal comes before any
 * output array is allocated.
 */
function collectNode(node: GltfNode, parentWorld: Matrix4, walk: NodeWalk, depth = 0): void {
  if (walk.visited.has(node)) throw notATree();
  walk.visited.add(node);
  if (depth > MAX_NODE_DEPTH) {
    throw new Error(
      `glTF node hierarchy is deeper than ${MAX_NODE_DEPTH} levels — the asset's ` +
        `node graph is cyclic or malformed (the glTF spec requires a tree).`,
    );
  }
  const world = new Matrix4().multiplyMatrices(parentWorld, localMatrix(node));

  if (node.mesh) {
    for (const primitive of node.mesh.primitives) {
      const posAttr = primitive.attributes.POSITION;
      if (!posAttr) continue;
      const vertexCount = Math.floor(posAttr.value.length / 3);
      if (walk.vertexCount + vertexCount > walk.maxVertices) {
        throw new LoadError(
          'memory-constraint',
          `glTF asset emits more than ${walk.maxVertices} vertices across its nodes; it is too large to open.`,
        );
      }
      walk.vertexCount += vertexCount;
      walk.placed.push({ primitive, src: posAttr.value, world, vertexCount });
    }
  }

  if (node.children) {
    for (const child of node.children) collectNode(child, world, walk, depth + 1);
  }
}

/**
 * Write one placed primitive's transformed positions, colours and normals into
 * the staging arrays at the cursor. Drops the normal channel (sets it to null)
 * when the primitive has no usable normals, since a partial channel would
 * misalign with the positions.
 */
function stagePrimitive({ primitive, src, world, vertexCount }: PlacedPrimitive, out: Staging): void {
  const base = out.at;
  const colAttr = primitive.attributes.COLOR_0;
  // postProcessGLTF reports the per-element width as `components`
  // (VEC3 = 3, VEC4 = 4); reading a VEC4 colour at a stride of 3 walks
  // the alpha channel into the next vertex's red.
  const colSize = colAttr?.components ?? colAttr?.size ?? 3;
  // glTF 2.0 defines COLOR_0 as LINEAR RGB for every component type:
  // FLOAT in [0, 1], and UNSIGNED_BYTE / UNSIGNED_SHORT, which the spec
  // requires to be `normalized`, as fractions of their type maximum. A
  // non-conforming integer accessor without the flag is read the same
  // way, since no other reading of an integer colour is meaningful.
  // Cloud colour bytes are sRGB-encoded (colorEncode.ts decodes them
  // with the EOTF on upload), so each component is normalised to [0, 1]
  // here and then encoded with the sRGB OETF. Storing the linear value
  // directly as a byte made midtones render too dark (linear 0.5 showed
  // as sRGB 128 instead of 188). Alpha is not carried.
  let colScale = 1;
  if (colAttr) {
    const cv = colAttr.value;
    if (cv instanceof Uint8Array || cv instanceof Uint8ClampedArray) colScale = 1 / 255;
    else if (cv instanceof Uint16Array) colScale = 1 / 65535;
  }
  const normAttr = primitive.attributes.NORMAL;
  const primNormals = normAttr ? authoredNormals(normAttr.value, vertexCount, normAttr.components ?? normAttr.size ?? 3) : undefined;
  if (primNormals) {
    // Normals transform by the inverse-transpose of the node's upper 3x3,
    // not the matrix itself: under a non-uniform scale the plain matrix
    // tilts a normal off its surface. The cofactor matrix equals
    // det * inverse-transpose, so it stays defined for a singular node; the
    // sign of det keeps a mirrored node's normals facing out.
    const [a, b, c, , d, e, f, , g, h, k] = world.elements;
    const c00 = e * k - f * h, c01 = f * g - d * k, c02 = d * h - e * g;
    const c10 = c * h - b * k, c11 = a * k - c * g, c12 = b * g - a * h;
    const c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d;
    const det = a * c00 + b * c01 + c * c02;
    const sign = det < 0 ? -1 : 1;
    const normals = out.nrm;
    for (let i = 0; normals && i < vertexCount; i++) {
      const x = primNormals[i * 3];
      const y = primNormals[i * 3 + 1];
      const z = primNormals[i * 3 + 2];
      const nx = c00 * x + c10 * y + c20 * z;
      const ny = c01 * x + c11 * y + c21 * z;
      const nz = c02 * x + c12 * y + c22 * z;
      const len = Math.hypot(nx, ny, nz);
      // A singular node can flatten a normal to zero; it has no direction
      // left, so the channel is dropped rather than carried as non-unit.
      if (!(len > 1e-12)) {
        out.nrm = null;
        break;
      }
      const o = (base + i) * 3;
      normals[o] = (sign * nx) / len;
      normals[o + 1] = (sign * ny) / len;
      normals[o + 2] = (sign * nz) / len;
    }
  } else {
    out.nrm = null;
  }

  const { xyz, rgb } = out;
  for (let i = 0; i < vertexCount; i++) {
    // Apply the node's world transform so multi-node scans line up.
    const x = src[i * 3 + 0];
    const y = src[i * 3 + 1];
    const z = src[i * 3 + 2];
    const e = world.elements;
    const o = (base + i) * 3;
    xyz[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
    xyz[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    xyz[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];

    if (rgb) {
      if (colAttr) {
        // linearToSrgb clamps to [0, 1], so a gamut excursion or a
        // out-of-range value cannot overflow the Uint8 stride.
        rgb[o] = Math.round(255 * linearToSrgb(colAttr.value[i * colSize + 0] * colScale));
        rgb[o + 1] = Math.round(255 * linearToSrgb(colAttr.value[i * colSize + 1] * colScale));
        rgb[o + 2] = Math.round(255 * linearToSrgb(colAttr.value[i * colSize + 2] * colScale));
      } else {
        // Pad with opaque white so the colour buffer stays aligned even
        // when only some primitives carry COLOR_0.
        rgb[o] = rgb[o + 1] = rgb[o + 2] = 255;
      }
    }
  }
  out.at += vertexCount;
}

/**
 * The glTF JSON of a `.gltf` file or of a GLB's first (JSON) chunk, or null
 * when it cannot be read; loaders.gl then reports the malformed file itself.
 */
function gltfJson(buffer: ArrayBuffer, sourceFormat: 'glb' | 'gltf'): unknown {
  try {
    const bytes = new Uint8Array(buffer);
    let text: string;
    if (sourceFormat === 'glb' || (bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46)) {
      if (bytes.length < 20) return null;
      const view = new DataView(buffer);
      const chunkLength = view.getUint32(12, true);
      const chunkType = view.getUint32(16, true);
      if (chunkType !== 0x4e4f534a || 20 + chunkLength > bytes.length) return null; // 'JSON'
      text = new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength));
    } else {
      text = new TextDecoder().decode(bytes);
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * URIs in `buffers` and `images` that point outside the file. A local open
 * resolves nothing outside the file: loaders.gl would otherwise fetch an
 * absolute http(s) URI, which sends a request to a host the file names
 * without the user asking.
 */
export function externalGltfUris(buffer: ArrayBuffer, sourceFormat: 'glb' | 'gltf'): string[] {
  const doc = gltfJson(buffer, sourceFormat) as { buffers?: unknown; images?: unknown } | null;
  if (!doc || typeof doc !== 'object') return [];
  const out: string[] = [];
  for (const list of [doc.buffers, doc.images]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const uri = (entry as { uri?: unknown } | null)?.uri;
      if (typeof uri === 'string' && !/^data:/i.test(uri.trim())) out.push(uri);
    }
  }
  return out;
}

const DRACO_EXTENSION = 'KHR_draco_mesh_compression';

const DRACO_MESSAGE =
  'This glTF uses Draco mesh compression (KHR_draco_mesh_compression). The Draco decoder is not bundled ' +
  'with this viewer and no decoder is downloaded, so the mesh cannot be read. Re-export the model without ' +
  'Draco compression, or as a PLY or OBJ file.';

/** Bytes per glTF accessor component type; unknown types are costed as 4. */
const GLTF_COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** Components per glTF accessor type; unknown types are costed as 16. */
const GLTF_TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

/**
 * Refuse a glTF whose JSON asks for work the file cannot back, BEFORE
 * loaders.gl parses it.
 *
 * The parser allocates a zero-filled typed array for an accessor that has no
 * `bufferView` (the spec's zero-initialised accessor) and for a sparse
 * accessor's base, sized from the declared `count`. A ~400-byte GLB declaring
 * 300 million VEC3 floats therefore reserved 3.6 GB before the vertex cap was
 * consulted. An accessor that does have a `bufferView` is a view into bytes
 * already in the file, so its count cannot allocate more than the file holds
 * and is left to the parser.
 *
 * The zero-filled bytes of all such accessors together are held to
 * `maxVertices * 12` (the size of the POSITION array the vertex cap itself
 * permits), so no accessor and no sum of them can exceed what a conforming
 * open could emit. Draco-compressed meshes are refused here too: the decoder is
 * not bundled and loaders.gl would otherwise fetch it from a CDN.
 */
function assertGltfJsonAdmissible(buffer: ArrayBuffer, sourceFormat: 'glb' | 'gltf', maxVertices: number): void {
  const doc = gltfJson(buffer, sourceFormat) as {
    extensionsUsed?: unknown;
    extensionsRequired?: unknown;
    accessors?: unknown;
  } | null;
  if (!doc || typeof doc !== 'object') return;

  for (const list of [doc.extensionsUsed, doc.extensionsRequired]) {
    if (Array.isArray(list) && list.includes(DRACO_EXTENSION)) {
      throw new LoadError('unsupported-format', DRACO_MESSAGE, DRACO_MESSAGE);
    }
  }

  if (!Array.isArray(doc.accessors)) return;
  const budget = maxVertices * 12;
  let synthesised = 0;
  for (const raw of doc.accessors) {
    const acc = raw as {
      count?: unknown;
      bufferView?: unknown;
      componentType?: unknown;
      type?: unknown;
      sparse?: { count?: unknown } | null;
    } | null;
    if (!acc || typeof acc !== 'object') continue;
    const count = acc.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new LoadError('malformed-file', 'glTF accessor declares a count that is not a non-negative whole number.');
    }
    const sparseCount = acc.sparse && typeof acc.sparse === 'object' ? acc.sparse.count : undefined;
    if (sparseCount !== undefined && (typeof sparseCount !== 'number' || !Number.isSafeInteger(sparseCount) || sparseCount < 0)) {
      throw new LoadError('malformed-file', 'glTF sparse accessor declares a count that is not a non-negative whole number.');
    }
    if (acc.bufferView !== undefined && sparseCount === undefined) continue;
    const bytes =
      count *
      (GLTF_COMPONENT_BYTES[acc.componentType as number] ?? 4) *
      (GLTF_TYPE_COMPONENTS[acc.type as string] ?? 16);
    synthesised += bytes;
    if (!Number.isFinite(synthesised) || synthesised > budget) {
      throw new LoadError(
        'memory-constraint',
        `glTF asset declares accessors that would be zero-filled to more than ${budget} bytes without any data in the file; it is too large to open.`,
      );
    }
  }
}

const EXTERNAL_GLTF_MESSAGE =
  'This glTF references external files (e.g. buffer.bin or a web address) that a single-file open does not load. Export as GLB, or a self-contained .gltf with embedded/data-URI buffers.';

/**
 * Load a `.glb` / `.gltf` asset into a `PointCloud` of its mesh vertices.
 *
 * @param buffer       Raw file bytes.
 * @param sourceFormat Either `'glb'` or `'gltf'`.
 * @param name         Display name (defaults to `"cloud.<format>"`).
 */
export async function loadGltf(
  buffer: ArrayBuffer,
  sourceFormat: 'glb' | 'gltf',
  name = `cloud.${sourceFormat}`,
  options: { maxVertices?: number } = {},
): Promise<PointCloud> {
  // Nothing here touches images: the loader keeps vertex geometry only, and
  // the image paths need the DOM `Image` constructor, which the parse worker
  // does not have, so they failed every GLB opened in a browser with "Image is
  // not defined". `loadImages: false` skips texture decoding. The texture
  // format extensions are excluded because their preprocess step probes
  // browser image support by building an `Image` even when the asset has no
  // textures (loaders.gl excludes an extension whose key maps to `false`).
  // Refuse before parsing: nothing outside the file is requested.
  if (externalGltfUris(buffer, sourceFormat).length > 0) throw new Error(EXTERNAL_GLTF_MESSAGE);
  assertGltfJsonAdmissible(buffer, sourceFormat, options.maxVertices ?? MAX_GLTF_VERTICES);
  const raw = await parse(buffer, GLTFLoader, {
    ...LOCAL_ONLY_LOADER_OPTIONS,
    gltf: {
      loadImages: false,
      // Draco files are refused above. These keep loaders.gl from ever trying
      // to load a decoder (its loader fetches one from a CDN) if that gate is bypassed.
      decompressMeshes: false,
      excludeExtensions: {
        EXT_texture_avif: false,
        EXT_texture_webp: false,
        KHR_texture_basisu: false,
        [DRACO_EXTENSION]: false,
      },
    },
  }).catch((err: unknown) => {
    // A standard multi-file .gltf that references an external buffer (e.g.
    // buffer.bin) can't be resolved from a single in-page file — the browser
    // hands us one file, not the sibling. Surface a precise, actionable message
    // instead of loaders.gl's internal "'baseUrl' must be provided…" error.
    const msg = err instanceof Error ? err.message : String(err);
    if (/baseUrl/i.test(msg)) {
      throw new Error(EXTERNAL_GLTF_MESSAGE);
    }
    throw err;
  });
  const gltf = postProcessGLTF(raw) as unknown as {
    /**
     * The DEFAULT scene, already dereferenced. glTF's top-level `scene` is an
     * index into `scenes`; loaders.gl resolves it to the scene object when the
     * source JSON carries one (`post-process-gltf.js`), so this is an object
     * here, not a number.
     */
    scene?: { nodes?: GltfNode[] };
    scenes?: { nodes?: GltfNode[] }[];
    nodes?: GltfNode[];
    asset?: { generator?: string };
    images?: unknown[];
    materials?: unknown[];
  };
  // Read the source glTF JSON too (loaders.gl keeps it on the parse result); it
  // is the most reliable place for asset.generator, images, and materials
  // regardless of what postProcessGLTF preserves.
  const rawJson = (raw as {
    json?: { asset?: { generator?: string }; images?: unknown[]; materials?: unknown[] };
  }).json;
  // The glTF `asset.generator` string (e.g. "Polycam", "Scaniverse",
  // "RealityKit") is the capture app's stamp — the honest home for it is the
  // same declared-software field a LAS "Generating Software" record uses. The
  // display profile reads it (via metadata.sourceSoftware) for high-confidence
  // handheld-capture identification. Many exports omit it, in which case the
  // profile falls back to the geometry signal.
  const generator = (rawJson?.asset?.generator ?? gltf.asset?.generator)?.trim();
  // Whether the asset carried a texture/material. The loader keeps only vertex
  // geometry (dropping textures), so this flag is the only surviving signal that
  // a bare-looking point set was a textured capture — the display profile uses
  // it to tell a handheld/object capture from a plain CAD mesh. Soft signal:
  // a default `materials: [{}]` (untextured) reads as true here, so it
  // over-triggers toward "capture" rather than under — the profile treats it as
  // supporting evidence, never a sole determinant.
  const hasTexture =
    (rawJson?.images?.length ?? gltf.images?.length ?? 0) > 0
    || (rawJson?.materials?.length ?? gltf.materials?.length ?? 0) > 0;

  const identity = new Matrix4();
  const walk: NodeWalk = {
    visited: new Set(),
    maxVertices: options.maxVertices ?? MAX_GLTF_VERTICES,
    placed: [],
    vertexCount: 0,
  };

  // Walk ONE scene — the default one.
  //
  // Merging the roots of every scene (the previous shape) treated a multi-scene
  // asset as if all its scenes were meant to be seen at once. They are not: the
  // top-level `scene` property names the one to display, and the others are
  // alternates — an LOD variant, a rejected pose, a packaging scene. Merging
  // them silently double-counted the geometry and, when the alternates sit at
  // different transforms, scattered copies of the model through the cloud with
  // nothing in the UI to say why. Exporters that write a single scene (the
  // common case) are unaffected either way.
  //
  // `scenes[0]` is the fallback for an asset with scenes but no `scene`, which
  // the spec permits and leaves to the viewer. The flat `nodes` walk below
  // remains the last resort, for an asset with no usable scene roots at all.
  const defaultScene = gltf.scene ?? gltf.scenes?.[0];
  const roots = defaultScene ? (defaultScene.nodes ?? []) : [];
  if (roots.length > 0) {
    for (const root of roots) {
      collectNode(root, identity, walk);
    }
  } else if (gltf.nodes) {
    // No scene: every node is walked as a root unless an earlier walk
    // already reached it as a descendant.
    for (const node of gltf.nodes) {
      if (walk.visited.has(node)) continue;
      collectNode(node, identity, walk);
    }
  }

  if (walk.vertexCount === 0) {
    throw new Error('glTF asset contains no mesh POSITION data');
  }

  // Stage into arrays sized from the walk's total. Colours are kept when any
  // primitive carries COLOR_0; normals only when every primitive supplies a
  // usable set, since a partial channel would misalign with the positions.
  const total = walk.vertexCount;
  const out: Staging = {
    xyz: new Float32Array(total * 3),
    rgb: walk.placed.some((p) => p.vertexCount > 0 && p.primitive.attributes.COLOR_0) ? new Uint8Array(total * 3) : null,
    nrm: walk.placed.every((p) => p.primitive.attributes.NORMAL) ? new Float32Array(total * 3) : null,
    at: 0,
  };
  for (const placed of walk.placed) stagePrimitive(placed, out);

  // glTF vertices are already local — the asset carries no georeferencing, so
  // the origin stays zero and there is no origin to protect. A node transform
  // can still produce an unplaceable vertex from placeable inputs (a degenerate
  // or non-finite matrix multiplies through), so the same policy every other
  // loader answers to applies here too.
  const clean = sanitizeLocalCloud(out.xyz, {
    colors: out.rgb ?? undefined,
    normals: out.nrm ?? undefined,
  });

  const declared =
    generator || hasTexture
      ? {
          ...(generator ? { sourceSoftware: generator } : {}),
          ...(hasTexture ? { hasTexture: true } : {}),
        }
      : undefined;

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    normals: clean.attributes.normals,
    origin: [0, 0, 0],
    sourceFormat: sourceFormat as SourceFormat,
    name,
    metadata: withLoadWarning(declared, clean.warning),
  });
}
