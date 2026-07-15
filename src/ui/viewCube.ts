/**
 * viewCube.ts — a tiny, lazy-loaded on-canvas compass / ViewCube gizmo.
 *
 * Lazy on purpose: it is only mounted when enabled, so none of this ships in the
 * startup shell. Styling is inline (themed through the app's CSS custom
 * properties) so the module is fully self-contained and adds nothing to the
 * eager stylesheet. Inline `style` attributes are permitted by the app CSP
 * (style-src allows unsafe-inline); no inline <script> is used.
 *
 * The pure geometry lives in `src/render/viewCubeMath.ts` and is unit-tested;
 * this file is the thin DOM renderer over it. The host supplies a `getHeading`
 * callback (camera heading in degrees) and an `onView` callback (snap to a
 * standard view), so the widget never imports the Viewer.
 */

import { COMPASS_FACES, roseRotationDeg, type StandardView } from '../render/viewCubeMath';

export interface ViewCubeOptions {
  /** Where to mount the gizmo. */
  readonly host: HTMLElement;
  /** Current camera heading in degrees [0,360); read each frame to spin the rose. */
  readonly getHeading: () => number;
  /** Snap the camera to a standard view (the toolbar's six axis views). */
  readonly onView: (view: StandardView) => void;
}

export interface ViewCubeHandle {
  /** Re-read the heading and rotate the rose. Call on camera change / per frame. */
  readonly update: () => void;
  /** Remove the gizmo and detach its listeners. */
  readonly dispose: () => void;
}

function faceButton(label: string, view: StandardView, onView: (v: StandardView) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-label', `View from ${label}`);
  b.setAttribute('data-testid', `viewcube-${label.toLowerCase()}`);
  b.style.cssText =
    'position:absolute;width:20px;height:20px;border:0;border-radius:50%;cursor:pointer;' +
    'font:600 11px/20px system-ui,sans-serif;color:var(--text);' +
    'background:var(--panel-raised);padding:0;';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onView(view);
  });
  return b;
}

/** Mount the compass gizmo. Returns a handle with `update()` and `dispose()`. */
export function mountViewCube(opts: ViewCubeOptions): ViewCubeHandle {
  const root = document.createElement('div');
  root.className = 'olv-viewcube';
  // Bottom-LEFT (above the dock): the Inspector is docked on the right
  // (right:14px, width:232px, z-index:15), so a right-side compass would sit
  // behind it and its snaps would be un-clickable. The left corner is clear of
  // the Inspector, the centred nav widget, and the bottom dock.
  root.style.cssText =
    'position:absolute;bottom:96px;left:18px;width:76px;height:76px;' +
    'border-radius:50%;background:var(--panel-recessive);' +
    'box-shadow:0 2px 10px rgba(0,0,0,0.35);z-index:12;pointer-events:auto;' +
    'backdrop-filter:blur(4px);';

  // The rotating rose: holds the four cardinals; counter-rotates with heading.
  const rose = document.createElement('div');
  rose.className = 'olv-viewcube-rose';
  rose.style.cssText =
    'position:absolute;inset:8px;border-radius:50%;border:1px solid var(--hairline);' +
    'transition:transform 120ms ease-out;';

  // Place each cardinal around the rose: N top, E right, S bottom, W left.
  const placements: Record<string, string> = {
    N: 'top:-2px;left:50%;transform:translateX(-50%);',
    E: 'right:-2px;top:50%;transform:translateY(-50%);',
    S: 'bottom:-2px;left:50%;transform:translateX(-50%);',
    W: 'left:-2px;top:50%;transform:translateY(-50%);',
  };
  for (const f of COMPASS_FACES) {
    const b = faceButton(f.label, f.view, opts.onView);
    b.style.cssText += placements[f.label] ?? '';
    // The N marker reads as the accent so "which way is north" is obvious.
    if (f.label === 'N') b.style.color = 'var(--accent)';
    rose.appendChild(b);
  }
  root.appendChild(rose);

  // A centre Top button — straight-down plan view, the most-used snap.
  const top = faceButton('⊤', 'top', opts.onView);
  top.textContent = '';
  top.setAttribute('aria-label', 'Top view');
  top.setAttribute('data-testid', 'viewcube-top');
  top.title = 'Top view';
  top.style.cssText +=
    'left:50%;top:50%;transform:translate(-50%,-50%);width:22px;height:22px;' +
    'background:var(--accent);';
  root.appendChild(top);

  opts.host.appendChild(root);

  const update = (): void => {
    rose.style.transform = `rotate(${roseRotationDeg(opts.getHeading())}deg)`;
  };
  update();

  return {
    update,
    dispose: () => {
      root.remove();
    },
  };
}
