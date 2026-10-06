/**
 * referencePlaneSection.ts
 *
 * The startup-shell half of the reference plane: the View panel section's
 * on/off toggle and the handle the rest of the app talks to (the key binding,
 * the command palette, the session file, image exports, the lifetime owner).
 * Everything else (the overlay, the controller, the settings panel) is in the
 * lazy chunk `app/workplaneMount.ts`, loaded on the first toggle or the first
 * time the section is opened.
 *
 * Off by default. The settings live here as plain data until the chunk loads,
 * so a session can be saved and restored without loading it.
 */

import { el } from './dom';
import { loadWorkplane } from '../lazyChunks';
import type { WorkplaneMount, WorkplaneMountDeps } from '../app/workplaneMount';
import type { WorkplaneSettings } from '../model/workplaneSettings';

export interface ReferencePlaneDeps extends WorkplaneMountDeps {
  readonly toast: (message: string) => void;
  /** The CRS broadcast: null when the scan closes, which drops the plane. */
  readonly crs: { subscribe(listener: (resolved: unknown) => void): () => void };
}

export interface ReferencePlaneHandle {
  /** The section body the View panel wraps. */
  readonly element: HTMLElement;
  isEnabled(): boolean;
  setEnabled(on: boolean): Promise<void>;
  toggle(): void;
  /** Load the settings panel (the section was opened). */
  open(): Promise<void>;
  /** The settings to save in a session, or undefined when nothing was ever set. */
  sessionState(): WorkplaneSettings | undefined;
  restore(settings: WorkplaneSettings): Promise<void>;
  /** Run an image export with the plane hidden. */
  without<T>(fn: () => Promise<T>): Promise<T>;
  /** The provenance note for a snapshot while the plane is drawn, else null. */
  figureNote(): string | null;
  dispose(): void;
}

export function createReferencePlaneSection(deps: ReferencePlaneDeps): ReferencePlaneHandle {
  let enabled = false;
  let touched = false;
  let saved: WorkplaneSettings | undefined;
  let mount: WorkplaneMount | null = null;
  let loading: Promise<WorkplaneMount> | null = null;

  const chip = el('button', {
    className: 'olv-chip olv-refplane-toggle',
    type: 'button',
    text: 'Show reference plane',
    title: 'Draw a reference grid at an elevation you set (B). It is not measured terrain.',
  });
  chip.setAttribute('aria-pressed', 'false');
  const body = el('div', { className: 'olv-refplane-body' });
  const element = el('div', { className: 'olv-render-group olv-refplane' }, [chip, body]);

  const mirror = (on: boolean): void => {
    enabled = on;
    chip.setAttribute('aria-pressed', String(on));
    chip.classList.toggle('olv-chip-active', on);
  };

  const ensure = (): Promise<WorkplaneMount> => {
    if (mount) return Promise.resolve(mount);
    loading ??= loadWorkplane()
      .then(({ mountWorkplane }) => {
        mount = mountWorkplane(deps, body, (view) => {
          mirror(view.settings.enabled);
          saved = view.settings;
        });
        return mount;
      })
      .catch((err: unknown) => {
        loading = null; // the next press retries
        throw err;
      });
    return loading;
  };

  const setEnabled = async (on: boolean): Promise<void> => {
    touched = true;
    try {
      const m = await ensure();
      m.controller.setEnabled(on);
      const v = m.controller.view();
      deps.toast(on ? (v.drawn ? 'Reference plane on.' : 'Reference plane on. Set its elevation in View, Reference plane.') : 'Reference plane off.');
    } catch {
      deps.toast('The reference plane could not load. Try again.');
    }
  };

  chip.addEventListener('click', () => void setEnabled(!enabled));

  // A closed scan takes its plane with it: the coordinates it was placed in
  // describe data that is no longer open.
  const unsubscribe = deps.crs.subscribe((resolved) => {
    if (resolved) {
      mount?.controller.reframe();
      return;
    }
    mount?.controller.reset();
    mirror(false);
    saved = undefined;
    touched = false;
  });

  return {
    element,
    isEnabled: () => enabled,
    setEnabled,
    toggle: () => void setEnabled(!enabled),
    open: async () => {
      await ensure().catch(() => undefined);
    },
    sessionState: () => (touched ? saved : undefined),
    async restore(settings) {
      touched = true;
      saved = settings;
      try {
        (await ensure()).controller.restore(settings);
      } catch {
        deps.toast('The reference plane could not load. Try again.');
      }
    },
    without: (fn) => (mount ? mount.controller.without(fn) : fn()),
    figureNote: () => mount?.controller.figureNote() ?? null,
    dispose() {
      unsubscribe();
      mount?.dispose();
      mount = null;
    },
  };
}
