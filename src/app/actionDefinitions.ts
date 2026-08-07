// The command-palette / shortcut-sheet action registry, lifted out of main.ts.
//
// buildActionRegistry reaches into the shell for ~19 collaborators. They are
// passed in as `deps` rather than imported so this module stays free of the
// boot graph. Two are read through getters: `viewer` is a `let` assigned after
// boot, and `tour` starts null and is set later. Both must be resolved when a
// handler fires, not when the registry is built.

import type { Action } from '../ui/actionRegistry';
import type { Viewer } from '../render/Viewer';
import type { TourHandle } from '../ui/onboarding/bootTour';
import type { WorkflowController } from '../ui/WorkflowController';
import { WORKFLOW_RECORDER_ENABLED } from '../ui/WorkflowController';
import type { WorkflowConfigPanel } from '../ui/WorkflowConfigPanel';
import type { WorkflowEvent } from '../render/workflow/workflowRecorder';
import type { ShortcutSheet } from '../ui/ShortcutSheet';
import type { LassoVolumeTool } from '../ui/LassoVolumeTool';
import type { CompassController } from '../ui/compassController';
import type { ViewBookmarksService } from './viewBookmarks';
import { THEME_LABEL, THEME_ORDER, type ThemeName } from '../ui/themes';
import {
  CAMERA_PRESET_KEY,
  CAMERA_PRESET_LABEL,
  CAMERA_PRESET_ORDER,
} from '../render/camera/cameraPresets';
import { buildScanStory, buildExportHealth, type ScanStoryInputs } from '../intelligence/scanStory';
import { renderDatasetStoryCard, renderExportHealthPanel } from '../ui/scanStoryViews';
import { openModal } from '../ui/Modal';
import { el } from '../ui/dom';
import { loadReportVerifier } from '../lazyChunks';

export interface ActionRegistryDeps {
  getViewer: () => Viewer;
  getTour: () => TourHandle | null;
  workflowController: WorkflowController;
  lassoVolumeTool: LassoVolumeTool;
  compass: CompassController;
  bookmarks: ViewBookmarksService;
  showLassoToast: (
    message: string,
    action?: { readonly label: string; readonly onClick: () => void },
  ) => void;
  setTheme: (name: ThemeName) => void;
  syncLassoButton: () => void;
  runDeriveClassification: () => Promise<void>;
  runFillUnclassified: () => Promise<void>;
  buildCurrentStoryInputs: () => ScanStoryInputs;
  startWorkflowRecording: () => void;
  dispatchWorkflowEvent: (event: WorkflowEvent) => void;
  ensureWorkflowConfigPanel: () => Promise<WorkflowConfigPanel>;
  ensureShortcutSheet: () => Promise<ShortcutSheet>;
  hasScan: () => boolean;
  saveCurrentView: () => void;
  applyView: (index: number) => void;
}

