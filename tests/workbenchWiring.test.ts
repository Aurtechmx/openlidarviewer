/**
 * workbenchWiring.test.ts
 *
 * The wiring that makes the docked Profile Workbench reachable: the lazy seam,
 * the launcher that decides whether a dock opens at all, and the stage adapter
 * that turns the dock's height into a smaller 3D canvas.
 *
 * Node environment with a per-test recording DOM stub — the same convention
 * the panel's own suite uses, and the reason the panel can be mounted for real
 * here rather than through a double. No jsdom, no `window`, no `localStorage`.
 *
 * Each block pins one thing that has already been got wrong somewhere in this
 * codebase, or would silently degrade the feature if it regressed:
 *
 *   - the `import()` lives in `lazyChunks.ts` and nowhere else, because the
 *     live source transform scrambles a specifier written in a transformed
 *     caller and the chunk is then never emitted;
 *   - a refusal — wrong kind, narrow viewport, no stage, rejected chunk — comes
 *     back as `false` so Expand still has `ResultFocus`;
 *   - the dock's height reaches the stage element, which is the box the
 *     Viewer's own canvas `ResizeObserver` watches;
 *   - a second Expand replaces the first dock instead of stacking on it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadProfileWorkbench } from '../src/lazyChunks';
import { createProfileWorkbenchLauncher } from '../src/app/profileWorkbenchLauncher';
import { createProfileWorkbenchStage } from '../src/app/profileWorkbenchStage';
import { dockOccupiedHeight, defaultDockHeight } from '../src/ui/profileWorkbenchDock';
import {
  drawIndices,
  presentWorkbenchSection,
  SECTION_WORKING_STATUS,
  SLICE_BUDGET_MS,
} from '../src/app/profileWorkbenchSection';
import { axisSpanCaption } from '../src/render/measure/profileAxes';
import type {
  ProfileWorkbenchHandle,
  ProfileWorkbenchHost,
} from '../src/ui/ProfileWorkbench';
import type {
  ProfileWorkbenchModule,
  ProfileWorkbenchStage,
} from '../src/app/profileWorkbenchLauncher';
import type { WorkbenchSectionScene } from '../src/app/profileWorkbenchSection';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

/** A runtime `import('./relative')` — the form the live transform scrambles. */
const RUNTIME_RELATIVE_IMPORT = /(?<!\.)\bimport\s*\(\s*['"]\.\.?\//;

// ─────────────────────────────────────────────────────────────────────────────
// Recording DOM stub
// ─────────────────────────────────────────────────────────────────────────────

class FakeEl {
  readonly tagName: string;
  className = '';
  type = '';
  width = 0;
  height = 0;
  clientHeight = 0;
  clientWidth = 0;
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly attrs: Record<string, string> = {};
  readonly style: Record<string, string> & { height: string } = { height: '' };
  readonly dataset: Record<string, string> = {};
  readonly listeners: { type: string; fn: (ev: unknown) => void }[] = [];
  private readonly _classes = new Set<string>();
  private _text = '';

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  readonly classList = {
    add: (...c: string[]): void => c.forEach((n) => this._classes.add(n)),
    remove: (...c: string[]): void => c.forEach((n) => this._classes.delete(n)),
    contains: (c: string): boolean => this._classes.has(c),
    toggle: (c: string, on?: boolean): void => {
      const want = on ?? !this._classes.has(c);
      if (want) this._classes.add(c);
      else this._classes.delete(c);
    },
  };

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  set textContent(v: string) {
    this._text = v;
    this.children.length = 0;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void {
    for (const k of kids.filter(Boolean)) {
      k.parent = this;
      this.children.push(k);
    }
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.append(...kids);
  }
  remove(): void {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = null;
  }
  contains(node: FakeEl | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const at = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (at >= 0) this.listeners.splice(at, 1);
  }
  focus(): void {}
  blur(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getContext(): null {
    return null;
  }
  tree(): FakeEl[] {
    return [this as FakeEl, ...this.children.flatMap((c) => c.tree())];
  }
  byClass(cls: string): FakeEl | undefined {
    return this.tree().find(
      (n) => n.className.split(/\s+/).includes(cls) || n._classes.has(cls),
    );
  }
}

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.HTMLInputElement;
  delete g.HTMLAnchorElement;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** An app root holding a stage, the arrangement the real shell builds. */
function fakeAppRoot(containerHeight = 900): { root: FakeEl; stage: FakeEl } {
  const root = new FakeEl('div');
  root.clientHeight = containerHeight;
  const stage = new FakeEl('div');
  root.append(stage);
  return { root, stage };
}

interface StageRig {
  readonly stage: ProfileWorkbenchStage;
  readonly root: FakeEl;
  readonly stageEl: FakeEl;
  /** Every `onContainerResize` subscription still live. */
  readonly subscriptions: (() => void)[];
}

function stageRig(
  options: {
    containerHeight?: number;
    viewport?: { width: number; height: number; coarsePointer: boolean };
    withStage?: boolean;
  } = {},
): StageRig {
  const { root, stage: stageEl } = fakeAppRoot(options.containerHeight ?? 900);
  const subscriptions: (() => void)[] = [];
  const stage = createProfileWorkbenchStage({
    container: () => root as unknown as HTMLElement,
    stage: () => (options.withStage === false ? null : stageEl),
    onContainerResize: (callback) => {
      subscriptions.push(callback);
      return () => {
        const at = subscriptions.indexOf(callback);
        if (at >= 0) subscriptions.splice(at, 1);
      };
    },
    viewport: () => options.viewport ?? { width: 1440, height: 900, coarsePointer: false },
  });
  return { stage, root, stageEl, subscriptions };
}

/** A double for the lazy chunk that records every mount it was asked for. */
function fakeModule(): { module: ProfileWorkbenchModule; mounts: ProfileWorkbenchHost[] } {
  const mounts: ProfileWorkbenchHost[] = [];
  const module: ProfileWorkbenchModule = {
    mountProfileWorkbench: (host, options) => {
      mounts.push(host);
      let closed = false;
      const handle: ProfileWorkbenchHandle = {
        element: null as unknown as HTMLElement,
        canvas: null as unknown as HTMLCanvasElement,
        height: () => 0,
        collapsed: () => false,
        setCollapsed: () => {},
        setScope: () => {},
        setStatus: () => {},
        setDetail: () => {},
        close: () => {
          if (closed) return;
          closed = true;
          options?.onClose?.();
        },
      };
      return handle;
    },
  };
  return { module, mounts };
}

const PROFILE = { id: 'p1', kind: 'profile', name: 'Section A' };

/** A scene walk that finds no eligible layer, in one step. */
function* emptyWalk(): Generator<number, ProfileSectionResult | null, void> {
  return null;
}

/** A recording 2D context, reduced to what the section renderer writes. */
function recordingContext(): {
  fills: number;
  clears: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  setTransform(): void;
  clearRect(): void;
  fillRect(): void;
  beginPath(): void;
  moveTo(): void;
  lineTo(): void;
  stroke(): void;
} {
  return {
    fills: 0,
    clears: 0,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    setTransform(): void {},
    clearRect(): void {
      this.clears++;
    },
    fillRect(): void {
      this.fills++;
    },
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void {},
  };
}

/** A canvas whose CSS box the test moves, as the dock's own body would. */
class FakeCanvas {
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  readonly ctx = recordingContext();
  getContext(): ReturnType<typeof recordingContext> {
    return this.ctx;
  }
}

/**
 * A section whose extremes sit at index 1 only.
 *
 * Past the display cap the stride keeps the even indices, so index 1 is
 * drawn by nothing — which is exactly what makes a span computed off the
 * drawn subset differ from the corridor's real extent.
 */
function sectionWithOutlierAtIndexOne(count: number): ProfileSectionResult {
  const chainage = new Float32Array(count);
  const height = new Float64Array(count);
  chainage[1] = 100;
  height[1] = 50;
  return {
    points: {
      count,
      chainage,
      height,
      lateralOffset: new Float32Array(count),
      sourceSlot: new Uint16Array(count),
      pointIndex: new Uint32Array(count),
      channelPresence: new Uint8Array(count),
    },
    frame: null as never,
    band: 2,
    scope: 'static' as never,
    scopeLabel: 'One loaded layer.',
    streamingComplete: null,
    sources: [],
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
  };
}

/** A handle that records what the presenter told it, over a given canvas. */
function sectionHandle(canvas: FakeCanvas): {
  handle: Parameters<typeof presentWorkbenchSection>[0];
  scope: string[];
  status: string[];
  detail: (readonly { label: string; value: string }[] | null)[];
} {
  const scope: string[] = [];
  const status: string[] = [];
  const detail: (readonly { label: string; value: string }[] | null)[] = [];
  return {
    handle: {
      canvas: canvas as unknown as HTMLCanvasElement,
      setScope: (t) => scope.push(t),
      setStatus: (t) => status.push(t),
      setDetail: (rows) => detail.push(rows),
    },
    scope,
    status,
    detail,
  };
}

/** Read one labelled figure out of the rows the presenter handed over. */
function figure(
  rows: readonly { label: string; value: string }[] | null,
  label: string,
): string | undefined {
  return rows?.find((r) => r.label === label)?.value;
}


// ─────────────────────────────────────────────────────────────────────────────

describe('the workbench arrives through the lazyChunks seam, and only through it', () => {
  it('exports a loader that resolves the panel module', async () => {
    const module = await loadProfileWorkbench();
    expect(typeof module.mountProfileWorkbench).toBe('function');
  });

  it('writes the import() literal in lazyChunks.ts', () => {
    expect(readSource('src/lazyChunks.ts')).toContain(
      "export const loadProfileWorkbench = () => import('./ui/ProfileWorkbench');",
    );
  });

  it('leaves no runtime import() in either caller, which the live transform rewrites', () => {
    // Inlining the specifier into a transformed module is the v0.5.0 / v0.6.6
    // failure: the literal becomes a string-array lookup, the chunk is never
    // emitted, and the call 404s in the deployed build only.
    for (const rel of [
      'src/ui/MeasurePanel.ts',
      'src/app/measurePanelMount.ts',
      'src/app/profileWorkbenchRuntime.ts',
    ]) {
      expect(RUNTIME_RELATIVE_IMPORT.test(readSource(rel))).toBe(false);
    }
  });
});

describe('the launcher decides whether a dock opens', () => {
  it('opens for a profile and reports it did', async () => {
    const { module, mounts } = fakeModule();
    const rig = stageRig();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: rig.stage,
    });
    await expect(launcher.open(PROFILE)).resolves.toBe(true);
    expect(mounts).toHaveLength(1);
    expect(launcher.handle).not.toBeNull();
  });

  it('refuses a measurement that is not a profile, without loading the chunk', async () => {
    const { module, mounts } = fakeModule();
    const load = vi.fn(() => Promise.resolve(module));
    const launcher = createProfileWorkbenchLauncher({ load, stage: stageRig().stage });
    for (const kind of ['distance', 'area', 'height', 'volume']) {
      await expect(launcher.open({ id: 'm', kind, name: 'M' })).resolves.toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
    expect(mounts).toHaveLength(0);
    expect(launcher.handle).toBeNull();
  });

  it('falls back when the lazy import rejects, and says so once', async () => {
    const onLoadFailure = vi.fn();
    const boom = new Error('chunk 404');
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.reject(boom),
      stage: stageRig().stage,
      onLoadFailure,
    });
    await expect(launcher.open(PROFILE)).resolves.toBe(false);
    expect(onLoadFailure).toHaveBeenCalledTimes(1);
    expect(onLoadFailure).toHaveBeenCalledWith(boom);
    expect(launcher.handle).toBeNull();
  });

  it('refuses on a viewport that should not carry a desktop-density dock', async () => {
    const { module } = fakeModule();
    const load = vi.fn(() => Promise.resolve(module));
    const narrow = stageRig({
      viewport: { width: 390, height: 844, coarsePointer: true },
    });
    const launcher = createProfileWorkbenchLauncher({ load, stage: narrow.stage });
    await expect(launcher.open(PROFILE)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses when no stage was built', async () => {
    const { module } = fakeModule();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: stageRig({ withStage: false }).stage,
    });
    await expect(launcher.open(PROFILE)).resolves.toBe(false);
  });

  it('presents the mounted dock exactly once per open', async () => {
    const { module } = fakeModule();
    const present = vi.fn();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: stageRig().stage,
      present,
    });
    await launcher.open(PROFILE);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present.mock.calls[0]![1]).toEqual(PROFILE);
  });
});

