/**
 * RecenterButton.ts — header control that frames the loaded scan.
 *
 * Invokes the same `Viewer.frameAll()` the navigation reset binding calls, so
 * the tween, target and easing are identical on both paths. Carries the
 * header ghost-button class; CSS hides it while `body` lacks `olv-has-scan`.
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
      className: 'olv-recenter',
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
