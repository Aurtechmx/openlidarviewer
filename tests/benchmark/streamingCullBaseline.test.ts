/**
 * streamingCullBaseline.test.ts — the renderer baseline for streamed-node
 * culling, over a fixed set of cameras.
 *
 * What this can measure in Node is the geometry: how many resident nodes a
 * camera actually contains. That is the quantity the change is about, and it is
 * deterministic, so it belongs in a committed baseline.
 *
 * What it cannot measure is GPU frame time. This runtime has no renderer and no
 * device, and the repository's rule for that case is explicit: a missing
 * measurement is unavailable with a reason, never zero. A harness that wrote 0
 * would assert a perfect result.
 *
 * The cameras are stored rather than generated so a later comparison is against
 * the same views.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  cullResidentNodes,
  type Box6,
  type FrustumPlanes,
  type CullableNode,
} from '../../src/render/streaming/nodeFrustumCulling';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = 'docs/validation/streaming-cull-baseline.json';

const plane = (a: number, b: number, c: number, d: number) => ({ a, b, c, d });

/** A symmetric view box, as six inward planes. */
function viewBox(halfX: number, halfY: number, nearZ: number, farZ: number): FrustumPlanes {
  return [
    plane(1, 0, 0, halfX),
    plane(-1, 0, 0, halfX),
    plane(0, 1, 0, halfY),
    plane(0, -1, 0, halfY),
    plane(0, 0, -1, -nearZ),
    plane(0, 0, 1, farZ),
  ];
}

/**
 * A deterministic octree-ish spread of nodes over a 400 x 400 m tile, at three
 * depths. Stands in for a streamed scene without needing one on disk.
 */
function scene(): CullableNode[] {
  const nodes: CullableNode[] = [];
  for (const [depth, step] of [[0, 200], [1, 100], [2, 50]] as const) {
    for (let x = -200; x < 200; x += step) {
      for (let y = -200; y < 200; y += step) {
        // Depth range sits in front of the cameras below, between their near
        // and far planes, so a view that contains a tile actually draws it.
        const b: Box6 = [x, y, -140, x + step, y + step, -100];
        nodes.push({ key: `d${depth}-${x}-${y}`, bounds: b });
      }
    }
  }
  return nodes;
}

/** The stored cameras. Each is a named view over the same scene. */
const CAMERAS = [
  { id: 'overview', planes: viewBox(400, 400, 60, 400), note: 'whole tile in view' },
  { id: 'half-tile', planes: viewBox(100, 400, 60, 400), note: 'panned so half the tile is off-screen' },
  { id: 'corner', planes: viewBox(60, 60, 60, 400), note: 'zoomed into one corner' },
  { id: 'narrow-far', planes: viewBox(40, 40, 60, 120), note: 'narrow view with a short far plane' },
] as const;

describe('streamed-node culling baseline', () => {
  it('records how many resident nodes each stored camera contains', () => {
    const nodes = scene();
    const cases = CAMERAS.map((c) => {
      const d = cullResidentNodes(nodes, c.planes);
      return {
        camera: c.id,
        note: c.note,
        residentNodes: nodes.length,
        drawnNodes: d.drawn.length,
        residentNotDrawn: d.residentNotDrawn.length,
        drawnFraction: Number((d.drawn.length / nodes.length).toFixed(4)),
      };
    });

    // Every node is accounted for in every case.
    for (const c of cases) {
      expect(c.drawnNodes + c.residentNotDrawn).toBe(c.residentNodes);
    }
    // The stored cameras have to discriminate in BOTH directions, or the
    // baseline records nothing. An all-kept set proves no view contains the
    // scene, which is a broken fixture rather than perfect culling, and an
    // all-drawn set proves no camera excludes anything.
    expect(cases.some((c) => c.residentNotDrawn > 0)).toBe(true);
    expect(cases.some((c) => c.drawnNodes > 0)).toBe(true);
    // The widest stored view contains the whole scene.
    const overview = cases.find((c) => c.camera === 'overview');
    expect(overview?.residentNotDrawn).toBe(0);
    // The tightest excludes most of it.
    const corner = cases.find((c) => c.camera === 'corner');
    expect(corner?.drawnNodes).toBeLessThan(overview!.drawnNodes);

    let revision = 'unknown';
    try {
      revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
        .toString()
        .trim();
    } catch {
      /* a tree without git still runs the assertions above */
    }

    const record = {
      schemaVersion: 1,
      label: 'streaming-cull-baseline',
      revision,
      environment: {
        runtime: 'node',
        os: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        browser: null,
        backend: 'none',
      },
      workload: {
        sceneId: 'synthetic-octree-400m',
        nodeCount: nodes.length,
        depths: 3,
        cameras: CAMERAS.length,
      },
      cases,
      gpuFrameTimeMs: {
        status: 'unavailable',
        reason:
          'no renderer or GPU in this runtime; frame time is captured on a real device and must not be recorded as zero',
      },
      submittedPointCount: {
        status: 'unavailable',
        reason: 'point counts per node depend on a decoded source; this baseline measures node geometry only',
      },
      // What the case figures do and do not support. Written into the record
      // because a fraction of NODES reads like a fraction of work, and it is
      // not the same quantity.
      interpretation: {
        measures: 'the share of resident nodes a stored view contains, by bounds alone',
        doesNotMeasure: [
          'GPU time saved: a node costs what its points cost, and these nodes carry no point counts, so a node share is not a work share',
          'a real resident set: the scene is three uniform grids over one area, all resident at once, where a scheduler would hold a level-of-detail selection instead, so the drawn share here is likely lower than a real one',
          'perspective behaviour: the stored views are axis-aligned boxes, which is an orthographic camera; a perspective frustum has slanted side planes and would contain a different set',
        ],
      },
    };

    const abs = resolve(ROOT, OUT);
    const previous = existsSync(abs) ? JSON.parse(readFileSync(abs, 'utf8')) : null;
    // Rewrite when anything but the revision differs, so a rerun does not churn
    // the file with a new commit alone. Comparing only the measured cases was
    // too narrow: it meant a correction to what the record SAYS about those
    // figures could never be written, because the figures themselves had not
    // moved.
    const withoutRevision = (r: Record<string, unknown> | null): string =>
      r === null ? '' : JSON.stringify({ ...r, revision: null });
    if (withoutRevision(previous) !== withoutRevision(record as unknown as Record<string, unknown>)) {
      writeFileSync(abs, `${JSON.stringify(record, null, 2)}\n`);
    }

    expect(record.cases.length).toBe(CAMERAS.length);
  });

  it('states what a node share does not measure', () => {
    const rec = JSON.parse(readFileSync(resolve(ROOT, OUT), 'utf8'));
    // A reader who takes the drawn fraction for a GPU saving has been misled by
    // the record rather than by their own inference, so the record says so.
    expect(rec.interpretation.doesNotMeasure.join(' ')).toContain('not a work share');
    expect(rec.interpretation.doesNotMeasure.join(' ')).toContain('orthographic');
  });

  it('never reports a GPU measurement this runtime cannot take', () => {
    const abs = resolve(ROOT, OUT);
    const rec = JSON.parse(readFileSync(abs, 'utf8'));
    expect(rec.gpuFrameTimeMs.status).toBe('unavailable');
    expect(rec.gpuFrameTimeMs.reason).toContain('real device');
    expect(rec.gpuFrameTimeMs.ms).toBeUndefined();
  });
});