describe('the dock height reaches the stage, which is the box the Viewer observes', () => {
  it('writes the stage a height short by exactly the dock', () => {
    const rig = stageRig();
    const host = rig.stage.host()!;
    host.notifyDockHeight(360);
    expect(rig.stageEl.style.height).toBe('calc(100% - 360px)');
  });

  it('hands the whole stage back when the dock reports nothing', () => {
    const rig = stageRig();
    const host = rig.stage.host()!;
    host.notifyDockHeight(360);
    host.notifyDockHeight(0);
    expect(rig.stageEl.style.height).toBe('');
  });

  it('shares the container height rather than the stage the dock already shrank', () => {
    const rig = stageRig({ containerHeight: 900 });
    const host = rig.stage.host()!;
    expect(host.stageHeight()).toBe(900);
    host.notifyDockHeight(360);
    // Re-read after the write: the allowance is the shared box, so it does not
    // collapse a little further on every apply.
    expect(host.stageHeight()).toBe(900);
  });

  it('shrinks the stage by the panel’s OWN opening height when one is mounted', async () => {
    const rig = stageRig({ containerHeight: 900 });
    const { mountProfileWorkbench } = await loadProfileWorkbench();
    const handle = mountProfileWorkbench(rig.stage.host()!, { title: 'Profile workbench' });
    // The expected number comes from the dock module, not from this test, so a
    // panel that computed its own height fails here the moment the two differ.
    const expected = dockOccupiedHeight(
      { preferredHeightPx: defaultDockHeight({ stageHeight: 900 }), collapsed: false },
      { stageHeight: 900 },
    );
    expect(handle.height()).toBe(expected);
    expect(rig.stageEl.style.height).toBe(`calc(100% - ${expected}px)`);
  });

  it('grows the scene back when the dock collapses, and again when it closes', async () => {
    const rig = stageRig({ containerHeight: 900 });
    const { mountProfileWorkbench } = await loadProfileWorkbench();
    const handle = mountProfileWorkbench(rig.stage.host()!, {});
    const open = handle.height();
    handle.setCollapsed(true);
    const collapsed = handle.height();
    expect(collapsed).toBeLessThan(open);
    expect(rig.stageEl.style.height).toBe(`calc(100% - ${collapsed}px)`);
    rig.stage.release();
    expect(rig.stageEl.style.height).toBe('');
  });
});

