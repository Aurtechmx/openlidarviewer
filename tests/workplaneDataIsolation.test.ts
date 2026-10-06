/**
 * The reference plane cannot reach any data path.
 *
 * `workplaneAnalysisInvariance.test.ts` shows the result digests are equal
 * with the plane off and on, but the analyses never receive the scene, so that
 * test alone could not fail. These checks hold the property that makes it true,
 * and each fails when the property breaks:
 *
 *  1. No source file reads the three.js scene graph through a traversal or
 *     raycast API. Picking, measurement, terrain, profiles and exports all read
 *     the scan's own buffers; a scene walk is the only way a grid line could be
 *     read as data. (Checked by adding `scene.traverse(() => {})` to a terrain
 *     module: this test then fails and names the file.)
 *  2. The one scene walker in the tree, the frame-budget governor, only reduces
 *     instanced point meshes and leaves the grid's line sets untouched.
 *  3. No data-path module imports the plane's drawing or controller; only the
 *     session parser reads its plain settings.
 *  4. The grid's object names appear in the plane's own modules only.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as THREE from 'three/webgpu';
import * as tsl from 'three/tsl';
import { WorkplaneOverlay } from '../src/render/workplane/WorkplaneOverlay';
import { buildWorkplaneGeometry } from '../src/render/workplane/workplaneGeometry';
import { principalPlane } from '../src/render/workplane/workplanePlane';
import { GovernorWiring } from '../src/render/perf/governorWiring';
import { GOVERNOR_INPUT, wiredGovernor } from './helpers/scientificDigests';
import type { KeepNodeBuilders } from '../src/render/perf/governorHook';

const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');

function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Source text with comments removed, so a sentence about traversal does not count. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (f: string): string => relative(ROOT, f).split('\\').join('/');

describe('the reference plane cannot reach a data path', () => {
  it('no source file walks or raycasts the scene graph', () => {
    const SCENE_READ = /\b(traverse|traverseVisible|traverseAncestors|intersectObjects?|getObjectBy\w*|getObjectsByProperty)\s*\(|\b_?scene\.children\b/;
    const offenders = sources().filter((f) => SCENE_READ.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the frame-budget governor, the one scene walker, leaves the grid alone', () => {
    const scene = new THREE.Scene();
    const overlay = new WorkplaneOverlay({ add: (o) => scene.add(o), remove: (o) => scene.remove(o), requestFrame: () => {} });
    overlay.update(buildWorkplaneGeometry({
      plane: principalPlane('horizontal', [0, 0, 0], 'z'),
      patch: { iMin: -5, iMax: 5, jMin: -5, jMax: 5 },
      major: 5, minor: 1, showMinor: true, sceneOrigin: [0, 0, 0],
    }));
    const lines: THREE.LineSegments[] = [];
    scene.children[0].children.forEach((c) => lines.push(c as THREE.LineSegments));
    const before = lines.map((l) => (l.material as THREE.LineBasicNodeMaterial).opacityNode);
    const gov: GovernorWiring = wiredGovernor(GOVERNOR_INPUT.stressed);
    gov.points(scene, tsl as unknown as KeepNodeBuilders);
    expect(gov.presentation().reducedMeshes).toBe(0);
    lines.forEach((l, i) => {
      const m = l.material as THREE.LineBasicNodeMaterial & { sizeNode?: unknown };
      expect(m.opacityNode).toBe(before[i]);
      expect(m.sizeNode ?? null).toBeNull();
    });
    overlay.dispose();
  });

  it('no data-path module imports the plane, beyond the session reading its settings', () => {
    const DATA = ['src/terrain/', 'src/analysis/', 'src/science/', 'src/export/', 'src/io/', 'src/convert/', 'src/report/', 'src/render/measure/', 'src/render/streaming/', 'src/geo/', 'src/process/', 'src/validation/'];
    const IMPORT = /from\s+['"]([^'"]*workplane[^'"]*)['"]|import\(\s*['"]([^'"]*workplane[^'"]*)['"]/g;
    const found: string[] = [];
    for (const f of sources()) {
      const r = rel(f);
      if (!DATA.some((d) => r.startsWith(d))) continue;
      for (const m of code(f).matchAll(IMPORT)) {
        const spec = m[1] ?? m[2];
        if (!spec.endsWith('model/workplaneSettings')) found.push(`${r} -> ${spec}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the grid object names appear only in the plane modules', () => {
    const OWN = /^src\/(render\/workplane\/|app\/workplane|ui\/workplane|ui\/referencePlaneSection)/;
    const users = sources().filter((f) => code(f).includes('olv-reference-plane')).map(rel).filter((r) => !OWN.test(r));
    expect(users).toEqual([]);
  });
});
