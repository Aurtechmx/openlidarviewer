/**
 * actionDefinitions.test.ts
 *
 * What these tests would catch:
 *
 *  - A collaborator captured when the registry is BUILT instead of when a
 *    handler FIRES. `viewer` is assigned after boot and `tour` starts null, so
 *    a handler holding the build-time value would run against a stale viewer
 *    or never replay the tour at all.
 *  - A camera preset reporting a move that did not happen. `setCameraPreset`
 *    returns false when the preset is unavailable; dropping that guard records
 *    a workflow event and toasts a camera move for a camera that never moved.
 *  - A tool entry that sets a mode instead of toggling it, or that records the
 *    opposite of the state it just applied, so the recorded workflow replays
 *    the wrong tool state.
 *  - The lasso entry losing its selection-highlight clear on the off path,
 *    leaving highlighted points behind after the tool is disabled.
 *  - The two orbit-invert entries wired to the same axis, or crossed, so
 *    "Invert vertical orbit" flips yaw.
 *  - The saved-view entries losing their guards: saving with no scan open, or
 *    restoring from an empty list, which would index a bookmark that is not
 *    there. Also the off-by-one in the "last saved view" lookup that names the
 *    toast.
 *  - Dataset Story and Export health crossed: an export-health panel rendered
 *    under the Dataset Story title, or either one built from something other
 *    than the current story inputs.
 *  - A file-picker entry that acts on a cancelled dialog (no file chosen), or
 *    that leaks the hidden input into the document after the dialog closes.
 *  - The report verifier losing its chunk-load rejection handler, which turns
 *    a failed lazy import into an unhandled rejection.
 *  - The workflow save entry treating "nothing recorded" as a saved workflow,
 *    or mis-pluralising the replay count.
 *  - The workflow recorder entries appearing in the registry while the feature
 *    flag is off (the palette and the shortcut sheet render straight from this
 *    registry, so an inert entry is still a visible, dead command).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// The presentation collaborators are replaced so the handlers can be checked
// for WHAT they build and WHERE they send it, without a DOM renderer in the way.
const spies = vi.hoisted(() => ({
  openModal: vi.fn(),
  buildScanStory: vi.fn(),
  buildExportHealth: vi.fn(),
  renderDatasetStoryCard: vi.fn(),
  renderExportHealthPanel: vi.fn(),
  verifyAndShow: vi.fn(),
}));

vi.mock('../src/ui/Modal', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  openModal: spies.openModal,
}));
vi.mock('../src/intelligence/scanStory', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildScanStory: spies.buildScanStory,
  buildExportHealth: spies.buildExportHealth,
}));
vi.mock('../src/ui/scanStoryViews', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  renderDatasetStoryCard: spies.renderDatasetStoryCard,
  renderExportHealthPanel: spies.renderExportHealthPanel,
}));
vi.mock('../src/ui/reportVerifier', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyAndShow: spies.verifyAndShow,
}));

const {
  openModal,
  buildScanStory,
  buildExportHealth,
  renderDatasetStoryCard,
  renderExportHealthPanel,
  verifyAndShow,
} = spies;

import { buildActionRegistry, type ActionRegistryDeps } from '../src/app/actionDefinitions';
import type { Action } from '../src/ui/actionRegistry';
import { keyDisplayFor } from '../src/ui/keyBindings';
import { WORKFLOW_RECORDER_ENABLED } from '../src/ui/WorkflowController';
import { CAMERA_PRESET_ORDER } from '../src/render/camera/cameraPresets';
import { THEME_ORDER } from '../src/ui/themes';

/**
 * A recording stand-in for the one element the two file-picker entries build.
 * `el()` only ever sets `className` on it, so nothing else needs to be real.
 */
class FakeInput {
  className = '';
  type = '';
  accept = '';
  files: unknown = null;
  removed = false;
  clicks = 0;
  private readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  remove(): void {
    this.removed = true;
  }
  click(): void {
    this.clicks += 1;
  }
  /** Drive the picker the way a browser does once the dialog closes. */
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

const appended: FakeInput[] = [];

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => new FakeInput(),
    body: {
      append: (node: FakeInput) => {
        appended.push(node);
      },
    },
  };
});