describe('one dock at a time', () => {
  it('replaces the mounted dock rather than stacking a second one', async () => {
    const rig = stageRig({ containerHeight: 900 });
    const module = await loadProfileWorkbench();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: rig.stage,
    });

    await launcher.open(PROFILE);
    const first = launcher.handle!;
    await launcher.open({ id: 'p2', kind: 'profile', name: 'Section B' });
    const second = launcher.handle!;

    expect(second).not.toBe(first);
    const docks = rig.root.children.filter((c) => c.byClass('olv-workbench') === c);
    expect(docks).toHaveLength(1);
    expect((first.element as unknown as FakeEl).parent).toBeNull();
    expect((second.element as unknown as FakeEl).parent).toBe(rig.root);
  });

  it('releases the stage exactly once when the replaced dock closes', async () => {
    const rig = stageRig({ containerHeight: 900 });
    const module = await loadProfileWorkbench();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: rig.stage,
    });
    await launcher.open(PROFILE);
    await launcher.open({ id: 'p2', kind: 'profile', name: 'Section B' });
    // The replacement is live, so the stage must still be short by ITS height —
    // the outgoing dock's teardown must not have handed the whole stage back.
    expect(rig.stageEl.style.height).toBe(`calc(100% - ${launcher.handle!.height()}px)`);
    launcher.close();
    expect(rig.stageEl.style.height).toBe('');
    expect(launcher.handle).toBeNull();
  });

  it('drops the replaced dock’s stage-resize subscription', async () => {
    const rig = stageRig({ containerHeight: 900 });
    const module = await loadProfileWorkbench();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: rig.stage,
    });
    await launcher.open(PROFILE);
    expect(rig.subscriptions).toHaveLength(1);
    await launcher.open({ id: 'p2', kind: 'profile', name: 'Section B' });
    expect(rig.subscriptions).toHaveLength(1);
    launcher.close();
    expect(rig.subscriptions).toHaveLength(0);
  });
});

