// What these tests would catch:
//
//  - A camera captured from the empty state. `getCameraState()` on a stage with
//    no scan returns the default pose, and a `.olvsession` exported before any
//    file was opened would then carry a viewpoint the author never chose — one
//    that overrides the load-time framing of whatever scan is opened next.
//  - A restored point-filter window applied with no scan loaded. The elevation
//    window is converted into the cloud's attribute space using that cloud's
//    origin and up-axis, so applying it against origin 0 leaves the wrong
//    window in place the moment a scan does arrive.
//  - The shell's tracked filter windows not being written back on restore. The
//    viewer would hold the restored window while the next capture reported none,
//    so a save-restore-save round trip would silently drop the filter.
//  - Camera applied before the display fields. A clip restore or a render
//    setting can re-fit or re-frame, so a camera that is not strictly LAST means
//    a regenerated figure does not match the one that was saved.
//  - A pre-v7 (camera-only) saved view routed through the rich restore path.
//    `applyCameraState` resets the FOV to the default, so a bookmark saved
//    before view bundles existed would come back with a different lens.
//  - `saveCurrentView` storing the bare pose instead of the full camera state,
//    which drops a non-default FOV / nav mode from what the view restores.
//  - A capture that serialises empty structures. An empty class filter or a
//    filter-free point-filter block must be pruned, not written, or a
//    camera-only view stops being byte-identical to its v6 form.

import { describe, it, expect, vi } from 'vitest';
import {
  createViewStateCoordinator,
  type ViewStateCoordinator,
  type ViewStateViewer,
} from '../src/app/viewStateCoordinator';
import type { ViewStateBundle } from '../src/io/viewState';
import type { SavedCameraState } from '../src/render/annotate/types';
import type { CameraPose } from '../src/render/NavController';
import type { ClipBox } from '../src/render/clip/clipBox';
import type { StoredView } from '../src/app/appContext';

/** A camera state distinguishable from the bare pose the fallback would store. */
const CAMERA: SavedCameraState = {
  position: [10, 20, 30],
  target: [0, 0, 0],
  up: [0, 0, 1],
  fov: 27,
} as unknown as SavedCameraState;

const POSE: CameraPose = {
  position: [1, 2, 3],
  target: [0, 0, 0],
} as unknown as CameraPose;

const CLIP: ClipBox = {
  min: [-1, -1, -1],
  max: [1, 1, 1],
  enabled: true,
} as unknown as ClipBox;