/** Let the picker handlers' async chains (including a lazy import) settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

interface FakeViewer {
  measureMode: boolean;
  inspectMode: boolean;
  annotateMode: boolean;
  setCameraPreset: ReturnType<typeof vi.fn>;
  frameAll: ReturnType<typeof vi.fn>;
  setMeasureMode: ReturnType<typeof vi.fn>;
  setInspectMode: ReturnType<typeof vi.fn>;
  setAnnotateMode: ReturnType<typeof vi.fn>;
  clearSelectionHighlight: ReturnType<typeof vi.fn>;
}

function fakeViewer(): FakeViewer {
  return {
    measureMode: false,
    inspectMode: false,
    annotateMode: false,
    setCameraPreset: vi.fn(() => true),
    frameAll: vi.fn(),
    setMeasureMode: vi.fn(),
    setInspectMode: vi.fn(),
    setAnnotateMode: vi.fn(),
    clearSelectionHighlight: vi.fn(),
  };
}

interface Harness {
  actions: Action[];
  viewer: FakeViewer;
  tour: { replay: ReturnType<typeof vi.fn> } | null;
  capture: ReturnType<typeof vi.fn>;
  stopRecording: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  loadFromFile: ReturnType<typeof vi.fn>;
  replay: ReturnType<typeof vi.fn>;
  lasso: { enabled: boolean; enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> };
  compassEnabled: boolean;
  compassSet: ReturnType<typeof vi.fn>;
  bookmarkNames: string[];
  toast: ReturnType<typeof vi.fn>;
  setTheme: ReturnType<typeof vi.fn>;
  syncLassoButton: ReturnType<typeof vi.fn>;
  runDeriveClassification: ReturnType<typeof vi.fn>;
  runFillUnclassified: ReturnType<typeof vi.fn>;
  storyInputs: unknown;
  startWorkflowRecording: ReturnType<typeof vi.fn>;
  dispatchWorkflowEvent: ReturnType<typeof vi.fn>;
  configPanelOpen: ReturnType<typeof vi.fn>;
  shortcutSheetOpen: ReturnType<typeof vi.fn>;
  hasScan: boolean;
  saveCurrentView: ReturnType<typeof vi.fn>;
  applyView: ReturnType<typeof vi.fn>;
  toggleOrbitInvert: ReturnType<typeof vi.fn>;
  resetNavigation: ReturnType<typeof vi.fn>;
  togglePlanView: ReturnType<typeof vi.fn>;
  notePlanViewPreset: ReturnType<typeof vi.fn>;
  run: (id: string) => void;
  find: (id: string) => Action;
}

function harness(opts: { getViewer?: () => FakeViewer } = {}): Harness {
  const storyInputs = { marker: 'story-inputs' };
  const h: Partial<Harness> = {
    viewer: fakeViewer(),
    tour: { replay: vi.fn() },
    capture: vi.fn(),
    stopRecording: vi.fn(() => null),
    save: vi.fn(() => Promise.resolve('saved.olvworkflow')),
    loadFromFile: vi.fn(),
    replay: vi.fn(),
    lasso: { enabled: false, enable: vi.fn(), disable: vi.fn() },
    compassEnabled: false,
    compassSet: vi.fn(),
    bookmarkNames: [],
    toast: vi.fn(),
    setTheme: vi.fn(),
    syncLassoButton: vi.fn(),
    runDeriveClassification: vi.fn(() => Promise.resolve()),
    runFillUnclassified: vi.fn(() => Promise.resolve()),
    storyInputs,
    startWorkflowRecording: vi.fn(),
    dispatchWorkflowEvent: vi.fn(),
    configPanelOpen: vi.fn(),
    shortcutSheetOpen: vi.fn(),
    hasScan: true,
    saveCurrentView: vi.fn(),
    applyView: vi.fn(),
    toggleOrbitInvert: vi.fn(),
    resetNavigation: vi.fn(),
    togglePlanView: vi.fn(),
    notePlanViewPreset: vi.fn(),
  };
  const self = h as Harness;

  const deps = {
    getViewer: opts.getViewer ?? ((): FakeViewer => self.viewer),
    getTour: () => self.tour,
    workflowController: {
      capture: self.capture,
      stopRecording: self.stopRecording,
      save: self.save,
      loadFromFile: self.loadFromFile,
      replay: self.replay,
    },
    lassoVolumeTool: self.lasso,
    compass: {
      isEnabled: () => self.compassEnabled,
      setEnabled: self.compassSet,
    },
    bookmarks: {
      count: () => self.bookmarkNames.length,
      get: (i: number) =>
        i >= 0 && i < self.bookmarkNames.length ? { name: self.bookmarkNames[i] } : undefined,
    },
    showLassoToast: self.toast,
    setTheme: self.setTheme,
    syncLassoButton: self.syncLassoButton,
    runDeriveClassification: self.runDeriveClassification,
    runFillUnclassified: self.runFillUnclassified,
    buildCurrentStoryInputs: () => storyInputs,
    startWorkflowRecording: self.startWorkflowRecording,
    dispatchWorkflowEvent: self.dispatchWorkflowEvent,
    ensureWorkflowConfigPanel: () => Promise.resolve({ open: self.configPanelOpen }),
    ensureShortcutSheet: () => Promise.resolve({ open: self.shortcutSheetOpen }),
    hasScan: () => self.hasScan,
    saveCurrentView: self.saveCurrentView,
    applyView: self.applyView,
    toggleOrbitInvert: self.toggleOrbitInvert,
    resetNavigation: self.resetNavigation,
    planView: {
      togglePlanView: self.togglePlanView,
      notePlanViewPreset: self.notePlanViewPreset,
    },
  };

  self.actions = buildActionRegistry(deps as unknown as ActionRegistryDeps);
  self.find = (id: string): Action => {
    const found = self.actions.find((a) => a.id === id);
    if (!found) throw new Error(`no action ${id}`);
    return found;
  };
  self.run = (id: string): void => {
    self.find(id).run();
  };
  return self;
}

beforeEach(() => {
  appended.length = 0;
  openModal.mockReset();
  buildScanStory.mockReset();
  buildExportHealth.mockReset();
  renderDatasetStoryCard.mockReset();
  renderExportHealthPanel.mockReset();
  verifyAndShow.mockReset();
  verifyAndShow.mockResolvedValue(undefined);
});

describe('buildActionRegistry — registry shape', () => {
  it('gives every action a unique id, a section and a runnable handler', () => {
    const { actions } = harness();
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.section.length).toBeGreaterThan(0);
      expect(action.title.length).toBeGreaterThan(0);
      expect(typeof action.run).toBe('function');
    }
  });

  it('registers one Camera entry per preset, in preset order', () => {
    const { actions } = harness();
    // The section also holds entries that are not poses: Frame all, the
    // Plan-view toggle (a composed mode, covered by planViewWiring.test.ts),
    // the orthographic toggle, and the six axis-aligned views. The last two
    // groups are the panel's own controls given a second home, which is what
    // lets the navigation panel be closed at all (navViewControlsPersist).
    // Matched by shape rather than listed, so adding a view does not have to
    // be remembered here.
    const notAPreset = (id: string): boolean =>
      id === 'camera.frame-all' || id === 'camera.plan-view' ||
      id === 'camera.orthographic' || id.startsWith('camera.view-');
    const cameras = actions.filter((a) => a.id.startsWith('camera.') && !notAPreset(a.id));
    expect(cameras.map((a) => a.id)).toEqual(CAMERA_PRESET_ORDER.map((n) => `camera.${n}`));
  });

  it('offers Plan view from the palette, on the same toggle as the chip', () => {
    const h = harness();
    h.run('camera.plan-view');
    expect(h.togglePlanView).toHaveBeenCalledTimes(1);
  });

  it('tells plan mode which pose a palette preset aimed at', () => {
    const h = harness();
    // Plan mode claims the camera is looking straight down, so a preset fired
    // from here has to reach it the same way the NavBar chips do.
    h.run('camera.oblique');
    expect(h.notePlanViewPreset).toHaveBeenCalledWith('oblique');
  });

  it('advertises the preset keys but suppresses the Iso chip', () => {
    const { find } = harness();
    expect(find('camera.top').keys).toBe('T');
    expect(find('camera.oblique').keys).toBe('O');
    expect(find('camera.planar').keys).toBe('P');
    // Bare `I` belongs to the Inspect tool, so Iso must advertise nothing.
    expect(find('camera.iso').keys).toBeUndefined();
  });

  it('registers one Theme entry per shipped theme', () => {
    const { actions } = harness();
    const themes = actions.filter((a) => a.section === 'Theme');
    expect(themes.map((a) => a.id)).toEqual(THEME_ORDER.map((n) => `theme.${n}`));
  });

  it('includes the workflow recorder entries only while the flag is on', () => {
    const { actions } = harness();
    const workflow = actions.filter((a) => a.section === 'Workflow');
    expect(workflow.length).toBe(WORKFLOW_RECORDER_ENABLED ? 4 : 0);
  });
});

describe('buildActionRegistry — late-bound collaborators', () => {
  it('resolves the viewer when the handler fires, not when the registry is built', () => {
    let viewer: FakeViewer | null = null;
    const h = harness({
      getViewer: () => {
        if (!viewer) throw new Error('viewer not booted yet');
        return viewer;
      },
    });
    // The registry is already built; the viewer only exists now.
    viewer = fakeViewer();
    h.run('camera.frame-all');
    expect(viewer.frameAll).toHaveBeenCalledTimes(1);
  });

  it('replays the tour once it exists and stays silent while it is null', () => {
    const h = harness();
    const tour = h.tour!;
    h.tour = null;
    expect(() => h.run('tour.replay')).not.toThrow();
    expect(tour.replay).not.toHaveBeenCalled();
    h.tour = tour;
    h.run('tour.replay');
    expect(tour.replay).toHaveBeenCalledTimes(1);
  });
});

describe('buildActionRegistry — camera', () => {
  it('records and announces a preset only when the camera actually moved', () => {
    const h = harness();
    h.viewer.setCameraPreset.mockReturnValue(true);
    h.run('camera.top');
    expect(h.viewer.setCameraPreset).toHaveBeenLastCalledWith('top');
    expect(h.capture).toHaveBeenCalledWith({ type: 'camera-preset', name: 'top' });
    expect(h.toast).toHaveBeenCalledWith('Camera · Top view.');
  });

  it('records nothing when the preset was refused', () => {
    const h = harness();
    h.viewer.setCameraPreset.mockReturnValue(false);
    h.run('camera.oblique');
    expect(h.viewer.setCameraPreset).toHaveBeenCalledWith('oblique');
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('frames all and records the move', () => {
    const h = harness();
    h.run('camera.frame-all');
    expect(h.viewer.frameAll).toHaveBeenCalledTimes(1);
    expect(h.capture).toHaveBeenCalledWith({ type: 'frame-all' });
  });
});

describe('buildActionRegistry — theme', () => {
  it('applies each theme and records the one it applied', () => {
    for (const name of THEME_ORDER) {
      const h = harness();
      h.run(`theme.${name}`);
      expect(h.setTheme).toHaveBeenCalledWith(name);
      expect(h.capture).toHaveBeenCalledWith({ type: 'theme', name });
    }
  });
});

describe('buildActionRegistry — tools', () => {
  const cases = [
    ['tool.measure', 'measure', 'measureMode', 'setMeasureMode'],
    ['tool.inspect', 'inspect', 'inspectMode', 'setInspectMode'],
    ['tool.annotate', 'annotate', 'annotateMode', 'setAnnotateMode'],
  ] as const;

  for (const [id, tool, modeField, setter] of cases) {
    it(`${id} turns the tool on from off and records the state it applied`, () => {
      const h = harness();
      h.viewer[modeField] = false;
      h.run(id);
      expect(h.viewer[setter]).toHaveBeenCalledWith(true);
      expect(h.capture).toHaveBeenCalledWith({ type: 'tool', tool, on: true });
    });

    it(`${id} turns the tool off again from on`, () => {
      const h = harness();
      h.viewer[modeField] = true;
      h.run(id);
      expect(h.viewer[setter]).toHaveBeenCalledWith(false);
      expect(h.capture).toHaveBeenCalledWith({ type: 'tool', tool, on: false });
    });
  }

  it('runs the classification derivations', () => {
    const h = harness();
    h.run('tool.classify');
    expect(h.runDeriveClassification).toHaveBeenCalledTimes(1);
    expect(h.runFillUnclassified).not.toHaveBeenCalled();
    h.run('tool.fillUnclassified');
    expect(h.runFillUnclassified).toHaveBeenCalledTimes(1);
  });

  it('arms the lasso and tells the user where to draw', () => {
    const h = harness();
    h.lasso.enabled = false;
    h.run('tool.lasso-volume');
    expect(h.lasso.enable).toHaveBeenCalledTimes(1);
    expect(h.lasso.disable).not.toHaveBeenCalled();
    expect(h.viewer.clearSelectionHighlight).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('Lasso armed — draw a shape on the canvas.');
    expect(h.syncLassoButton).toHaveBeenCalledTimes(1);
  });

  it('disarms the lasso and clears the selection highlight it left behind', () => {
    const h = harness();
    h.lasso.enabled = true;
    h.run('tool.lasso-volume');
    expect(h.lasso.disable).toHaveBeenCalledTimes(1);
    expect(h.lasso.enable).not.toHaveBeenCalled();
    expect(h.viewer.clearSelectionHighlight).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith('Lasso off — back to navigation.');
    expect(h.syncLassoButton).toHaveBeenCalledTimes(1);
  });
});

describe('buildActionRegistry — story and export health', () => {
  it('builds the dataset story from the current inputs and shows it under its own title', () => {
    const h = harness();
    const story = { kind: 'story' };
    const card = { kind: 'card' };
    buildScanStory.mockReturnValue(story);
    renderDatasetStoryCard.mockReturnValue(card);
    h.run('story.dataset');
    expect(buildScanStory).toHaveBeenCalledWith(h.storyInputs);
    expect(renderDatasetStoryCard).toHaveBeenCalledWith(story);
    expect(openModal).toHaveBeenCalledWith({ title: 'Dataset Story', body: card });
    expect(buildExportHealth).not.toHaveBeenCalled();
  });

  it('builds the export health check from the same inputs and its own renderer', () => {
    const h = harness();
    const health = { kind: 'health' };
    const panel = { kind: 'panel' };
    buildExportHealth.mockReturnValue(health);
    renderExportHealthPanel.mockReturnValue(panel);
    h.run('export.health');
    expect(buildExportHealth).toHaveBeenCalledWith(h.storyInputs);
    expect(renderExportHealthPanel).toHaveBeenCalledWith(health);
    expect(openModal).toHaveBeenCalledWith({ title: 'Export health check', body: panel });
    expect(buildScanStory).not.toHaveBeenCalled();
  });
});

describe('buildActionRegistry — view and navigation', () => {
  it('toggles the compass to the opposite of its current state', () => {
    const h = harness();
    h.compassEnabled = false;
    h.run('view.compass');
    expect(h.compassSet).toHaveBeenLastCalledWith(true);
    h.compassEnabled = true;
    h.run('view.compass');
    expect(h.compassSet).toHaveBeenLastCalledWith(false);
  });

  it('maps vertical invert to the pitch axis and horizontal invert to yaw', () => {
    const h = harness();
    h.run('nav.invert-vertical');
    expect(h.toggleOrbitInvert).toHaveBeenLastCalledWith('y');
    h.run('nav.invert-horizontal');
    expect(h.toggleOrbitInvert).toHaveBeenLastCalledWith('x');
    expect(h.resetNavigation).not.toHaveBeenCalled();
  });

  it('resets navigation without touching either invert axis', () => {
    const h = harness();
    h.run('nav.reset');
    expect(h.resetNavigation).toHaveBeenCalledTimes(1);
    expect(h.toggleOrbitInvert).not.toHaveBeenCalled();
  });

  it('refuses to save a view state with no scan open', () => {
    const h = harness();
    h.hasScan = false;
    h.run('view.save-state');
    expect(h.saveCurrentView).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('Load a scan first — a view state captures the open scan.');
  });

  it('names the toast after the view state it just saved', () => {
    const h = harness();
    h.hasScan = true;
    h.bookmarkNames = ['View 1', 'Ridge line'];
    h.saveCurrentView.mockImplementation(() => {
      h.bookmarkNames.push('South wall');
    });
    h.run('view.save-state');
    expect(h.saveCurrentView).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith(
      'View state saved — “South wall” (rename it in the panel list).',
    );
  });

  it('falls back to a generic name when the saved view cannot be read back', () => {
    const h = harness();
    h.hasScan = true;
    h.bookmarkNames = [];
    h.run('view.save-state');
    expect(h.toast).toHaveBeenCalledWith('View state saved — “View” (rename it in the panel list).');
  });

  it('refuses to restore from an empty view-state list', () => {
    const h = harness();
    h.bookmarkNames = [];
    h.run('view.restore-state');
    expect(h.applyView).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('No saved view states yet — save one first (V).');
  });

  it('restores the most recently saved view state', () => {
    const h = harness();
    h.bookmarkNames = ['a', 'b', 'c'];
    h.run('view.restore-state');
    expect(h.applyView).toHaveBeenCalledWith(2);
    expect(h.toast).not.toHaveBeenCalled();
  });
});

describe('buildActionRegistry — key chips derive from the keyBindings table', () => {
  // Registry action id → the binding id whose displayKeys it must show. The
  // table is the single source; this parity guard fails if the two drift.
  const SHARED: ReadonlyArray<readonly [string, string]> = [
    ['tool.lasso-volume', 'lasso-toggle'],
    ['view.save-state', 'save-view'],
    ['help.shortcuts', 'shortcut-sheet'],
  ];

  it('shows the table displayKeys for each shared action', () => {
    const { find } = harness();
    for (const [actionId, bindingId] of SHARED) {
      const chip = keyDisplayFor(bindingId);
      expect(chip, bindingId).toBeTruthy();
      expect(find(actionId).keys, actionId).toBe(chip);
    }
  });

  it('keeps the exact chip strings that shipped', () => {
    const { find } = harness();
    expect(find('tool.lasso-volume').keys).toBe('L');
    expect(find('view.save-state').keys).toBe('V');
    expect(find('help.shortcuts').keys).toBe('?');
  });

  it.runIf(WORKFLOW_RECORDER_ENABLED)('derives the workflow-start chip from the table', () => {
    const { find } = harness();
    expect(find('workflow.start').keys).toBe(keyDisplayFor('workflow-recorder'));
    expect(find('workflow.start').keys).toBe('Cmd-Shift-U');
  });
});

describe('buildActionRegistry — help', () => {
  it('opens the shortcut sheet once it has loaded', async () => {
    const h = harness();
    h.run('help.shortcuts');
    await flush();
    expect(h.shortcutSheetOpen).toHaveBeenCalledTimes(1);
  });
});

describe('buildActionRegistry — verify integrity report', () => {
  it('offers a JSON picker and verifies the chosen file', async () => {
    const h = harness();
    h.run('report.verify');
    expect(appended).toHaveLength(1);
    const input = appended[0];
    expect(input.type).toBe('file');
    expect(input.accept).toContain('.json');
    expect(input.clicks).toBe(1);

    const file = { name: 'report.json' };
    input.files = [file];
    input.fire('change');
    // The verifier arrives as a lazy chunk, so the call lands a tick or more later.
    await vi.waitFor(() => expect(verifyAndShow).toHaveBeenCalledWith(file));
    expect(input.removed).toBe(true);
  });

  it('does nothing when the picker is cancelled', async () => {
    const h = harness();
    h.run('report.verify');
    const input = appended[0];
    input.files = [];
    input.fire('change');
    await flush();
    expect(input.removed).toBe(true);
    expect(verifyAndShow).not.toHaveBeenCalled();
  });

  it('warns instead of leaving an unhandled rejection when verification fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    verifyAndShow.mockRejectedValue(new Error('chunk gone'));
    const h = harness();
    h.run('report.verify');
    const input = appended[0];
    input.files = [{ name: 'report.json' }];
    input.fire('change');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});

describe.runIf(WORKFLOW_RECORDER_ENABLED)('buildActionRegistry — workflow recorder', () => {
  it('starts a recording', () => {
    const h = harness();
    h.run('workflow.start');
    expect(h.startWorkflowRecording).toHaveBeenCalledTimes(1);
  });

  it('saves the stopped workflow and states what the recipient needs', () => {
    const h = harness();
    const workflow = { events: [] };
    h.stopRecording.mockReturnValue(workflow);
    h.run('workflow.stop-save');
    expect(h.save).toHaveBeenCalledWith(workflow);
    expect(h.toast).toHaveBeenCalledWith(
      'Workflow saved. Replay needs the same scan open on the other end.',
    );
  });

  it('saves nothing when no recording was running', () => {
    const h = harness();
    h.stopRecording.mockReturnValue(null);
    h.run('workflow.stop-save');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('Workflow · nothing recorded yet.');
  });

  it('opens the recorder settings panel once it has loaded', async () => {
    const h = harness();
    h.run('workflow.settings');
    await flush();
    expect(h.configPanelOpen).toHaveBeenCalledTimes(1);
  });

  it('replays a chosen workflow file through the host dispatcher', async () => {
    const h = harness();
    const workflow = { events: [{ t: 0 }, { t: 1 }] };
    h.loadFromFile.mockResolvedValue(workflow);
    h.run('workflow.load-replay');
    expect(appended).toHaveLength(1);
    const input = appended[0];
    expect(input.type).toBe('file');
    expect(input.accept).toContain('.olvworkflow');
    const file = { name: 'demo.olvworkflow' };
    input.files = [file];
    input.fire('change');
    await flush();
    expect(h.loadFromFile).toHaveBeenCalledWith(file);
    expect(h.replay).toHaveBeenCalledWith(workflow, h.dispatchWorkflowEvent);
    expect(h.toast).toHaveBeenCalledWith('Workflow · playing 2 events.');
  });

  it('says "1 event" for a single-event workflow', async () => {
    const h = harness();
    h.loadFromFile.mockResolvedValue({ events: [{ t: 0 }] });
    h.run('workflow.load-replay');
    appended[0].files = [{ name: 'one.olvworkflow' }];
    appended[0].fire('change');
    await flush();
    expect(h.toast).toHaveBeenCalledWith('Workflow · playing 1 event.');
  });

  it('reports a load failure instead of replaying nothing', async () => {
    const h = harness();
    h.loadFromFile.mockRejectedValue(new Error('not a workflow'));
    h.run('workflow.load-replay');
    appended[0].files = [{ name: 'broken.olvworkflow' }];
    appended[0].fire('change');
    await flush();
    expect(h.replay).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith("Workflow · couldn't load file: not a workflow");
  });

  it('reports a non-Error load failure as an unknown error', async () => {
    const h = harness();
    h.loadFromFile.mockRejectedValue('nope');
    h.run('workflow.load-replay');
    appended[0].files = [{ name: 'broken.olvworkflow' }];
    appended[0].fire('change');
    await flush();
    expect(h.toast).toHaveBeenCalledWith("Workflow · couldn't load file: unknown error");
  });

  it('does nothing when the replay picker is cancelled', async () => {
    const h = harness();
    h.run('workflow.load-replay');
    const input = appended[0];
    input.files = [];
    input.fire('change');
    await flush();
    expect(input.removed).toBe(true);
    expect(h.loadFromFile).not.toHaveBeenCalled();
  });
});
