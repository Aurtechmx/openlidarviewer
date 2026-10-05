/**
 * cameraActions.ts
 *
 * Camera poses, plan view, the axis-aligned views, the projection toggle and
 * Frame all. Needs the Viewer, the plan-view state, the workflow capture and
 * the toast: nothing else. The preset chips come from the camera table, and
 * Iso keeps no chip because bare I is the Inspect tool. Every entry sits in
 * the Camera section.
 */
import type { Action } from '../../ui/actionRegistry';
import type { Viewer } from '../../render/Viewer';
import type { WorkflowController } from '../../ui/WorkflowController';
import {
  CAMERA_PRESET_ORDER,
  CAMERA_PRESET_LABEL,
  CAMERA_PRESET_KEY,
  STANDARD_VIEW_ORDER,
  STANDARD_VIEW_LABEL,
  type CameraPresetName,
} from '../../render/camera/cameraPresets';
import { cameraPresetTitle, standardViewTitle } from '../../ui/actionNames';
import { actionTitle } from '../../ui/actionDescriptors';

/** The plan-mode surface the palette needs; `navBarWiring` satisfies it. */
export interface PlanViewActions {
  togglePlanView: () => void;
  /**
   * A camera preset fired from the palette rather than the bar. Plan mode is a
   * claim that the camera is looking straight down, so it has to hear about
   * every route that aims it.
   */
  notePlanViewPreset: (name: CameraPresetName) => void;
  /** Show or hide the Navigation panel (camera presets, views, Ortho, Plan). */
  toggleNavigationPanel: () => void;
}

export interface CameraActionDeps {
  getViewer: () => Viewer;
  planView: PlanViewActions;
  capture: WorkflowController['capture'];
  showLassoToast: (message: string) => void;
}

export function contributeCameraActions(deps: CameraActionDeps): Action[] {
  const actions: Action[] = [];
  // Camera presets, same handlers as the T / O / P keys.
  for (const name of CAMERA_PRESET_ORDER) {
    const label = CAMERA_PRESET_LABEL[name];
    actions.push({
      id: `camera.${name}`,
      title: cameraPresetTitle(label),
      section: 'Camera',
      // Iso's advertised 'I' chip is suppressed: bare 'I' is the Inspect
      // tool shortcut (see the keydown handler above), Iso is palette /
      // NavBar only. Advertising a key that doesn't fire would be worse.
      keys: name === 'iso' ? undefined : CAMERA_PRESET_KEY[name],
      hint: `Frame the scan with the ${label.toLowerCase()} preset.`,
      keywords: ['view', 'pose', 'orbit'],
      run: () => {
        const fired = deps.getViewer().setCameraPreset(name);
        if (fired) {
          deps.planView.notePlanViewPreset(name);
          deps.capture({ type: 'camera-preset', name });
          deps.showLassoToast(`Camera · ${label} view.`);
        }
      },
    });
  }
  // Plan view, the composed top-down workflow, not a pose. It lives in the
  // Camera section beside the presets because that is where a user looking for
  // "look straight down" goes; the state and the restore live in
  // planViewController.ts, which this only pokes.
  actions.push({
    id: 'camera.plan-view',
    title: actionTitle('camera.plan-view'),
    section: 'Camera',
    hint: 'Look straight down in parallel projection, with the hand tool on the drag.',
    keywords: ['plan', 'top', 'ortho', 'orthographic', 'parallel', '2d', 'map', 'pan'],
    run: () => deps.planView.togglePlanView(),
  });
  // The Navigation panel starts closed; this is its palette route, beside H
  // and the panel button on the navigation bar.
  actions.push({
    id: 'camera.navigation-panel',
    title: actionTitle('camera.navigation-panel'),
    section: 'Camera',
    hint: 'Show or hide the Navigation panel: camera presets, the six views, Ortho and Plan. H does the same.',
    keywords: ['navigation', 'panel', 'hud', 'legend', 'views', 'camera', 'help'],
    run: () => deps.planView.toggleNavigationPanel(),
  });
  // The six axis-aligned views and the orthographic toggle, which until now
  // lived only on the navigation panel. That made the panel undismissable in
  // practice: closing it would have taken the only route to them, and the
  // dismissal is persisted, so the loss would have outlived the session. A
  // second home is what lets the panel be closed at all.
  for (const view of STANDARD_VIEW_ORDER) {
    const label = STANDARD_VIEW_LABEL[view];
    actions.push({
      id: `camera.view-${view}`,
      title: standardViewTitle(label),
      section: 'Camera',
      hint: `Look straight along the ${label.toLowerCase()} axis.`,
      keywords: ['view', 'axis', 'square', 'face', 'elevation', 'plan'],
      run: () => {
        if (!deps.getViewer().setStandardView(view)) return;
        deps.showLassoToast(`Camera · ${label} view.`);
      },
    });
  }
  actions.push({
    id: 'camera.orthographic',
    title: actionTitle('camera.orthographic'),
    section: 'Camera',
    hint: 'Parallel projection, so equal lengths measure equal on screen.',
    keywords: ['ortho', 'parallel', 'projection', 'perspective', '2d'],
    run: () => {
      const viewer = deps.getViewer();
      const on = !viewer.orthographic;
      if (!viewer.setOrthographic(on)) return;
      deps.showLassoToast(`Camera · orthographic ${on ? 'on' : 'off'}.`);
    },
  });

  // Reset / Frame All, exposed alongside the named presets.
  actions.push({
    id: 'camera.frame-all',
    title: actionTitle('camera.frame-all'),
    section: 'Camera',
    hint: 'Fit the camera to every visible cloud.',
    keywords: ['fit', 'reset', 'center', 'centre'],
    run: () => {
      deps.getViewer().frameAll();
      deps.capture({ type: 'frame-all' });
    },
  });
  return actions;
}