describe('the presenter says why, rather than showing an empty plot', () => {
  /** A dock handle that records only what it was told. */
  function recordingHandle(): {
    handle: Parameters<typeof presentWorkbenchSection>[0];
    scope: string[];
    status: string[];
    detail: (readonly { label: string; value: string }[] | null)[];
  } {
    const scope: string[] = [];
    const status: string[] = [];
    const detail: (readonly { label: string; value: string }[] | null)[] = [];
    return {
      handle: {
        canvas: new FakeEl('canvas') as unknown as HTMLCanvasElement,
        setScope: (t) => scope.push(t),
        setStatus: (t) => status.push(t),
        setDetail: (rows) => detail.push(rows),
      },
      scope,
      status,
      detail,
    };
  }

  it('reports a measurement that no longer has two endpoints', () => {
    const rec = recordingHandle();
    presentWorkbenchSection(rec.handle, 'p1', {
      profile: () => null,
      sectionChunks: emptyWalk,
      metresPerUnit: () => null,
      devicePixelRatio: () => 1,
    });
    expect(rec.status).toEqual(['This profile no longer has two endpoints to section.']);
    expect(rec.detail).toHaveLength(0);
  });

  it('reports a scene with no eligible layer', () => {
    const rec = recordingHandle();
    presentWorkbenchSection(rec.handle, 'p1', {
      profile: () => ({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: null }),
      sectionChunks: emptyWalk,
      metresPerUnit: () => null,
      devicePixelRatio: () => 1,
    });
    // The working line first: the dock is mounted before the walk answers.
    expect(rec.status).toEqual([
      SECTION_WORKING_STATUS,
      'No layer is currently eligible for a section.',
    ]);
  });

  it('subsamples at a fixed stride past the cap, and keeps every return under it', () => {
    expect(drawIndices(0)).toHaveLength(0);
    expect([...drawIndices(5, 10)]).toEqual([0, 1, 2, 3, 4]);
    // 10 of 25 requested → stride 3, a deterministic every-third return.
    expect([...drawIndices(25, 10)]).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24]);
  });
});

