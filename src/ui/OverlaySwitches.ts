/**
 * OverlaySwitches.ts
 *
 * The "Created layers" list under the Classes list in Data: one checkbox row
 * per generated scene overlay, styled like the class rows above it. It reads
 * and writes through the overlay registry only, so it stays in step with the
 * Analyse checkbox and the Lab toggles. Hidden until an overlay exists.
 */
import { el } from './dom';
import type { OverlayRegistry } from '../app/overlayRegistry';

export interface OverlaySwitches {
  readonly element: HTMLElement;
  dispose(): void;
}

export function createOverlaySwitches(registry: OverlayRegistry): OverlaySwitches {
  const list = el('div', { className: 'olv-cl-list olv-overlay-list' });
  const head = el('div', { className: 'olv-overlay-head', text: 'Created layers' });
  const element = el('section', { className: 'olv-overlay-switches olv-hidden' }, [head, list]);
  element.setAttribute('aria-label', 'Created layers');

  const render = (): void => {
    const entries = registry.available();
    element.classList.toggle('olv-hidden', entries.length === 0);
    // Keep focus on the same row across a re-render.
    const focusedId = (document.activeElement as HTMLElement | null | undefined)?.dataset?.overlayId ?? null;
    const checks = new Map<string, HTMLInputElement>();
    list.replaceChildren(
      ...entries.map((entry) => {
        const on = entry.get();
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'olv-cl-check';
        check.checked = on;
        check.dataset.overlayId = entry.id;
        checks.set(entry.id, check);
        check.addEventListener('change', () => {
          entry.set(check.checked);
          registry.changed();
        });
        const name = el('span', { className: 'olv-cl-name', text: entry.label });
        const row = el('label', { className: `olv-cl-row olv-overlay-row${on ? '' : ' is-hidden'}` }, [
          el('span', { className: 'olv-check-hit' }, [check]),
          name,
        ]);
        row.dataset.overlayId = entry.id;
        return row;
      }),
    );
    if (focusedId) checks.get(focusedId)?.focus();
  };

  const off = registry.onChange(render);
  render();
  return { element, dispose: off };
}
