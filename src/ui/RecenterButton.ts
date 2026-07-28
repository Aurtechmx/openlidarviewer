/**
 * RecenterButton.ts — return the camera to the loaded scan.
 *
 * Orbiting, walking or flying away from a scan leaves no obvious way back:
 * the keyboard reset exists but is undiscoverable, and on touch there is no
 * key to press at all. This is the same action the navigation reset performs,
 * given a control.
 *
 * It carries the header's ghost-button treatment and stays hidden until a
 * scan is loaded, so an empty viewer shows nothing to press.
 */
import { el } from './dom';

// Crosshair over a target: the frame, and the point it returns to.
const ICON_RECENTER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
  <circle cx="12" cy="12" r="4.2"/>
  <path d="M12 2.6v3.6M12 17.8v3.6M2.6 12h3.6M17.8 12h3.6"/>
</svg>`;

export class RecenterButton {
  readonly element: HTMLButtonElement;

  constructor(onRecenter: () => void) {
    this.element = el('button', {
      className: 'olv-fs-toggle olv-recenter',
      unsafeHtml: ICON_RECENTER,
      title: 'Back to centre',
      ariaLabel: 'Return the view to the scan',
    }) as HTMLButtonElement;
    this.element.type = 'button';
    this.element.addEventListener('click', () => {
      this.element.blur();
      onRecenter();
    });
  }
}