describe('the plot is redrawn whenever its box changes', () => {
  /** A scene over one small section, with the canvas box under test control. */
  function sceneOver(
    section: ProfileSectionResult,
    observe: (canvas: HTMLCanvasElement, onChange: () => void) => () => void,
  ): WorkbenchSectionScene {
    return {
      profile: () => ({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: null }),
      sectionChunks: function* () {
        return section;
      },
      metresPerUnit: () => null,
      devicePixelRatio: () => 2,
      observeCanvasSize: observe,
    };
  }

  it('leaves a collapsed dock unsized, then draws the plot when it is expanded', () => {
    const canvas = new FakeCanvas();
    let notify = (): void => {};
    const rec = sectionHandle(canvas);
    // A dock restored from a persisted `collapsed: true` has `display: none`
    // on its body, so the canvas reads 0x0 at the moment the section lands.
    const dispose = presentWorkbenchSection(
      rec.handle,
      'p1',
      sceneOver(sectionWithOutlierAtIndexOne(64), (_c, cb) => {
        notify = cb;
        return () => {};
      }),
    );
    // Nothing was sized off a box with no area: a one-device-pixel backing
    // store is what an expand would otherwise be showing.
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(canvas.ctx.fills).toBe(0);
    // The figures are there regardless — the readable half never waited on a box.
    expect(rec.detail).toHaveLength(1);

    canvas.clientWidth = 800;
    canvas.clientHeight = 300;
    notify();
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(600);
    expect(canvas.ctx.fills).toBeGreaterThan(0);

    // A splitter drag is the same event: a taller box, a taller backing store.
    canvas.clientHeight = 500;
    notify();
    expect(canvas.height).toBe(1000);

    dispose();
  });

  it('releases the size subscription when the dock goes', () => {
    const canvas = new FakeCanvas();
    canvas.clientWidth = 800;
    canvas.clientHeight = 300;
    const released = vi.fn();
    const dispose = presentWorkbenchSection(
      sectionHandle(canvas).handle,
      'p1',
      sceneOver(sectionWithOutlierAtIndexOne(64), () => released),
    );
    dispose();
    expect(released).toHaveBeenCalledTimes(1);
  });
});

