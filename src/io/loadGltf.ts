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
 * Recursively collect transformed vertex positions and (optional) colours from
 * a node and its descendants.
 */
function collectNode(
  node: GltfNode,
  parentWorld: Matrix4,
  positions: number[],
  colors: number[],
  colorSeen: { any: boolean },
  normals: number[],
  normalSeen: { missing: boolean },
  depth = 0,
): void {
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
      const src = posAttr.value;
      const vertexCount = Math.floor(src.length / 3);

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
        for (let i = 0; i < vertexCount; i++) {
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
            normalSeen.missing = true;
            normals.push(0, 0, 0);
            continue;
          }
          normals.push((sign * nx) / len, (sign * ny) / len, (sign * nz) / len);
        }
      } else {
        normalSeen.missing = true;
      }

      for (let i = 0; i < vertexCount; i++) {
        // Apply the node's world transform so multi-node scans line up.
        const x = src[i * 3 + 0];
        const y = src[i * 3 + 1];
        const z = src[i * 3 + 2];
        const e = world.elements;
        positions.push(
          e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14],
        );

        if (colAttr) {
          colorSeen.any = true;
          // linearToSrgb clamps to [0, 1], so a gamut excursion or a
          // out-of-range value cannot overflow the Uint8 stride.
          colors.push(
            Math.round(255 * linearToSrgb(colAttr.value[i * colSize + 0] * colScale)),
            Math.round(255 * linearToSrgb(colAttr.value[i * colSize + 1] * colScale)),
            Math.round(255 * linearToSrgb(colAttr.value[i * colSize + 2] * colScale)),
          );
        } else {
          // Pad with opaque white so the colour buffer stays aligned even
          // when only some primitives carry COLOR_0.
          colors.push(255, 255, 255);
        }
      }
    }
  }

  if (node.children) {
    for (const child of node.children) {
      collectNode(child, world, positions, colors, colorSeen, normals, normalSeen, depth + 1);
    }
  }
}

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
): Promise<PointCloud> {
  // Nothing here touches images: the loader keeps vertex geometry only, and
  // the image paths need the DOM `Image` constructor, which the parse worker
  // does not have, so they failed every GLB opened in a browser with "Image is
  // not defined". `loadImages: false` skips texture decoding. The texture
  // format extensions are excluded because their preprocess step probes
  // browser image support by building an `Image` even when the asset has no
  // textures (loaders.gl excludes an extension whose key maps to `false`).
  const raw = await parse(buffer, GLTFLoader, {
    ...LOCAL_ONLY_LOADER_OPTIONS,
    gltf: {
      loadImages: false,
      excludeExtensions: { EXT_texture_avif: false, EXT_texture_webp: false, KHR_texture_basisu: false },
    },
  }).catch((err: unknown) => {
    // A standard multi-file .gltf that references an external buffer (e.g.
    // buffer.bin) can't be resolved from a single in-page file — the browser
    // hands us one file, not the sibling. Surface a precise, actionable message
    // instead of loaders.gl's internal "'baseUrl' must be provided…" error.
    const msg = err instanceof Error ? err.message : String(err);
    if (/baseUrl/i.test(msg)) {
      throw new Error(
        'This glTF references external files (e.g. buffer.bin) that a single-file open cannot resolve. Export as GLB, or a self-contained .gltf with embedded/data-URI buffers.',
      );
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

  const positions: number[] = [];
  const colors: number[] = [];
  const colorSeen = { any: false };
  // Normals are kept only when every primitive supplies a usable set; a
  // partial channel would misalign with the positions.
  const normals: number[] = [];
  const normalSeen = { missing: false };
  const identity = new Matrix4();

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
      collectNode(root, identity, positions, colors, colorSeen, normals, normalSeen);
    }
  } else if (gltf.nodes) {
    for (const node of gltf.nodes) {
      collectNode(node, identity, positions, colors, colorSeen, normals, normalSeen);
    }
  }

  if (positions.length === 0) {
    throw new Error('glTF asset contains no mesh POSITION data');
  }

  // glTF vertices are already local — the asset carries no georeferencing, so
  // the origin stays zero and there is no origin to protect. A node transform
  // can still produce an unplaceable vertex from placeable inputs (a degenerate
  // or non-finite matrix multiplies through), so the same policy every other
  // loader answers to applies here too.
  const clean = sanitizeLocalCloud(new Float32Array(positions), {
    colors: colorSeen.any ? new Uint8Array(colors) : undefined,
    normals: normalSeen.missing ? undefined : new Float32Array(normals),
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
