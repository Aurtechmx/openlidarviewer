/**
 * workbenchPointLink.test.ts
 *
 * The link between a return drawn in the Profile Workbench and the same return
 * in the 3D scene.
 *
 * Node environment with a per-test recording DOM stub — the convention the
 * workbench suites already use, and the reason the presenter can be driven for
 * real here rather than through a double. No jsdom, no `window`.
 *
 * Each block pins one property the feature is only worth having if it holds:
 *
 *   - a return is followed by its recorded IDENTITY (slot, source kind, source
 *     id, that source's own point index) and never by matching coordinates,
 *     because a corridor's returns sit within centimetres of each other;
 *   - a hover never moves the camera, and the only path to the camera is the
 *     deliberate gesture on a CLICKED selection;
 *   - profile selection and Inspect selection are separate states, so nothing
 *     on this path reaches the inspector at all;
 *   - a streaming node evicted after the snapshot leaves the 2D figures intact
 *     and reports the 3D link as gone, rather than marking a point that is no
 *     longer resident;
 *   - a burst of raw pointer moves inside one frame costs exactly one
 *     hit-test, one readout and one presentation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  focusPoseOnPoint,
  locateProfileReturn,
  profileDetailSources,
  profileHoverReadout,
  profileLinkStatusText,
  profileMarkerSegments,
  profileMarkerSize,
  profileReturnIdentity,
} from '../src/render/measure/profilePointLink';
import { drawProfileLinkOverlay, MARK_HALF_PX } from '../src/render/measure/profileLinkOverlay2d';
import { createProfileLinkController } from '../src/app/profileLinkController';
import {
  attachSectionPointLink,
  prepareWorkbenchSection,
  HIT_RADIUS_PX,
  LINK_ROW_LABEL,
} from '../src/app/profileWorkbenchSection';
import { createProfileSectionSeam } from '../src/render/measure/profileSectionSeam';
import { profileDataToScreen } from '../src/render/measure/profileViewTransform';

import type { ProfileSectionPoints } from '../src/render/measure/profileSectionBuilder';
import type {
  ProfileReturnLocation,
  ProfileReturnRef,
  ProfileSectionResult,
  ProfileSectionSourceRef,
} from '../src/render/measure/profileSectionSeam';
import type { ProfileReturnIdentity } from '../src/render/measure/profilePointLink';
import type { WorkbenchSectionScene } from '../src/app/profileWorkbenchSection';
import type { ProfileWorkbenchDetailRow } from '../src/ui/ProfileWorkbench';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Recording DOM stub
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  op: string;
  args: number[];
}

/** A 2D context that records every call the overlay makes. */
class RecordingContext {
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  lineWidth = 0;
  globalAlpha = 1;
  readonly ops: Recorded[] = [];
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ops.push({ op: 'setTransform', args: [a, b, c, d, e, f] });
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'clearRect', args: [x, y, w, h] });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'fillRect', args: [x, y, w, h] });
  }
  beginPath(): void {
    this.ops.push({ op: 'beginPath', args: [] });
  }
  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'moveTo', args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ op: 'lineTo', args: [x, y] });
  }
  closePath(): void {
    this.ops.push({ op: 'closePath', args: [] });
  }
  stroke(): void {
    this.ops.push({ op: 'stroke', args: [] });
  }
  count(op: string): number {
    return this.ops.filter((o) => o.op === op).length;
  }
}