interface Harness {
  coordinator: ViewStateCoordinator;
  viewer: ViewStateViewer;
  /** Every viewer/panel call in the order it was made — the ordering oracle. */
  order: string[];
  inspector: {
    syncRendering: ReturnType<typeof vi.fn>;
    restoreElevationFilter: ReturnType<typeof vi.fn>;
    restoreIntensityFilter: ReturnType<typeof vi.fn>;
    setViews: ReturnType<typeof vi.fn>;
  };
  classLegend: {
    applyFilter: ReturnType<typeof vi.fn>;
    hidden: number[];
  };
  clipPanel: { setVisible: ReturnType<typeof vi.fn>; setState: ReturnType<typeof vi.fn> };
  /** The saved views the fake bookmark service holds. */
  views: StoredView[];
  /** The shell-side filter windows the coordinator reads and writes back. */
  filters: { elevation: [number, number] | null; intensity: [number, number] | null };
  applyCameraState: ReturnType<typeof vi.fn>;
  applyCameraPose: ReturnType<typeof vi.fn>;
  setClip: ReturnType<typeof vi.fn>;
  setColorMode: ReturnType<typeof vi.fn>;
  setStreamingColorMode: ReturnType<typeof vi.fn>;
  setElevationFilter: ReturnType<typeof vi.fn>;
  setIntensityFilter: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    hasScan?: boolean;
    activeScanId?: string | null;
    hasStreamingCloud?: boolean;
    clouds?: string[];
    clip?: ClipBox | null;
    hiddenCodes?: number[];
    filters?: { elevation: [number, number] | null; intensity: [number, number] | null };
  } = {},
): Harness {
  const order: string[] = [];
  /** A mock body that records WHEN it ran, so the apply order is assertable. */
  const note =
    (label: string) =>
    (): void => {
      order.push(label);
    };

  const applyCameraState = vi.fn(note('camera'));
  const applyCameraPose = vi.fn(note('pose'));
  const setClip = vi.fn(note('clip'));
  const setColorMode = vi.fn(note('colorMode'));
  const setStreamingColorMode = vi.fn(note('streamingColorMode'));
  const setElevationFilter = vi.fn(note('elevationFilter'));
  const setIntensityFilter = vi.fn(note('intensityFilter'));

  const viewer = {
    pointSize: 2,
    edlEnabled: true,
    edlStrength: 0.4,
    pointSizeMode: 'adaptive',
    antialiasing: false,
    twoFingerTwistEnabled: true,
    splatMode: 'classic',
    hasStreamingCloud: opts.hasStreamingCloud ?? false,
    clouds: () => opts.clouds ?? ['scan-a'],
    activeColorMode: () => 'elevation',
    getClip: () => opts.clip ?? null,
    setClip,
    getCameraState: () => CAMERA,
    applyCameraState,
    getCameraPose: () => POSE,
    applyCameraPose,
    setPointSize: vi.fn(note('render')),
    setPointSizeMode: vi.fn(),
    setEdlEnabled: vi.fn(),
    setEdlStrength: vi.fn(),
    setAntialiasing: vi.fn(),
    setColorMode,
    setStreamingColorMode,
    setElevationFilter,
    setIntensityFilter,
  } as unknown as ViewStateViewer;

  const inspector = {
    syncRendering: vi.fn(),
    restoreElevationFilter: vi.fn(),
    restoreIntensityFilter: vi.fn(),
    setViews: vi.fn(),
  };
  const classLegend = {
    hidden: opts.hiddenCodes ?? [],
    applyFilter: vi.fn(note('classFilter')),
    getVisibility: (): { hiddenCodes(): number[] } => ({
      hiddenCodes: () => classLegend.hidden,
    }),
  };
  const clipPanel = { setVisible: vi.fn(), setState: vi.fn() };
  const views: StoredView[] = [];
  const filters = opts.filters ?? { elevation: null, intensity: null };

  const coordinator = createViewStateCoordinator({
    getViewer: () => viewer,
    inspector,
    classLegend,
    clipPanel,
    bookmarks: {
      add: (view) => {
        const name = `View ${views.length + 1}`;
        views.push({ name, ...view });
        return name;
      },
      get: (index) => views[index],
      names: () => views.map((v) => v.name),
    },
    hasScan: () => opts.hasScan ?? true,
    getActiveScanId: () => (opts.activeScanId === undefined ? 'scan-a' : opts.activeScanId),
    getPointFilters: () => filters,
    onElevationFilterRestored: (range) => {
      filters.elevation = range;
    },
    onIntensityFilterRestored: (range) => {
      filters.intensity = range;
    },
  });

  return {
    coordinator,
    viewer,
    order,
    inspector,
    classLegend,
    clipPanel,
    views,
    filters,
    applyCameraState,
    applyCameraPose,
    setClip,
    setColorMode,
    setStreamingColorMode,
    setElevationFilter,
    setIntensityFilter,
  };
}

describe('capture — what a session and a saved view both record', () => {
  it('records the live camera when a scan is on stage', () => {
    const h = harness({ hasScan: true });
    expect(h.coordinator.capture().camera).toBe(CAMERA);
  });

  it('omits the camera from an empty-state capture', () => {
    // Nothing is loaded, so `getCameraState()` would report the default pose.
    // Recording it would give the session a viewpoint the author never chose.
    const h = harness({ hasScan: false });
    expect(h.coordinator.capture().camera).toBeUndefined();
  });

  it('records the render settings and the active colour mode', () => {
    const bundle = harness().coordinator.capture();
    expect(bundle.render).toEqual({
      pointSize: 2,
      edlEnabled: true,
      edlStrength: 0.4,
      pointSizeMode: 'adaptive',
      antialiasing: false,
    });
    expect(bundle.colorMode).toBe('elevation');
  });

  it('records the legend’s hidden classes as the class filter', () => {
    const h = harness({ hiddenCodes: [7, 18] });
    expect(h.coordinator.capture().classFilter).toEqual([7, 18]);
  });

  it('prunes an empty class filter rather than serialising it', () => {
    expect(harness({ hiddenCodes: [] }).coordinator.capture().classFilter).toBeUndefined();
  });

  it('records only the filter windows that are actually set', () => {
    const h = harness({ filters: { elevation: [10, 20], intensity: null } });
    expect(h.coordinator.capture().pointFilters).toEqual({ elevation: [10, 20] });
  });

  it('prunes the point-filter block when no window is set', () => {
    expect(harness().coordinator.capture().pointFilters).toBeUndefined();
  });

  it('records a clip the viewer holds, and nothing when it holds none', () => {
    expect(harness({ clip: CLIP }).coordinator.capture().clip).toBe(CLIP);
    expect(harness({ clip: null }).coordinator.capture().clip).toBeUndefined();
  });
});

