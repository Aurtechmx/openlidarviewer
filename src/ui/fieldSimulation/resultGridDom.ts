/**
 * resultGridDom.ts — the DOM scaffold `FlowResultGrid` and
 * `TerrainAccessResultGrid` both build: a focusable, `role="application"`
 * canvas with an aria-label, a plain-text status line below it, wrapped in
 * one container, with click/keydown wired to the caller's handlers.
 *
 * Extracted because the two result grids built this identically, differing
 * only in the three CSS class names (Sonar-flagged duplication); the pixel
 * drawing and cell-description logic each keeps is NOT here — this is
 * scaffold only.
 */

export interface ResultGridDomOptions {
  readonly ariaLabel: string;
  readonly wrapClassName: string;
  readonly canvasClassName: string;
  readonly statusClassName: string;
  readonly onClick: (e: MouseEvent) => void;
  readonly onKeyDown: (e: KeyboardEvent) => void;
}

export interface ResultGridDom {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly status: HTMLElement;
}

export function buildResultGridDom(opts: ResultGridDomOptions): ResultGridDom {
  const canvas = document.createElement('canvas');
  canvas.className = opts.canvasClassName;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', opts.ariaLabel);

  const status = document.createElement('div');
  status.className = opts.statusClassName;

  const element = document.createElement('div');
  element.className = opts.wrapClassName;
  element.append(canvas, status);

  canvas.addEventListener('click', opts.onClick);
  canvas.addEventListener('keydown', opts.onKeyDown);

  return { element, canvas, status };
}