/** A canvas that records its listeners, so a test can dispatch to them. */
class FakeCanvas {
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  readonly ctx = new RecordingContext();
  readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  constructor(width = 0, height = 0) {
    this.clientWidth = width;
    this.clientHeight = height;
  }
  getContext(): RecordingContext {
    return this.ctx;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  fire(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  bound(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: () => ({}),
    createElementNS: () => ({}),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_ID = 'scan-a';
const NODE_KEY = '3-2-1-0';

/**
 * Five returns over two sources, one static and one streaming.
 *
 * The source point indices are deliberately NOT the section indices and are
 * deliberately not ordered: a route that lost the recorded index and fell back
 * to the section index, or to the nearest neighbour, produces different numbers
 * on every one of them.
 */
const SOURCE_INDICES = [41, 7, 900, 3, 12];
const SLOTS = [0, 1, 0, 1, 0];

function fixtureSection(): ProfileSectionResult {
  const count = SOURCE_INDICES.length;
  const chainage = new Float32Array(count);
  const height = new Float64Array(count);
  const lateralOffset = new Float32Array(count);
  const sourceSlot = new Uint16Array(count);
  const pointIndex = new Uint32Array(count);
  const classification = new Uint8Array(count);
  const channelPresence = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    chainage[i] = i * 5;
    height[i] = 100 + i;
    lateralOffset[i] = i % 2 === 0 ? 0.25 : -0.25;
    sourceSlot[i] = SLOTS[i]!;
    pointIndex[i] = SOURCE_INDICES[i]!;
    classification[i] = 2;
    // classification bit set on every point of this fixture
    channelPresence[i] = 1 << 2;
  }
  const points: ProfileSectionPoints = {
    count,
    chainage,
    height,
    lateralOffset,
    sourceSlot,
    pointIndex,
    channelPresence,
    classification,
  };
  const sources: ProfileSectionSourceRef[] = [
    { slot: 0, kind: 'static', id: STATIC_ID, pointCount: 1000 },
    { slot: 1, kind: 'resident', id: NODE_KEY, pointCount: 500 },
  ];
  return {
    points,
    frame: null as never,
    band: 2,
    scope: 'mixed' as never,
    scopeLabel: 'One layer and the streaming source.',
    classificationOnEverySource: true,
    streamingComplete: true,
    sources,
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
  };
}

/** A locator that answers from a table keyed by the recorded identity. */
function tableLocator(
  table: Map<string, [number, number, number]>,
  evicted: Set<string> = new Set(),
): {
  locate: (ref: ProfileReturnRef, out: Float64Array) => ProfileReturnLocation;
  calls: ProfileReturnRef[];
} {
  const calls: ProfileReturnRef[] = [];
  return {
    calls,
    locate: (ref, out) => {
      calls.push({ kind: ref.kind, id: ref.id, pointIndex: ref.pointIndex });
      if (evicted.has(ref.id)) return 'evicted';
      const hit = table.get(`${ref.kind}:${ref.id}:${ref.pointIndex}`);
      if (!hit) return 'unavailable';
      out[0] = hit[0];
      out[1] = hit[1];
      out[2] = hit[2];
      return 'linked';
    },
  };
}

/**
 * Positions for every fixture return, placed a CENTIMETRE apart.
 *
 * That spacing is the point: a route that searched the scene for the nearest
 * coordinate would have a field of near-coincident candidates to choose wrongly
 * from, exactly as it would in a real corridor.
 */
function fixtureTable(): Map<string, [number, number, number]> {
  const table = new Map<string, [number, number, number]>();
  for (let i = 0; i < SOURCE_INDICES.length; i++) {
    const kind = SLOTS[i] === 0 ? 'static' : 'resident';
    const id = SLOTS[i] === 0 ? STATIC_ID : NODE_KEY;
    table.set(`${kind}:${id}:${SOURCE_INDICES[i]!}`, [10 + i * 0.01, 20, 30 + i * 0.01]);
  }
  return table;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity routing
// ─────────────────────────────────────────────────────────────────────────────

describe('a return is routed by the identity the section recorded', () => {
  it('reads slot, source kind, source id and the SOURCE point index', () => {
    const section = fixtureSection();
    for (let i = 0; i < section.points.count; i++) {
      const identity = profileReturnIdentity(section.points, section.sources, i);
      expect(identity, `return ${i}`).not.toBeNull();
      expect(identity!.sectionIndex).toBe(i);
      expect(identity!.slot).toBe(SLOTS[i]);
      expect(identity!.kind).toBe(SLOTS[i] === 0 ? 'static' : 'resident');
      expect(identity!.sourceId).toBe(SLOTS[i] === 0 ? STATIC_ID : NODE_KEY);
      // The recorded index, not the section index and not a neighbour's.
      expect(identity!.pointIndex).toBe(SOURCE_INDICES[i]);
    }
  });

  it('refuses a slot no source ref names rather than guessing a layer', () => {
    const section = fixtureSection();
    section.points.sourceSlot[2] = 9;
    expect(profileReturnIdentity(section.points, section.sources, 2)).toBeNull();
  });

  it('refuses an index outside the section', () => {
    const section = fixtureSection();
    expect(profileReturnIdentity(section.points, section.sources, -1)).toBeNull();
    expect(profileReturnIdentity(section.points, section.sources, 5)).toBeNull();
    expect(profileReturnIdentity(section.points, section.sources, 1.5)).toBeNull();
  });

  it('asks the scene for exactly that identity, never for a nearby position', () => {
    const section = fixtureSection();
    const { locate, calls } = tableLocator(fixtureTable());
    const identity = profileReturnIdentity(section.points, section.sources, 3)!;
    const link = locateProfileReturn(identity, (id, out) =>
      locate({ kind: id.kind, id: id.sourceId, pointIndex: id.pointIndex }, out),
    );
    expect(calls).toEqual([{ kind: 'resident', id: NODE_KEY, pointIndex: 3 }]);
    expect(link.state).toBe('linked');
    // The table's entry for THAT identity, not for either neighbour a
    // centimetre away.
    expect(link.position).toEqual([10.03, 20, 30.03]);
  });

  it('downgrades a non-finite coordinate rather than marking NaN', () => {
    const identity: ProfileReturnIdentity = {
      sectionIndex: 0,
      slot: 0,
      kind: 'static',
      sourceId: STATIC_ID,
      pointIndex: 41,
    };
    const link = locateProfileReturn(identity, (_id, out) => {
      out[0] = Number.NaN;
      out[1] = 0;
      out[2] = 0;
      return 'linked';
    });
    expect(link.state).toBe('unavailable');
    expect(link.position).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seam's own resolution
// ─────────────────────────────────────────────────────────────────────────────

function seamWith(options: {
  layerPositions?: Float32Array | null;
  placement?: { sourceToProject: readonly [number, number, number] } | null;
  visible?: boolean;
  nodes?: { key: string; positions: Float32Array | null }[];
}): ReturnType<typeof createProfileSectionSeam> {
  return createProfileSectionSeam({
    layers: () => [
      {
        mesh: { visible: options.visible ?? true },
        id: STATIC_ID,
        positions: options.layerPositions ?? new Float32Array([1, 2, 3, 4, 5, 6]),
        channels: null,
        bounds: null,
        placement: (options.placement ?? null) as never,
      },
    ],
    residentNodes: () =>
      (options.nodes ?? [{ key: NODE_KEY, positions: new Float32Array([7, 8, 9, 10, 11, 12]) }]).map(
        (n) => ({ key: n.key, positions: n.positions, channels: null }),
      ),
    streamingMayCombine: () => true,
    worldUp: () => [0, 0, 1],
    streamingCoverage: () => null,
  });
}

describe('the seam resolves a recorded return against the scene as it is now', () => {
  it('reads a static layer at its own index, with the placement folded once', () => {
    const seam = seamWith({ placement: { sourceToProject: [100, 200, 300] } });
    const out = new Float64Array(3);
    expect(seam.locateReturn({ kind: 'static', id: STATIC_ID, pointIndex: 1 }, out)).toBe('linked');
    expect([...out]).toEqual([104, 205, 306]);
  });

  it('reads a resident node at its own index', () => {
    const seam = seamWith({});
    const out = new Float64Array(3);
    expect(seam.locateReturn({ kind: 'resident', id: NODE_KEY, pointIndex: 0 }, out)).toBe('linked');
    expect([...out]).toEqual([7, 8, 9]);
  });

  it('reports a node that is no longer resident as EVICTED, never as linked', () => {
    const seam = seamWith({ nodes: [{ key: 'other-node', positions: new Float32Array([0, 0, 0]) }] });
    const out = new Float64Array(3);
    expect(seam.locateReturn({ kind: 'resident', id: NODE_KEY, pointIndex: 0 }, out)).toBe('evicted');
  });

  it('reports a resident node with no coordinate at that index as unavailable', () => {
    const seam = seamWith({});
    const out = new Float64Array(3);
    expect(seam.locateReturn({ kind: 'resident', id: NODE_KEY, pointIndex: 99 }, out)).toBe(
      'unavailable',
    );
  });

  it('reports a hidden static layer as unavailable rather than marking it', () => {
    const seam = seamWith({ visible: false });
    const out = new Float64Array(3);
    expect(seam.locateReturn({ kind: 'static', id: STATIC_ID, pointIndex: 0 }, out)).toBe(
      'unavailable',
    );
  });

  it('reports a layer id nothing carries as unavailable', () => {
    const seam = seamWith({});
    const out = new Float64Array(3);
    expect(seam.locateReturn({ kind: 'static', id: 'gone', pointIndex: 0 }, out)).toBe(
      'unavailable',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The controller
// ─────────────────────────────────────────────────────────────────────────────

interface ControllerRig {
  controller: ReturnType<typeof createProfileLinkController>;
  frames: (() => void)[];
  runFrame(): void;
  paints: ({ hover: unknown; locked: unknown })[];
  marks: (null | { position: readonly [number, number, number]; mode: string })[];
  presents: { hover: unknown; locked: unknown; detail: unknown }[];
  focuses: readonly (readonly [number, number, number])[];
  locateCalls: ProfileReturnRef[];
  detailCalls: number[];
  readoutCalls: number[];
  evict(): void;
}

/**
 * A controller over the fixture section.
 *
 * `query` maps a pixel to a section index by a fixed table, so the test drives
 * hit results directly rather than reconstructing the plot's geometry; the
 * geometry itself is exercised end to end further down.
 */
function controllerRig(options: { withFocus?: boolean } = {}): ControllerRig {
  const section = fixtureSection();
  const table = fixtureTable();
  const evicted = new Set<string>();
  const { locate, calls } = tableLocator(table, evicted);
  const frames: (() => void)[] = [];
  const paints: ({ hover: unknown; locked: unknown })[] = [];
  const marks: (null | { position: readonly [number, number, number]; mode: string })[] = [];
  const presents: { hover: unknown; locked: unknown; detail: unknown }[] = [];
  const focuses: (readonly [number, number, number])[] = [];
  const detailCalls: number[] = [];
  const readoutCalls: number[] = [];

  const controller = createProfileLinkController({
    // x is the section index times ten; anything else misses.
    query: (x) => {
      const i = Math.round(x / 10);
      return i >= 0 && i < section.points.count ? i : null;
    },
    project: (i, out) => {
      out[0] = i * 10;
      out[1] = 50;
      return true;
    },
    identify: (i) => profileReturnIdentity(section.points, section.sources, i),
    locate: (identity, out) =>
      locate({ kind: identity.kind, id: identity.sourceId, pointIndex: identity.pointIndex }, out),
    readout: (i) => {
      readoutCalls.push(i);
      return profileHoverReadout(section.points, i);
    },
    detail: (i) => {
      detailCalls.push(i);
      return { index: i, coordinateHeading: 'World', verticalReference: 'unknown', verticalNote: '', rows: [] };
    },
    schedule: (run) => {
      frames.push(run);
    },
    paint: (hover, locked) => {
      paints.push({ hover, locked });
    },
    mark: (marker) => {
      marks.push(marker);
    },
    present: (state) => {
      presents.push({ hover: state.hover, locked: state.locked, detail: state.detail });
    },
    ...(options.withFocus
      ? {
          focus: (position: readonly [number, number, number]): void => {
            focuses.push(position);
          },
        }
      : {}),
  });

  return {
    controller,
    frames,
    runFrame: () => {
      const next = frames.shift();
      next?.();
    },
    paints,
    marks,
    presents,
    focuses,
    locateCalls: calls,
    detailCalls,
    readoutCalls,
    evict: () => evicted.add(NODE_KEY),
  };
}

describe('hover', () => {
  it('coalesces a burst of raw moves into ONE hit-test and one presentation', () => {
    const rig = controllerRig();
    for (let n = 0; n < 50; n++) rig.controller.pointerMove(20 + n * 0.01, 50);
    // Nothing has happened yet: a raw move records and asks for a frame.
    expect(rig.controller.stats().hitTests).toBe(0);
    expect(rig.readoutCalls).toHaveLength(0);
    expect(rig.presents).toHaveLength(0);
    expect(rig.frames).toHaveLength(1);

    rig.runFrame();
    const stats = rig.controller.stats();
    expect(stats.pointerEvents).toBe(50);
    expect(stats.flushes).toBe(1);
    expect(stats.hitTests).toBe(1);
    expect(rig.readoutCalls).toEqual([2]);
    expect(rig.presents).toHaveLength(1);
    expect(rig.paints).toHaveLength(1);
  });

  it('presents nothing at all when a later frame resolves to the same return', () => {
    const rig = controllerRig();
    rig.controller.pointerMove(20, 50);
    rig.runFrame();
    expect(rig.presents).toHaveLength(1);
    rig.controller.pointerMove(21, 50);
    rig.runFrame();
    expect(rig.controller.stats().hitTests).toBe(2);
    expect(rig.presents).toHaveLength(1);
  });

  it('marks the hovered return in 3D, at the position its identity resolved to', () => {
    const rig = controllerRig();
    rig.controller.pointerMove(30, 50);
    rig.runFrame();
    expect(rig.marks).toEqual([{ position: [10.03, 20, 30.03], mode: 'hover' }]);
    expect(rig.locateCalls).toEqual([{ kind: 'resident', id: NODE_KEY, pointIndex: 3 }]);
  });

  it('NEVER moves the camera', () => {
    const rig = controllerRig({ withFocus: true });
    for (let i = 0; i < 5; i++) {
      rig.controller.pointerMove(i * 10, 50);
      rig.runFrame();
    }
    rig.controller.pointerLeave();
    rig.runFrame();
    expect(rig.focuses).toEqual([]);
    expect(rig.controller.stats().focuses).toBe(0);
  });

  it('does not build the detail card', () => {
    const rig = controllerRig();
    rig.controller.pointerMove(10, 50);
    rig.runFrame();
    expect(rig.detailCalls).toEqual([]);
    expect(rig.presents.at(-1)!.detail).toBeNull();
  });

  it('clears on leave', () => {
    const rig = controllerRig();
    rig.controller.pointerMove(10, 50);
    rig.runFrame();
    rig.controller.pointerLeave();
    rig.runFrame();
    expect(rig.marks.at(-1)).toBeNull();
    expect(rig.paints.at(-1)).toEqual({ hover: null, locked: null });
  });
});

describe('click', () => {
  it('locks the selection and builds the card, without waiting for a frame', () => {
    const rig = controllerRig();
    rig.controller.click(10, 50);
    expect(rig.detailCalls).toEqual([1]);
    const locked = rig.controller.selection()!;
    expect(locked.identity.pointIndex).toBe(SOURCE_INDICES[1]);
    expect(locked.identity.kind).toBe('resident');
    expect(rig.presents.at(-1)!.detail).not.toBeNull();
  });

  it('does not move the camera on its own', () => {
    const rig = controllerRig({ withFocus: true });
    rig.controller.click(10, 50);
    expect(rig.focuses).toEqual([]);
  });

  it('marks the LOCKED return even while the pointer moves over others', () => {
    const rig = controllerRig();
    rig.controller.click(10, 50);
    rig.controller.pointerMove(40, 50);
    rig.runFrame();
    expect(rig.marks.at(-1)).toEqual({ position: [10.01, 20, 30.01], mode: 'locked' });
  });

  it('clears the lock when it misses every return', () => {
    const rig = controllerRig();
    rig.controller.click(10, 50);
    rig.controller.click(9999, 50);
    expect(rig.controller.selection()).toBeNull();
    expect(rig.presents.at(-1)!.detail).toBeNull();
  });
});

describe('the deliberate focus action', () => {
  it('moves the camera only for a locked selection with a live source', () => {
    const rig = controllerRig({ withFocus: true });
    expect(rig.controller.focusSelection()).toBe(false);
    rig.controller.click(10, 50);
    expect(rig.controller.focusSelection()).toBe(true);
    expect(rig.focuses).toEqual([[10.01, 20, 30.01]]);
  });

  it('refuses when the locked return has lost its source', () => {
    const rig = controllerRig({ withFocus: true });
    rig.controller.click(10, 50);
    rig.evict();
    rig.controller.refresh();
    expect(rig.controller.focusSelection()).toBe(false);
    expect(rig.focuses).toEqual([]);
  });

  it('refuses when the host supplied no camera', () => {
    const rig = controllerRig();
    rig.controller.click(10, 50);
    expect(rig.controller.focusSelection()).toBe(false);
  });

  it('composes a pose that keeps the viewing direction and distance', () => {
    const next = focusPoseOnPoint({ position: [0, 0, 10], target: [0, 0, 0] }, [5, 5, 5]);
    expect(next.target).toEqual([5, 5, 5]);
    expect(next.position).toEqual([5, 5, 15]);
  });
});

describe('a source lost after the snapshot', () => {
  it('keeps the 2D selection and reports the 3D link as evicted', () => {
    const rig = controllerRig();
    rig.controller.click(10, 50);
    const before = rig.controller.selection()!;
    expect(before.state).toBe('linked');

    rig.evict();
    rig.controller.pointerMove(0, 50);
    rig.runFrame();

    const after = rig.controller.selection()!;
    // Still selected, still the same return, still carrying its 2D figures.
    expect(after).not.toBeNull();
    expect(after.identity).toEqual(before.identity);
    expect(after.readout).toBe(before.readout);
    // And no longer claimed to be marked.
    expect(after.state).toBe('evicted');
    expect(after.position).toBeNull();
    expect(rig.marks.at(-1)).toBeNull();
  });

  it('never reports an evicted node as linked, however often it is re-read', () => {
    const rig = controllerRig();
    rig.controller.click(10, 50);
    rig.evict();
    for (let n = 0; n < 5; n++) rig.controller.refresh();
    expect(rig.controller.selection()!.state).toBe('evicted');
    expect(rig.marks.filter((m) => m !== null).every((m) => m!.mode === 'locked')).toBe(true);
    expect(rig.marks.at(-1)).toBeNull();
  });

  it('has wording for every state', () => {
    expect(profileLinkStatusText('linked')).toBe('marked in 3D');
    expect(profileLinkStatusText('evicted')).toBe('source node evicted');
    expect(profileLinkStatusText('unavailable')).toBe('source unavailable');
  });
});

describe('dispose', () => {
  it('clears both marks and stops responding', () => {
    const rig = controllerRig();
    rig.controller.click(10, 50);
    rig.controller.dispose();
    expect(rig.marks.at(-1)).toBeNull();
    expect(rig.paints.at(-1)).toEqual({ hover: null, locked: null });
    const presents = rig.presents.length;
    rig.controller.pointerMove(10, 50);
    expect(rig.presents).toHaveLength(presents);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile selection and Inspect selection are separate states
// ─────────────────────────────────────────────────────────────────────────────

/** The inspector's own surface, named the way the tool names it. */
const INSPECTOR_REFERENCES = /Inspect|inspectMode|showPoint/;

describe('the profile link never touches the inspector', () => {
  const path = [
    'src/render/measure/profilePointLink.ts',
    'src/render/measure/profileLinkOverlay2d.ts',
    'src/render/ProfileLinkOverlay.ts',
    'src/app/profileLinkController.ts',
    'src/app/profileWorkbenchSection.ts',
    'src/app/profileWorkbenchRuntime.ts',
  ];

  for (const rel of path) {
    it(`${rel} names no part of the inspector's selection`, () => {
      const source = readSource(rel);
      // The doc comment in ProfileLinkOverlay explains the separation, so the
      // check is on CODE: strip block comments before matching.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(INSPECTOR_REFERENCES.test(code), `${rel} reaches the inspector`).toBe(false);
    });
  }

  it('reads only the seam members it declares, over a full hover-click-focus cycle', () => {
    const touched = new Set<string>();
    const rig = endToEnd({ watch: touched });
    const p = rig.pixelOf(2);
    rig.canvas.fire('pointermove', { offsetX: p.x, offsetY: p.y });
    rig.frames.shift()!();
    rig.canvas.fire('click', { offsetX: p.x, offsetY: p.y });
    rig.canvas.fire('dblclick', { offsetX: p.x, offsetY: p.y });
    rig.canvas.fire('pointerleave', {});
    rig.frames.shift()!();
    // The whole surface the link is allowed to reach. An inspector-driving
    // mutation has to add a member here, and adding one fails this.
    expect([...touched].sort()).toEqual(
      [
        'crs',
        'focusPoint',
        'locateReturn',
        'markLinkedReturn',
        'observePointer',
        'schedulePointerFlush',
      ].sort(),
    );
    for (const name of touched) expect(INSPECTOR_REFERENCES.test(name)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The 2D overlay
// ─────────────────────────────────────────────────────────────────────────────

describe('the 2D crosshair', () => {
  it('clears the surface even with nothing to draw', () => {
    const ctx = new RecordingContext();
    drawProfileLinkOverlay(ctx, {
      widthPx: 200,
      heightPx: 100,
      devicePixelRatio: 2,
      hover: null,
      locked: null,
    });
    expect(ctx.count('clearRect')).toBe(1);
    expect(ctx.count('stroke')).toBe(0);
    expect(ctx.ops[0]).toEqual({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
  });

  it('draws a full-width and full-height rule through the hover, and a box', () => {
    const ctx = new RecordingContext();
    drawProfileLinkOverlay(ctx, {
      widthPx: 200,
      heightPx: 100,
      devicePixelRatio: 1,
      hover: { x: 40, y: 60 },
      locked: null,
    });
    const moves = ctx.ops.filter((o) => o.op === 'moveTo').map((o) => o.args);
    expect(moves).toContainEqual([0, 60]);
    expect(moves).toContainEqual([40, 0]);
    const lines = ctx.ops.filter((o) => o.op === 'lineTo').map((o) => o.args);
    expect(lines).toContainEqual([200, 60]);
    expect(lines).toContainEqual([40, 100]);
    expect(lines).toContainEqual([40 + MARK_HALF_PX, 60 - MARK_HALF_PX]);
  });

  it('draws the locked box last, so it reads over a passing hover', () => {
    const ctx = new RecordingContext();
    drawProfileLinkOverlay(ctx, {
      widthPx: 200,
      heightPx: 100,
      devicePixelRatio: 1,
      hover: { x: 40, y: 60 },
      locked: { x: 90, y: 20 },
    });
    const lastPath = ctx.ops.map((o) => o.args).filter((a) => a.length === 2);
    expect(lastPath.at(-1)).toEqual([90 - MARK_HALF_PX, 20 + MARK_HALF_PX]);
  });

  it('skips a non-finite mark rather than stroking to NaN', () => {
    const ctx = new RecordingContext();
    drawProfileLinkOverlay(ctx, {
      widthPx: 200,
      heightPx: 100,
      devicePixelRatio: 1,
      hover: { x: Number.NaN, y: 60 },
      locked: null,
    });
    expect(ctx.count('stroke')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The 3D marker geometry
// ─────────────────────────────────────────────────────────────────────────────

describe('the 3D mark', () => {
  it('is sized from the corridor, so it reads at the section\'s own scale', () => {
    expect(profileMarkerSize(2)).toBeCloseTo(0.7, 12);
    expect(profileMarkerSize(20)).toBeCloseTo(7, 12);
    expect(profileMarkerSize(0)).toBe(1);
    expect(profileMarkerSize(Number.NaN)).toBe(1);
  });

  it('is a three-axis cross centred on the point', () => {
    const v = profileMarkerSegments([1, 2, 3], 0.5);
    expect([...v.subarray(0, 6)]).toEqual([0.5, 2, 3, 1.5, 2, 3]);
    expect([...v.subarray(6, 12)]).toEqual([1, 1.5, 3, 1, 2.5, 3]);
    expect([...v.subarray(12, 18)]).toEqual([1, 2, 2.5, 1, 2, 3.5]);
  });

  it('writes into the buffer it is given, so a move allocates nothing', () => {
    const buffer = new Float32Array(18);
    expect(profileMarkerSegments([0, 0, 0], 1, buffer)).toBe(buffer);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The readout and the card
// ─────────────────────────────────────────────────────────────────────────────

describe('the hover readout', () => {
  it('leads with chainage when no scale reaches metres', () => {
    const section = fixtureSection();
    const text = profileHoverReadout(section.points, 2);
    expect(text).toContain('Chainage 10.000');
    expect(text).not.toContain('Station');
  });

  it('leads with a station when the frame states a scale', () => {
    const section = fixtureSection();
    const text = profileHoverReadout(section.points, 2, { unitToMetres: 1 });
    expect(text).toContain('Station');
  });

  it('takes its height wording from the vertical reference, unchanged', () => {
    const section = fixtureSection();
    expect(profileHoverReadout(section.points, 0, { reference: 'orthometric' })).toContain(
      'Elevation 100.000',
    );
    expect(profileHoverReadout(section.points, 0, { reference: 'ellipsoidal' })).toContain(
      'Ellipsoidal height 100.000',
    );
    expect(profileHoverReadout(section.points, 0)).toContain('Height (datum unknown)');
  });

  it('quotes a class only where the point carries one', () => {
    const section = fixtureSection();
    expect(profileHoverReadout(section.points, 0)).toContain('2 (Ground)');
    section.points.channelPresence[0] = 0;
    expect(profileHoverReadout(section.points, 0)).not.toContain('Ground');
  });

  it('is empty for an index the section does not hold', () => {
    const section = fixtureSection();
    expect(profileHoverReadout(section.points, 99)).toBe('');
  });
});

describe('the card sources', () => {
  it('names a streaming slot by its node key and a static slot by its layer', () => {
    const section = fixtureSection();
    const built = profileDetailSources(section.sources);
    expect(built[0]!.layerId).toBe(STATIC_ID);
    expect(built[0]!.streamingNodeKey).toBeUndefined();
    expect(built[1]!.streamingNodeKey).toBe(NODE_KEY);
  });

  it('reads coordinates through the SAME locator the marker uses', () => {
    const section = fixtureSection();
    const { locate, calls } = tableLocator(fixtureTable());
    const built = profileDetailSources(section.sources, (identity, out) =>
      locate({ kind: identity.kind, id: identity.sourceId, pointIndex: identity.pointIndex }, out),
    );
    const out = new Float64Array(3);
    expect(built[1]!.readXYZ!(7, out)).toBe(true);
    expect(calls.at(-1)).toEqual({ kind: 'resident', id: NODE_KEY, pointIndex: 7 });
    expect([...out]).toEqual([10.01, 20, 30.01]);
  });

  it('declines an evicted node rather than answering with a stale position', () => {
    const section = fixtureSection();
    const { locate } = tableLocator(fixtureTable(), new Set([NODE_KEY]));
    const built = profileDetailSources(section.sources, (identity, out) =>
      locate({ kind: identity.kind, id: identity.sourceId, pointIndex: identity.pointIndex }, out),
    );
    expect(built[1]!.readXYZ!(7, new Float64Array(3))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end, over the real plot geometry
// ─────────────────────────────────────────────────────────────────────────────

interface EndToEndRig {
  link: NonNullable<ReturnType<typeof attachSectionPointLink>>;
  canvas: FakeCanvas;
  overlay: FakeCanvas;
  detail: (readonly ProfileWorkbenchDetailRow[] | null)[];
  readouts: (string | null)[];
  markers: unknown[];
  frames: (() => void)[];
  /** Plot pixel of section return `i`, from the placement the draw used. */
  pixelOf(i: number): { x: number; y: number };
}

function endToEnd(options: { evicted?: Set<string>; watch?: Set<string> } = {}): EndToEndRig {
  const section = fixtureSection();
  const canvas = new FakeCanvas(320, 160);
  const overlay = new FakeCanvas(320, 160);
  const detail: (readonly ProfileWorkbenchDetailRow[] | null)[] = [];
  const readouts: (string | null)[] = [];
  const markers: unknown[] = [];
  const frames: (() => void)[] = [];
  const { locate } = tableLocator(fixtureTable(), options.evicted ?? new Set());

  const plot = prepareWorkbenchSection({
    section,
    canvas: canvas as never,
    devicePixelRatio: 1,
  });

  const scene: WorkbenchSectionScene = {
    profile: () => null,
    sectionChunks: function* () {
      return null;
    },
    metresPerUnit: () => 1,
    devicePixelRatio: () => 1,
    locateReturn: (ref, out) => locate(ref, out),
    markLinkedReturn: (marker) => {
      markers.push(marker);
    },
    schedulePointerFlush: (run) => {
      frames.push(run);
    },
  };

  // Every read of a seam member is recorded, so a test can pin the whole
  // surface the link touches rather than only the calls it thought to spy on.
  const watched = options.watch
    ? (new Proxy(scene, {
        get(target, key: string): unknown {
          options.watch!.add(key);
          return Reflect.get(target, key) as unknown;
        },
      }) as WorkbenchSectionScene)
    : scene;

  const link = attachSectionPointLink({
    plot,
    section,
    handle: {
      canvas: canvas as never,
      overlay: overlay as never,
      setDetail: (rows) => detail.push(rows),
      setReadout: (text) => readouts.push(text),
    },
    scene: watched,
    unitToMetres: 1,
    devicePixelRatio: 1,
  })!;

  const frame = plot.frame()!;
  return {
    link,
    canvas,
    overlay,
    detail,
    readouts,
    markers,
    frames,
    pixelOf: (i) => {
      const out = new Float64Array(2);
      profileDataToScreen(
        frame.view,
        frame.viewport,
        section.points.chainage[i]!,
        section.points.height[i]!,
        out,
      );
      return { x: out[0]!, y: out[1]! };
    },
  };
}

describe('the plot, end to end', () => {
  it('binds pointer input and releases every listener', () => {
    const rig = endToEnd();
    expect(rig.canvas.bound('pointermove')).toBe(1);
    expect(rig.canvas.bound('click')).toBe(1);
    expect(rig.canvas.bound('dblclick')).toBe(1);
    rig.link.release();
    expect(rig.canvas.bound('pointermove')).toBe(0);
    expect(rig.canvas.bound('click')).toBe(0);
    expect(rig.canvas.bound('dblclick')).toBe(0);
  });

  it('hits the return under the pointer and marks that one in 3D', () => {
    const rig = endToEnd();
    const p = rig.pixelOf(3);
    rig.canvas.fire('pointermove', { offsetX: p.x, offsetY: p.y });
    expect(rig.frames).toHaveLength(1);
    rig.frames.shift()!();
    expect(rig.markers.at(-1)).toEqual({
      position: [10.03, 20, 30.03],
      mode: 'hover',
      size: profileMarkerSize(2),
    });
    expect(rig.readouts.at(-1)).toContain('Station');
  });

  it('misses cleanly well outside the hit radius', () => {
    const rig = endToEnd();
    const p = rig.pixelOf(0);
    rig.canvas.fire('pointermove', { offsetX: p.x + HIT_RADIUS_PX * 6, offsetY: p.y });
    rig.frames.shift()!();
    expect(rig.markers.at(-1)).toBeNull();
  });

  it('opens the card on a click, with the link row', () => {
    const rig = endToEnd();
    const p = rig.pixelOf(1);
    rig.canvas.fire('click', { offsetX: p.x, offsetY: p.y });
    const rows = rig.detail.at(-1)!;
    expect(rows!.some((r) => r.label === LINK_ROW_LABEL && r.value === 'marked in 3D')).toBe(true);
    expect(rows!.some((r) => r.label === 'Source point index' && r.value === '7')).toBe(true);
    expect(rows!.some((r) => r.label === 'Streaming node' && r.value === NODE_KEY)).toBe(true);
  });

  it('says an evicted node is gone while the card keeps its 2D figures', () => {
    const rig = endToEnd({ evicted: new Set([NODE_KEY]) });
    const p = rig.pixelOf(1);
    rig.canvas.fire('click', { offsetX: p.x, offsetY: p.y });
    const rows = rig.detail.at(-1)!;
    expect(rows!.some((r) => r.label === LINK_ROW_LABEL && r.value === 'source node evicted')).toBe(
      true,
    );
    // The section's own figures survive; only the world coordinates go.
    expect(rows!.some((r) => r.label === 'Chainage' && r.value === '5.000')).toBe(true);
    expect(rig.markers.at(-1)).toBeNull();
    expect(rig.link.controller.selection()).not.toBeNull();
  });

  it('returns the detail list to the section figures when the click misses', () => {
    const rig = endToEnd();
    const p = rig.pixelOf(1);
    rig.canvas.fire('click', { offsetX: p.x, offsetY: p.y });
    rig.canvas.fire('click', { offsetX: -500, offsetY: -500 });
    const rows = rig.detail.at(-1)!;
    expect(rows!.some((r) => r.label === 'Returns in corridor')).toBe(true);
  });

  it('paints the crosshair onto the overlay, never onto the plot', () => {
    const rig = endToEnd();
    const plotOps = rig.canvas.ctx.ops.length;
    const p = rig.pixelOf(2);
    rig.canvas.fire('pointermove', { offsetX: p.x, offsetY: p.y });
    rig.frames.shift()!();
    expect(rig.overlay.ctx.count('stroke')).toBeGreaterThan(0);
    expect(rig.canvas.ctx.ops).toHaveLength(plotOps);
  });

  it('sizes the overlay backing store in device pixels', () => {
    const rig = endToEnd();
    const p = rig.pixelOf(2);
    rig.canvas.fire('pointermove', { offsetX: p.x, offsetY: p.y });
    rig.frames.shift()!();
    expect(rig.overlay.width).toBe(320);
    expect(rig.overlay.height).toBe(160);
  });

  it('does no per-raw-event work: fifty moves, one frame, one readout', () => {
    const rig = endToEnd();
    const p = rig.pixelOf(2);
    for (let n = 0; n < 50; n++) {
      rig.canvas.fire('pointermove', { offsetX: p.x + n * 0.001, offsetY: p.y });
    }
    expect(rig.frames).toHaveLength(1);
    expect(rig.readouts).toHaveLength(0);
    rig.frames.shift()!();
    expect(rig.readouts).toHaveLength(1);
    expect(rig.link.controller.stats().hitTests).toBe(1);
  });

  it('offers no link at all when the host cannot resolve a return', () => {
    const section = fixtureSection();
    const canvas = new FakeCanvas(320, 160);
    const plot = prepareWorkbenchSection({ section, canvas: canvas as never });
    const attached = attachSectionPointLink({
      plot,
      section,
      handle: { canvas: canvas as never, setDetail: () => {} },
      scene: {
        profile: () => null,
        sectionChunks: function* () {
          return null;
        },
        metresPerUnit: () => null,
        devicePixelRatio: () => 1,
      },
      unitToMetres: null,
      devicePixelRatio: 1,
    });
    expect(attached).toBeNull();
    expect(canvas.bound('pointermove')).toBe(0);
  });
});
