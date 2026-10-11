/**
 * drawPrecisionShaderContract.test.ts: the evidence behind mapping OLV's static
 * point draw to the spe-check expressions (docs/architecture/draw-precision-contract.md).
 *
 * The per-draw bound holds only when the vertex stage computes the eye-space
 * centre as ONE affine mat4 times vec4(p, 1.0), with the mat4 composed in
 * binary64 on the CPU and narrowed once, and p a Float32 local coordinate.
 * `app/drawPrecisionView.ts` declares the static cloud path
 * `instanced-quad-highp` on that basis. Every fact the declaration rests on is
 * pinned here, in OLV and in the installed three.js, so a change to either
 * fails this test instead of silently keeping a PASS the shader no longer earns.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');
const THREE_SRC = 'node_modules/three/src';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('three.js (the version the mapping was verified against)', () => {
  it('is 0.186.0; a different version needs the evidence re-read', () => {
    expect(JSON.parse(read('node_modules/three/package.json')).version).toBe('0.186.0');
  });

  it('PointsNodeMaterial computes the view position as modelViewMatrix * vec3(positionNode)', () => {
    const src = read(`${THREE_SRC}/materials/nodes/PointsNodeMaterial.js`);
    expect(src).toContain('return modelViewMatrix.mul( vec3( positionNode || positionLocal ) ).xyz;');
    // The sprite offset is added after projection, in clip space: outside the bounded expression.
    expect(src).toContain('let mvp = super.setupVertex( builder );');
    expect(src).toContain('mvp = mvp.add( vec4( offset, 0, 0 ) );');
  });

  it('a mat4 times a vec3 is emitted as mat4 * vec4(p, 1.0)', () => {
    const src = read(`${THREE_SRC}/nodes/core/NodeBuilder.js`);
    expect(src).toContain("return `${ this.getType( toType ) }( ${ this.format( snippet, fromType, 'vec3' ) }, 1.0 )`;");
  });

  it('modelViewMatrix resolves to the context matrix, which highPrecision sets to the CPU-composed uniform', () => {
    const model = read(`${THREE_SRC}/nodes/accessors/ModelNode.js`);
    expect(model).toContain('return builder.context.modelViewMatrix || mediumpModelViewMatrix;');
    expect(model).toContain('return object.modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse, object.matrixWorld );');
    const renderer = read(`${THREE_SRC}/renderers/common/Renderer.js`);
    expect(renderer).toContain('contextNodeData.modelViewMatrix = highpModelViewMatrix;');
  });

  it('the WebGL 2 fallback compiles GLSL ES 3.00 with highp floats', () => {
    const src = read(`${THREE_SRC}/renderers/webgl-fallback/nodes/GLSLNodeBuilder.js`);
    expect(src).toContain('precision highp float;');
    expect(src).toContain('#version 300 es');
  });
});

describe('OLV point draw path', () => {
  it('the renderer is created with highPrecision on', () => {
    expect(read('src/render/viewerRenderBootstrap.ts')).toMatch(/^\s*renderer\.highPrecision = true;$/m);
  });

  it('buildPointMesh feeds the Float32 local centre straight into positionNode of a PointsNodeMaterial on a plain Mesh', () => {
    const v = read('src/render/Viewer.ts');
    expect(v).toContain('const material = new THREE.PointsNodeMaterial();');
    expect(v).toContain('const positionAttr = new THREE.InstancedBufferAttribute(positions, 3);');
    expect(v).toContain('material.positionNode = instancedBufferAttribute(positionAttr) as TslNode;');
    expect(v).toContain('const mesh = new THREE.Mesh(geometry, material);');
    expect(v).not.toMatch(/new THREE\.InstancedMesh\(/);
  });

  it('no other source assigns a position or vertex node or overrides the view position', () => {
    const hits: string[] = [];
    for (const f of walk(resolve(ROOT, 'src'))) {
      const text = readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\.(positionNode|vertexNode)\s*=(?!=)|setupPositionView|context\.modelViewMatrix/.test(line)) {
          hits.push(`${relative(ROOT, f)}:${i + 1}`);
        }
      });
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^src\/render\/Viewer\.ts:\d+$/);
  });

  it('the composition mirrors three: camera.matrixWorldInverse x mesh.matrixWorld, read-only', () => {
    expect(read('src/render/Viewer.ts')).toContain(
      'new THREE.Matrix4().multiplyMatrices(this._activeCamera().matrixWorldInverse, e.mesh.matrixWorld)',
    );
  });

  it('rendering is unaffected: nothing under src/render imports the checker or the diagnostic', () => {
    const offenders = walk(resolve(ROOT, 'src/render')).filter((f) =>
      /from '[^']*(vendor\/spe-check|science\/drawPrecision|app\/drawPrecisionView)/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
