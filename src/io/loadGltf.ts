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
          colors.push(
            colAttr.value[i * colSize + 0],
            colAttr.value[i * colSize + 1],
            colAttr.value[i * colSize + 2],
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
  const raw = await parse(buffer, GLTFLoader);
  const gltf = postProcessGLTF(raw) as unknown as {
    scenes?: { nodes?: GltfNode[] }[];
    nodes?: GltfNode[];
  };

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

  return new PointCloud({
    positions: new Float32Array(positions),
    colors: colorSeen.any ? new Uint8Array(colors) : undefined,
    origin: [0, 0, 0],
    sourceFormat: sourceFormat as SourceFormat,
    name,
  });
}