export function buildActionRegistry(deps: ActionRegistryDeps): Action[] {
  const actions: Action[] = [];

  // Camera presets — same handlers as the T / O / P keys.
  for (const name of CAMERA_PRESET_ORDER) {
    const label = CAMERA_PRESET_LABEL[name];
    actions.push({
      id: `camera.${name}`,
      title: `${label} view`,
      section: 'Camera',
      // Iso's advertised 'I' chip is suppressed: bare 'I' is the Inspect
      // tool shortcut (see the keydown handler above) — Iso is palette /
      // NavBar only. Advertising a key that doesn't fire would be worse.
      keys: name === 'iso' ? undefined : CAMERA_PRESET_KEY[name],
      hint: `Frame the scan with the ${label.toLowerCase()} preset.`,
      keywords: ['view', 'pose', 'orbit'],
      run: () => {
        const fired = deps.getViewer().setCameraPreset(name);
        if (fired) {
          deps.workflowController.capture({ type: 'camera-preset', name });
          deps.showLassoToast(`Camera · ${label} view.`);
        }
      },
    });
  }
  // Reset / Frame All — exposed alongside the named presets.
  actions.push({
    id: 'camera.frame-all',
    title: 'Frame all',
    section: 'Camera',
    hint: 'Fit the camera to every visible cloud.',
    keywords: ['fit', 'reset', 'center', 'centre'],
    run: () => {
      deps.getViewer().frameAll();
      deps.workflowController.capture({ type: 'frame-all' });
    },
  });

  // Theme — same handler as the header theme toggle. `setTheme` keeps the
  // toggle's icon in sync.
  for (const name of THEME_ORDER) {
    actions.push({
      id: `theme.${name}`,
      title: `${THEME_LABEL[name]} theme`,
      section: 'Theme',
      hint: 'Switch the palette of the whole interface.',
      keywords: ['appearance', 'colours', 'colors', 'accessibility'],
      run: () => {
        deps.setTheme(name);
        deps.workflowController.capture({ type: 'theme', name });
      },
    });
  }

  // Tool dock — Measure, Inspect, Annotate, Lasso volume.
  actions.push(
    {
      id: 'tool.measure',
      title: 'Measure',
      section: 'Tools',
      hint: 'Activate the measurement toolbar.',
      keywords: ['distance', 'area', 'volume'],
      run: () => {
        const viewer = deps.getViewer();
        const next = !viewer.measureMode;
        viewer.setMeasureMode(next);
        deps.workflowController.capture({ type: 'tool', tool: 'measure', on: next });
      },
    },
    {
      id: 'tool.inspect',
      title: 'Inspect point',
      section: 'Tools',
      hint: 'Read attributes of any point under the cursor.',
      keywords: ['point info', 'attributes'],
      run: () => {
        const viewer = deps.getViewer();
        const next = !viewer.inspectMode;
        viewer.setInspectMode(next);
        deps.workflowController.capture({ type: 'tool', tool: 'inspect', on: next });
      },
    },
    {
      id: 'tool.annotate',
      title: 'Annotate',
      section: 'Tools',
      hint: 'Drop notes, info, warnings, or issues on points.',
      keywords: ['note', 'comment', 'mark'],
      run: () => {
        const viewer = deps.getViewer();
        const next = !viewer.annotateMode;
        viewer.setAnnotateMode(next);
        deps.workflowController.capture({ type: 'tool', tool: 'annotate', on: next });
      },
    },
    {
      id: 'tool.classify',
      title: 'Classify (derive)',
      section: 'Tools',
      hint: 'Derive a ground / vegetation / building classification for an unclassified scan (heuristic).',
      keywords: ['classification', 'ground', 'vegetation', 'building', 'segment', 'auto'],
      run: () => {
        void deps.runDeriveClassification();
      },
    },
    {
      id: 'tool.fillUnclassified',
      title: 'Fill unclassified points (derive)',
      section: 'Tools',
      hint: 'Derive only the unclassified points of a partially-classified scan, preserving every producer class (heuristic).',
      keywords: ['classification', 'fill', 'gaps', 'unclassified', 'producer', 'preserve'],
      run: () => {
        void deps.runFillUnclassified();
      },
    },
    {
      id: 'story.dataset',
      title: 'Dataset Story',
      section: 'Analyse',
      hint: 'What this scan is, how good it is, what it is best for, and the next step.',
      keywords: ['story', 'fitness', 'summary', 'overview', 'what is this', 'good for'],
      run: () => {
        openModal({ title: 'Dataset Story', body: renderDatasetStoryCard(buildScanStory(deps.buildCurrentStoryInputs())) });
      },
    },
    {
      id: 'export.health',
      title: 'Export health check',
      section: 'Export',
      hint: 'What is about to leave the app: scope, classification, CRS, datum, density, readiness.',
      keywords: ['export', 'health', 'check', 'hand-off', 'ready', 'before export'],
      run: () => {
        openModal({ title: 'Export health check', body: renderExportHealthPanel(buildExportHealth(deps.buildCurrentStoryInputs())) });
      },
    },
    {
      id: 'tool.lasso-volume',
      title: 'Lasso volume',
      section: 'Tools',
      keys: 'L',
      hint: 'Draw a freeform shape to measure a 3D volume.',
      keywords: ['select', 'shape', 'cut', 'fill'],
      run: () => {
        if (deps.lassoVolumeTool.enabled) {
          deps.lassoVolumeTool.disable();
          deps.getViewer().clearSelectionHighlight();
          deps.showLassoToast('Lasso off — back to navigation.');
        } else {
          deps.lassoVolumeTool.enable();
          deps.showLassoToast('Lasso armed — draw a shape on the canvas.');
        }
        deps.syncLassoButton();
      },
    },
  );

  // Workflow recorder — Start / Stop+Save / Open a file.
  //
  // v0.4.5 — gated behind WORKFLOW_RECORDER_ENABLED (currently false; see
  // WorkflowController.ts for the product rationale). The entries must be
  // ABSENT from the registry when the flag is off — not merely inert — so
  // the command palette and the shortcut sheet (both of which render
  // straight from this registry) show nothing for the feature.
  if (WORKFLOW_RECORDER_ENABLED) {
    actions.push(
      {
        id: 'workflow.start',
        title: 'Start recording workflow',
        section: 'Workflow',
        keys: 'Cmd-Shift-U',
        // v0.3.10 — `.olvworkflow` files capture camera
        // moves and tool actions ONLY (no scan data, no measurements). To
        // replay one the recipient needs the same scan file already open
        // locally. Without that disclosure users will share a workflow,
        // the recipient opens it, nothing happens, and trust is lost the
        // way it was with the pre-v0.3.10 "Share" button. The hint below
        // sets that expectation at recording start, the stop-save title
        // makes the file format explicit, and the save toast confirms
        // both what was saved and what the recipient needs to use it.
        hint:
          'Records camera moves and tool actions only — to replay later you ' +
          '(or the recipient) need the same scan open.',
        keywords: ['record', 'macro', 'demo'],
        run: () => deps.startWorkflowRecording(),
      },
      {
        id: 'workflow.stop-save',
        title: 'Stop and save workflow (.olvworkflow)',
        section: 'Workflow',
        hint:
          'Saves a replay of camera moves and tool actions — replay needs ' +
          'the same scan loaded on the other end.',
        keywords: ['export', 'finish', 'save'],
        run: () => {
          const workflow = deps.workflowController.stopRecording();
          if (workflow) {
            void deps.workflowController.save(workflow);
            deps.showLassoToast(
              'Workflow saved. Replay needs the same scan open on the other end.',
            );
          } else {
            deps.showLassoToast('Workflow · nothing recorded yet.');
          }
        },
      },
      {
        id: 'workflow.load-replay',
        title: 'Replay a workflow file…',
        section: 'Workflow',
        hint: 'Pick a .olvworkflow file and play it back.',
        keywords: ['load', 'import', 'open', 'macro'],
        run: () => {
          const input = el('input', { className: 'olv-hidden' });
          input.type = 'file';
          input.accept = '.olvworkflow,application/json';
          input.addEventListener('change', () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return;
            void (async () => {
              try {
                const workflow = await deps.workflowController.loadFromFile(file);
                deps.workflowController.replay(workflow, deps.dispatchWorkflowEvent);
                deps.showLassoToast(
                  `Workflow · playing ${workflow.events.length} event${workflow.events.length === 1 ? '' : 's'}.`,
                );
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'unknown error';
                deps.showLassoToast(`Workflow · couldn't load file: ${msg}`);
              }
            })();
          });
          document.body.append(input);
          input.click();
        },
      },
      {
        id: 'workflow.settings',
        title: 'Workflow recorder settings…',
        section: 'Workflow',
        hint: 'Format, save location, shortcut, replay speed, capture scope.',
        keywords: ['config', 'options', 'preferences', 'shortcut', 'speed'],
        run: () => void deps.ensureWorkflowConfigPanel().then((p) => p.open()),
      },
    );
  }

  // v0.5.2 — verify a handed-over integrity report. Opens a file picker, reads
  // the JSON, recomputes its digest (the algorithm is self-described in the
  // file), and shows intact / modified. Ungated; the verifier loads on demand.
  actions.push(
    {
      id: 'report.verify',
      title: 'Verify integrity report…',
      section: 'Export',
      hint: 'Check a report JSON — confirm its digest still matches its contents.',
      keywords: ['integrity', 'digest', 'tamper', 'check', 'sha', 'validate', 'verify'],
      run: () => {
        const input = el('input', { className: 'olv-hidden' });
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          input.remove();
          if (!file) return;
          void loadReportVerifier().then(({ verifyAndShow }) => verifyAndShow(file));
        });
        document.body.append(input);
        input.click();
      },
    },
    // v0.5.3 — toggle the on-canvas compass (promoted to a default control). The
    // choice persists; the widget loads lazily the first time it is shown.
    {
      id: 'view.compass',
      title: 'Toggle compass',
      section: 'View',
      hint: 'Show or hide the on-canvas compass — north plus the standard-view snaps.',
      keywords: ['compass', 'viewcube', 'north', 'rose', 'orientation', 'heading', 'gizmo'],
      run: () => deps.compass.setEnabled(!deps.compass.isEnabled()),
    },
    // v7 sessions — named view states from the palette. Both handlers already
    // live in this shell (the same saveCurrentView/applyView the panels call),
    // so these entries add only sub-KB registry rows — no new code is dragged
    // into the eager bundle. `keys: 'V'` advertises the binding that
    // ui/shortcuts.ts actually fires; the registry `keys` field is display-only.
    {
      id: 'view.save-state',
      title: 'Save view state',
      section: 'View',
      keys: 'V',
      hint: 'Bookmark the camera plus clip box, colour mode, class filter, point filters, and render settings as a named, restorable state.',
      keywords: ['bookmark', 'viewpoint', 'saved view', 'figure', 'state', 'capture'],
      run: () => {
        if (!deps.hasScan()) {
          deps.showLassoToast('Load a scan first — a view state captures the open scan.');
          return;
        }
        deps.saveCurrentView();
        const name = deps.bookmarks.get(deps.bookmarks.count() - 1)?.name ?? 'View';
        deps.showLassoToast(`View state saved — “${name}” (rename it in the panel list).`);
      },
    },
    {
      id: 'view.restore-state',
      title: 'Restore view state',
      section: 'View',
      hint: 'Reapply the most recently saved view state — the panel list restores any of them by name.',
      keywords: ['bookmark', 'viewpoint', 'saved view', 'figure', 'state', 'apply', 'go to'],
      run: () => {
        if (deps.bookmarks.count() === 0) {
          deps.showLassoToast('No saved view states yet — save one first (V).');
          return;
        }
        deps.applyView(deps.bookmarks.count() - 1);
      },
    },
    // v0.3.9 — Onboarding tour replay. Surfaces the tour from the
    // command palette so users who skipped or dismissed can re-trigger
    // it from one keystroke (Cmd-K → "tour").
    {
      id: 'tour.replay',
      title: 'Replay onboarding tour',
      section: 'Help',
      hint: 'Walks through the main tools — about 30 seconds.',
      keywords: ['onboarding', 'tour', 'help', 'tutorial', 'guide', 'walkthrough'],
      run: () => deps.getTour()?.replay(),
    },
    // v0.3.9 — Keyboard shortcut sheet. Surfaces the sheet from the
    // palette and lists its own binding (`?`) so users who discovered
    // the palette via Cmd-K can find the sheet from the same surface.
    {
      id: 'help.shortcuts',
      title: 'Show keyboard shortcuts',
      section: 'Help',
      keys: '?',
      hint: 'Every action and key, grouped by section.',
      keywords: ['shortcuts', 'keys', 'bindings', 'help', 'cheat', 'sheet'],
      run: () => void deps.ensureShortcutSheet().then((sheet) => sheet.open()),
    },
  );

  return actions;
}