describe('apply — the ordered restore', () => {
  const full: ViewStateBundle = {
    camera: CAMERA,
    render: {
      pointSize: 5,
      edlEnabled: false,
      edlStrength: 0.1,
      pointSizeMode: 'fixed',
      antialiasing: true,
    },
    colorMode: 'intensity',
    classFilter: [2],
    pointFilters: { elevation: [1, 2] },
    clip: CLIP,
  };

  it('applies the camera strictly last, after every display field', () => {
    const h = harness();
    h.coordinator.apply(full);
    expect(h.order[h.order.length - 1]).toBe('camera');
    expect(h.order).toContain('clip');
    expect(h.order.indexOf('render')).toBeLessThan(h.order.indexOf('camera'));
    expect(h.order.indexOf('clip')).toBeLessThan(h.order.indexOf('camera'));
  });

  it('mirrors the restored render settings back onto the Inspector', () => {
    const h = harness();
    h.coordinator.apply(full);
    expect(h.inspector.syncRendering).toHaveBeenCalledTimes(1);
    expect(h.inspector.syncRendering.mock.calls[0][0]).toMatchObject({
      twoFingerTwistEnabled: true,
      splatMode: 'classic',
    });
  });

  it('applies the colour mode to every static cloud and to the stream', () => {
    const h = harness({ clouds: ['a', 'b'] });
    h.coordinator.apply({ colorMode: 'intensity' });
    expect(h.setColorMode.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(h.setStreamingColorMode).toHaveBeenCalledWith('intensity');
  });

  it('fires no sink for an absent field', () => {
    const h = harness();
    h.coordinator.apply({ camera: CAMERA });
    expect(h.setClip).not.toHaveBeenCalled();
    expect(h.classLegend.applyFilter).not.toHaveBeenCalled();
    expect(h.applyCameraState).toHaveBeenCalledWith(CAMERA);
  });

  it('reflects a restored clip in the panel without re-firing its apply', () => {
    const h = harness();
    h.coordinator.apply({ clip: CLIP });
    expect(h.setClip).toHaveBeenCalledWith(CLIP);
    expect(h.clipPanel.setVisible).toHaveBeenCalledWith(true);
    expect(h.clipPanel.setState).toHaveBeenCalledWith(CLIP);
  });
});

describe('apply — the point-filter precondition', () => {
  it('skips the filter windows when no scan is loaded', () => {
    // The elevation window is converted against the cloud's own origin and
    // up-axis; there is no cloud to convert against here.
    const h = harness({ activeScanId: null, hasStreamingCloud: false });
    h.coordinator.apply({ pointFilters: { elevation: [1, 2], intensity: [3, 4] } });
    expect(h.setElevationFilter).not.toHaveBeenCalled();
    expect(h.setIntensityFilter).not.toHaveBeenCalled();
    expect(h.filters.elevation).toBeNull();
  });

  it('applies the filter windows to a streaming scan with no static id', () => {
    const h = harness({ activeScanId: null, hasStreamingCloud: true });
    h.coordinator.apply({ pointFilters: { elevation: [1, 2] } });
    expect(h.setElevationFilter).toHaveBeenCalledWith([1, 2]);
  });

  it('writes a restored window back to the shell so the next capture keeps it', () => {
    const h = harness();
    h.coordinator.apply({ pointFilters: { elevation: [1, 2], intensity: [3, 4] } });
    expect(h.inspector.restoreElevationFilter).toHaveBeenCalledWith([1, 2]);
    expect(h.inspector.restoreIntensityFilter).toHaveBeenCalledWith([3, 4]);
    expect(h.filters).toEqual({ elevation: [1, 2], intensity: [3, 4] });
    // The round trip is the point: what was restored is what comes back out.
    expect(h.coordinator.capture().pointFilters).toEqual({
      elevation: [1, 2],
      intensity: [3, 4],
    });
  });

  it('applies only the window the bundle carries', () => {
    const h = harness();
    h.coordinator.apply({ pointFilters: { intensity: [3, 4] } });
    expect(h.setElevationFilter).not.toHaveBeenCalled();
    expect(h.setIntensityFilter).toHaveBeenCalledWith([3, 4]);
  });
});

describe('saved views', () => {
  it('stores the full camera state as the pose, not the bare pose', () => {
    // The bare pose drops a non-default FOV / nav mode from what restores.
    const h = harness({ hasScan: true });
    h.coordinator.saveCurrentView();
    expect(h.views[0].pose).toBe(CAMERA);
  });

  it('falls back to the bare pose when the empty state gated the capture', () => {
    const h = harness({ hasScan: false });
    h.coordinator.saveCurrentView();
    expect(h.views[0].pose).toBe(POSE);
  });

  it('keeps the display state out of the bundle’s camera slot', () => {
    const h = harness({ hasScan: true, clip: CLIP });
    h.coordinator.saveCurrentView();
    expect(h.views[0].state?.camera).toBeUndefined();
    expect(h.views[0].state?.clip).toBe(CLIP);
  });

  it('prunes the unset fields from the stored bundle', () => {
    // An empty class filter and a window-free point-filter block are absence,
    // not data; writing them would bloat every view a scan with no filters saves.
    const h = harness({ hasScan: true, clip: null, hiddenCodes: [] });
    h.coordinator.saveCurrentView();
    expect(h.views[0].state?.classFilter).toBeUndefined();
    expect(h.views[0].state?.pointFilters).toBeUndefined();
    expect(h.views[0].state?.clip).toBeUndefined();
    expect(h.views[0].state?.render).toBeDefined();
  });

  it('pushes the saved names to the Inspector after a save', () => {
    const h = harness();
    h.coordinator.saveCurrentView();
    h.coordinator.saveCurrentView();
    expect(h.inspector.setViews).toHaveBeenLastCalledWith(['View 1', 'View 2']);
  });

  it('publishes the names on an explicit refresh', () => {
    const h = harness();
    h.views.push({ name: 'north-scarp', pose: POSE });
    h.coordinator.refreshViewsUi();
    expect(h.inspector.setViews).toHaveBeenCalledWith(['north-scarp']);
  });
});

describe('applyView — restoring a saved view by index', () => {
  it('glides only the pose for a pre-v7 camera-only view', () => {
    // `applyCameraState` would reset the FOV to the default; a bookmark saved
    // before view bundles existed must come back with the lens it had.
    const h = harness();
    h.views.push({ name: 'legacy', pose: POSE });
    h.coordinator.applyView(0);
    expect(h.applyCameraPose).toHaveBeenCalledWith(POSE);
    expect(h.applyCameraState).not.toHaveBeenCalled();
    expect(h.setClip).not.toHaveBeenCalled();
  });

  it('restores the whole bundle for a v7 view, pose last', () => {
    const h = harness();
    h.views.push({ name: 'north-scarp', pose: POSE, state: { clip: CLIP, colorMode: 'intensity' } });
    h.coordinator.applyView(0);
    expect(h.setClip).toHaveBeenCalledWith(CLIP);
    expect(h.applyCameraState).toHaveBeenCalledWith(POSE);
    expect(h.order[h.order.length - 1]).toBe('camera');
  });

  it('does nothing for an index with no saved view', () => {
    const h = harness();
    h.coordinator.applyView(3);
    expect(h.applyCameraPose).not.toHaveBeenCalled();
    expect(h.applyCameraState).not.toHaveBeenCalled();
  });
});
