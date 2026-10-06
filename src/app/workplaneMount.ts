/**
 * workplaneMount.ts
 *
 * The reference plane's lazy chunk: the three.js overlay, the controller and
 * the settings panel, joined. Nothing here loads before the plane is first
 * turned on or its View section is opened, so the startup shell carries only
 * the section's toggle (`ui/referencePlaneSection.ts`).
 */

import { WorkplaneOverlay } from '../render/workplane/WorkplaneOverlay';
import { createWorkplaneController, type WorkplaneController, type WorkplaneControllerDeps, type WorkplaneView } from './workplaneController';
import { createWorkplanePanel } from '../ui/workplanePanel';

export type WorkplaneMountDeps = Omit<WorkplaneControllerDeps, 'makeDrawing' | 'lightBackdrop' | 'onChange'>;

export interface WorkplaneMount {
  readonly controller: WorkplaneController;
  /** Remove the Escape listener and free everything the controller holds. */
  dispose(): void;
}

/**
 * Whether a CSS colour (`rgb(...)` or `#rrggbb`) is light: Rec. 709 luma of
 * the sRGB values above one half. Anything unparsed reads as dark, the
 * default backdrop.
 */
export function isLightColour(css: string): boolean {
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
  const parts = rgb ? rgb.slice(1, 4).map(Number) : hex ? hex.slice(1, 4).map((h) => parseInt(h, 16)) : null;
  if (!parts) return false;
  return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255 > 0.5;
}

/**
 * Build the plane into `host` (the section body). `onView` hears every change,
 * so the eager toggle can mirror the state.
 */
export function mountWorkplane(
  deps: WorkplaneMountDeps,
  host: HTMLElement,
  onView: (view: WorkplaneView) => void,
): WorkplaneMount {
  let panelRender: ((view: WorkplaneView) => void) | null = null;
  const controller = createWorkplaneController({
    ...deps,
    makeDrawing: (sceneHost) => new WorkplaneOverlay(sceneHost),
    // The sky preset paints the canvas container; only a light sky needs dark lines.
    lightBackdrop: () => isLightColour((deps.canvas as Partial<HTMLElement>).parentElement?.style.backgroundColor ?? ''),
    onChange: (view) => {
      panelRender?.(view);
      onView(view);
    },
  });
  const panel = createWorkplanePanel(host, controller);
  panelRender = panel.render;
  panel.render(controller.view());
  // Esc leaves a pick in progress. Registered for the life of the mount; it does
  // nothing unless a pick is running, so other Esc owners are unaffected.
  // Esc ends a pick only when no dialog or palette is open, and is not stopped,
  // so an Esc meant for a dialog reaches it and nothing else is swallowed.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !controller.view().picking) return;
    if (document.querySelector('[aria-modal="true"], dialog[open], .olv-palette:not(.olv-hidden)')) return;
    controller.cancelPick();
  };
  window.addEventListener('keydown', onKey, true);
  return {
    controller,
    dispose() {
      window.removeEventListener('keydown', onKey, true);
      controller.dispose();
    },
  };
}
