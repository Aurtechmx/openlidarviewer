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
import { Matrix4, Quaternion, Vector3 } from 'three';
import { PointCloud } from '../model/PointCloud';
import { sanitizeLocalCloud, withLoadWarning } from './sanitizeCloud';
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
  attributes: Record<string, { value: ArrayLike<number>; size?: number } | undefined>;
}

/** Build the local transform of a node from either `matrix` or its TRS parts. */
function localMatrix(node: GltfNode): Matrix4 {
  const m = new Matrix4();
  if (node.matrix && node.matrix.length === 16) {
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
 * Recursively collect transformed vertex positions and (optional) colours from
 * a node and its descendants.
 */
function collectNode(
  node: GltfNode,
  parentWorld: Matrix4,
  positions: number[],
  colors: number[],
  colorSeen: { any: boolean },
): void {
  const world = new Matrix4().multiplyMatrices(parentWorld, localMatrix(node));

  if (node.mesh) {
    for (const primitive of node.mesh.primitives) {
      const posAttr = primitive.attributes.POSITION;
      if (!posAttr) continue;
      const src = posAttr.value;
      const vertexCount = Math.floor(src.length / 3);

      const colAttr = primitive.attributes.COLOR_0;
      const colSize = colAttr?.size ?? 3;
      // glTF spec — COLOR_0 components are normalised. Float arrays
      // carry `[0, 1]` linear values; Uint8 carries `[0, 255]`; Uint16
      // carries `[0, 65535]`. The output buffer expects `[0, 255]`, so
      // detect the source type once per primitive and scale the per-
      // vertex push accordingly. Without this scale, a float-typed
      // value of 0.5 becomes 0 when packed into `new Uint8Array(...)`
      // and most coloured mobile scans render near-black.
      const colScale = colAttr
        ? colAttr.value instanceof Float32Array || colAttr.value instanceof Float64Array
          ? 255
          : colAttr.value instanceof Uint16Array
            ? 255 / 65535
            : 1
        : 1;

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
          const r = colAttr.value[i * colSize + 0] * colScale;
          const g = colAttr.value[i * colSize + 1] * colScale;
          const b = colAttr.value[i * colSize + 2] * colScale;
          // Clamp before push — gamut excursions or a rogue alpha bit
          // shouldn't overflow the Uint8 stride.
          colors.push(
            Math.max(0, Math.min(255, Math.round(r))),
            Math.max(0, Math.min(255, Math.round(g))),
            Math.max(0, Math.min(255, Math.round(b))),
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
      collectNode(child, world, positions, colors, colorSeen);
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
  const raw = await parse(buffer, GLTFLoader).catch((err: unknown) => {
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
  const identity = new Matrix4();

  // Prefer walking the scene roots; fall back to every node if there are none.
  const roots = gltf.scenes?.flatMap((scene) => scene.nodes ?? []) ?? [];
  if (roots.length > 0) {
    for (const root of roots) {
      collectNode(root, identity, positions, colors, colorSeen);
    }
  } else if (gltf.nodes) {
    for (const node of gltf.nodes) {
      collectNode(node, identity, positions, colors, colorSeen);
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
    origin: [0, 0, 0],
    sourceFormat: sourceFormat as SourceFormat,
    name,
    metadata: withLoadWarning(declared, clean.warning),
  });
}