describe('the span figures describe the corridor, not the drawn subset', () => {
  it('measures the spans over every accepted return past the display cap', () => {
    // 120 002 accepted → stride 2 → the odd indices are drawn by nothing, and
    // this section keeps its only extremes at index 1.
    const section = sectionWithOutlierAtIndexOne(120_002);
    const canvas = new FakeCanvas();
    canvas.clientWidth = 800;
    canvas.clientHeight = 300;
    const rec = sectionHandle(canvas);
    presentWorkbenchSection(rec.handle, 'p1', {
      profile: () => ({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: null }),
      sectionChunks: function* () {
        return section;
      },
      metresPerUnit: () => null,
      devicePixelRatio: () => 1,
      observeCanvasSize: () => () => {},
    });
    const rows = rec.detail[0]!;
    // The cap really did bite, so the two sets genuinely differ here.
    expect(figure(rows, 'Returns in corridor')).toBe('120002');
    expect(figure(rows, 'Drawn')).toBe('60001');
    expect(figure(rows, 'Chainage span')).toBe(axisSpanCaption(100, null));
    expect(figure(rows, 'Height span')).toBe(axisSpanCaption(50, null));
    // What the drawn subset alone would have claimed.
    expect(figure(rows, 'Chainage span')).not.toBe(axisSpanCaption(0, null));
  });
});

describe('the corridor is walked across frames', () => {
  it('yields the main thread between chunks and finishes on the scheduler', () => {
    const canvas = new FakeCanvas();
    canvas.clientWidth = 800;
    canvas.clientHeight = 300;
    const rec = sectionHandle(canvas);
    const queued: (() => void)[] = [];
    let clock = 0;
    let pulled = 0;
    presentWorkbenchSection(rec.handle, 'p1', {
      profile: () => ({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: null }),
      sectionChunks: function* () {
        for (let i = 0; i < 4; i++) {
          pulled++;
          clock += SLICE_BUDGET_MS;
          yield i * 1000;
        }
        return sectionWithOutlierAtIndexOne(64);
      },
      metresPerUnit: () => null,
      devicePixelRatio: () => 1,
      now: () => clock,
      scheduleSlice: (run) => queued.push(run),
      observeCanvasSize: () => () => {},
    });
    // The dock is mounted and saying what it is doing; the scan is not done.
    expect(rec.status).toEqual([SECTION_WORKING_STATUS]);
    expect(pulled).toBe(1);
    expect(queued).toHaveLength(1);
    expect(rec.detail).toHaveLength(0);

    while (queued.length > 0) queued.shift()!();
    expect(pulled).toBe(4);
    expect(rec.detail).toHaveLength(1);
    expect(rec.status.at(-1)).toBe('Showing 64 returns.');
  });

  it('abandons a walk still in flight when the dock goes', () => {
    const canvas = new FakeCanvas();
    const rec = sectionHandle(canvas);
    const queued: (() => void)[] = [];
    let clock = 0;
    let pulled = 0;
    const signals: { aborted: boolean }[] = [];
    const dispose = presentWorkbenchSection(rec.handle, 'p1', {
      profile: () => ({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: null }),
      sectionChunks: function* (request) {
        signals.push(request.signal as { aborted: boolean });
        // Long enough that the walk is unquestionably still in flight after
        // one slice, bounded so a presenter that stopped yielding ends up
        // failing an assertion rather than hanging the suite.
        for (let i = 0; i < 1000; i++) {
          pulled++;
          clock += SLICE_BUDGET_MS;
          yield pulled;
        }
        return sectionWithOutlierAtIndexOne(8);
      },
      metresPerUnit: () => null,
      devicePixelRatio: () => 1,
      now: () => clock,
      scheduleSlice: (run) => queued.push(run),
    });
    expect(pulled).toBe(1);
    dispose();
    expect(signals[0]!.aborted).toBe(true);
    queued.shift()!();
    expect(pulled).toBe(1);
    expect(rec.detail).toHaveLength(0);
  });
});

describe('a fill that throws leaves no dock behind', () => {
  it('hands the stage back and answers false', async () => {
    const rig = stageRig({ containerHeight: 900 });
    const module = await loadProfileWorkbench();
    const onPresentFailure = vi.fn();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: rig.stage,
      present: () => {
        throw new Error('the scene went away mid-extraction');
      },
      onPresentFailure,
    });
    await expect(launcher.open(PROFILE)).resolves.toBe(false);
    expect(launcher.handle).toBeNull();
    expect(onPresentFailure).toHaveBeenCalledTimes(1);
    expect(rig.stageEl.style.height).toBe('');
    expect(rig.subscriptions).toHaveLength(0);
  });

  it('runs the release a fill handed back when the dock closes', async () => {
    const { module } = fakeModule();
    const release = vi.fn();
    const launcher = createProfileWorkbenchLauncher({
      load: () => Promise.resolve(module),
      stage: stageRig().stage,
      present: () => release,
    });
    await launcher.open(PROFILE);
    expect(release).not.toHaveBeenCalled();
    launcher.close();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
