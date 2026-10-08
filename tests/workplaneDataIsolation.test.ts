/**
 * The reference plane cannot reach any data path.
 *
 * `workplaneAnalysisInvariance.test.ts` shows the result digests are equal
 * with the plane off and on, but the analyses never receive the scene, so that
 * test alone could not fail. These checks hold the property that makes it true,
 * and each fails when the property breaks:
 *
 *  1. No source file reads the three.js scene graph: any `.children` read,
 *     `traverse` or `.raycast(` outside a reviewed list of files (DOM and
 *     parsed-tree readers, and the governor) fails. Picking, measurement, terrain, profiles and exports all read
 *     the scan's own buffers; a scene walk is the only way a grid line could be
 *     read as data. (Checked by adding `scene.traverse(() => {})` to a terrain
 *     module: this test then fails and names the file.)
 *  2. The one scene walker in the tree, the frame-budget governor, only reduces
 *     instanced point meshes and leaves the grid's line sets untouched.
 *  3. Only the plane's own modules, its View panel host, the lazy loader and
 *     the session code import the plane, and the session code reads only its
 *     plain settings.
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
  it('no source file walks or raycasts the scene graph, outside a reviewed list', () => {
    // Any `.children` read, any `traverse`, any `.raycast(` call. Each file
    // below reads `.children` of something that is not the three.js scene (a
    // DOM node, a parsed XML / WKT / glTF / tileset tree), or is the reviewed
    // scene walker. A new file that matches must be read and added here.
    const SCENE_READ = /\.children\b|\.raycast\s*\(|\btraverse\b|\bintersectObjects?\s*\(|\bgetObjectBy\w*\s*\(|\bgetObjectsByProperty\s*\(/;
    const REVIEWED: Record<string, string> = {
      'src/render/perf/governorWiring.ts': 'scene walker: reduces instanced point meshes only (checked below)',
      'src/science/methodRegistry.ts': 'the word "traverse" in a method description string',
      'src/render/measure/MeasureOverlay.ts': 'DOM: SVG element children',
      'src/ui/labGuide.ts': 'DOM: spread of child nodes',
      'src/ui/AnalysePanel.ts': 'DOM',
      'src/ui/MeasurePanel.ts': 'DOM',
      'src/ui/ClassLegendPanel.ts': 'DOM',
      'src/ui/Inspector.ts': 'DOM',
      'src/ui/StreamingPanel.ts': 'DOM',
      'src/app/workspace/workspaceRouter.ts': 'DOM',
      'src/app/workspace/modeHome.ts': 'DOM',
      'src/app/sessionLog/sessionLogRecorder.ts': 'DOM',
      'src/io/wktParser.ts': 'WKT parse tree',
      'src/io/crs.ts': 'WKT parse tree',
      'src/io/loadGltf.ts': 'glTF JSON node tree',
      'src/io/e57/schema.ts': 'E57 XML tree',
      'src/io/e57/xml.ts': 'E57 XML tree',
      'src/io/tiles3d/externalTilesets.ts': '3D Tiles tileset JSON tree',
      'src/io/tiles3d/tilesetTraversal.ts': '3D Tiles tileset JSON tree',
      'src/io/tiles3d/tileTransform.ts': '3D Tiles tileset JSON tree',
      'src/io/tiles3d/tilesetFrame.ts': '3D Tiles tileset JSON tree',
      'src/io/tiles3d/tileset.ts': '3D Tiles tileset JSON tree',
      'src/io/tiles3d/implicitExpand.ts': '3D Tiles tileset JSON tree',
    };
    const matches = sources().filter((f) => SCENE_READ.test(code(f))).map(rel);
    expect(matches.filter((r) => !(r in REVIEWED))).toEqual([]);
    // A reviewed file that stopped matching is dropped from the list, so the list stays honest.
    expect(Object.keys(REVIEWED).filter((r) => !matches.includes(r))).toEqual([]);
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

  it('only the plane, its View panel host and the session read the plane modules', () => {
    // src/app and src/render included: a module there that started to import
    // the drawing or the controller would be a new path from the plane to data.
    const IMPORT = /from\s+['"]([^'"]*(?:workplane|referencePlaneSection)[^'"]*)['"]|import\(\s*['"]([^'"]*(?:workplane|referencePlaneSection)[^'"]*)['"]/g;
    const PLANE = /^src\/(render\/workplane\/|app\/workplane|ui\/workplanePanel|ui\/referencePlaneSection)/;
    const ALLOWED: Record<string, RegExp> = {
      'src/ui/Inspector.ts': /referencePlaneSection$/,
      'src/lazyChunks.ts': /app\/workplaneMount$/,
      'src/io/session.ts': /model\/workplaneSettings$/,
      'src/app/sessionIo.ts': /model\/workplaneSettings$/,
      'src/app/sessionSnapshot.ts': /model\/workplaneSettings$/,
    };
    const found: string[] = [];
    for (const f of sources()) {
      const r = rel(f);
      if (PLANE.test(r)) continue;
      for (const m of code(f).matchAll(IMPORT)) {
        const spec = m[1] ?? m[2];
        if (!ALLOWED[r]?.test(spec)) found.push(`${r} -> ${spec}`);
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
