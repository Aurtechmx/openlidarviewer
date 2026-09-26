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
import { writeFileSync, readFileSync } from 'node:fs';
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

/**
 * The stored cameras, as parameters rather than as planes.
 *
 * The record published beside the results carries these numbers, so a reader
 * can rebuild a view from the artifact instead of from this file. A baseline
 * that names a camera it does not define cannot be reproduced by anyone who
 * only has the baseline, which is the thing a stored corpus is for.
 *
 * One definition drives both: the planes below are derived from these, so the
 * published parameters cannot describe a different view from the one measured.
 */
const CAMERAS = [
  { id: 'overview', halfX: 400, halfY: 400, nearZ: 60, farZ: 400, note: 'whole tile in view' },
  { id: 'half-tile', halfX: 100, halfY: 400, nearZ: 60, farZ: 400, note: 'panned so half the tile is off-screen' },
  { id: 'corner', halfX: 60, halfY: 60, nearZ: 60, farZ: 400, note: 'zoomed into one corner' },
  { id: 'narrow-far', halfX: 40, halfY: 40, nearZ: 60, farZ: 120, note: 'narrow view with a short far plane' },
] as const;

describe('streamed-node culling baseline', () => {
  it('records how many resident nodes each stored camera contains', () => {
    const nodes = scene();
    const cases = CAMERAS.map((c) => {
      const d = cullResidentNodes(nodes, viewBox(c.halfX, c.halfY, c.nearZ, c.farZ));
      return {
        camera: c.id,
        note: c.note,
        // Published so the view can be rebuilt from the record alone.
        definition: {
          projection: 'orthographic',
          halfExtentX: c.halfX,
          halfExtentY: c.halfY,
          nearZ: c.nearZ,
          farZ: c.farZ,
        },
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
    // Read straight through rather than asking whether the file exists first.
    // A check followed by a read is two answers about one file and they can
    // disagree, so absence is taken from the read itself. Only a missing file
    // counts as no previous record: a corrupt or unreadable one throws, because
    // silently overwriting a baseline the gate compares against would hide the
    // very difference the record exists to show.
    const previous = ((): Record<string, unknown> | null => {
      try {
        return JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    })();
    // Rewrite when anything but the revision differs, so a rerun does not churn
    // the file with a new commit alone. Comparing only the measured cases was
    // too narrow: it meant a correction to what the record SAYS about those
    // figures could never be written, because the figures themselves had not
    // moved.
    const withoutRevision = (r: Record<string, unknown> | null): string =>
      r === null ? '' : JSON.stringify({ ...r, revision: null });
    // The record is tracked, so a plain test run never writes it. Refresh it
    // with OLV_UPDATE_BASELINE=1.
    if (
      process.env.OLV_UPDATE_BASELINE === '1' &&
      withoutRevision(previous) !== withoutRevision(record as unknown as Record<string, unknown>)
    ) {
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
