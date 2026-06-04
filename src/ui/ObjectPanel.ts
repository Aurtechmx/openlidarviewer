/**
 * ObjectPanel.ts
 *
 * Shown instead of the terrain Analyse panel when a scan reads as a compact
 * 3-D OBJECT (a phone scan of a chair, a sculpture, a room) rather than a
 * ground height field. It surfaces the measurements that actually mean
 * something for an object — oriented dimensions, envelope volume, scan
 * resolution, and capture completeness — and offers an honest escape hatch to
 * run the terrain pipeline anyway if the detector got it wrong.
 */

import type { ObjectMetrics } from '../terrain/objectMetrics';
import type { ScanShape } from '../terrain/scanShape';

export interface ObjectPanelCallbacks {
  /** Reveal + run the terrain pipeline despite the object verdict. */
  onRunTerrainAnyway?: () => void;
}

function el(
  tag: string,
  opts: { className?: string; text?: string; title?: string } = {},
  children: Node[] = [],
): HTMLElement {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.title) node.title = opts.title;
  for (const c of children) node.append(c);
  return node;
}

export class ObjectPanel {
  readonly element: HTMLElement;
  private readonly _cb: ObjectPanelCallbacks;
  private readonly _body: HTMLElement;

  constructor(cb: ObjectPanelCallbacks = {}) {
    this._cb = cb;
    const title = el('div', { className: 'olv-mp-title', text: 'Object scan' });
    const head = el('div', { className: 'olv-panel-head' }, [title]);
    this._body = el('div', { className: 'olv-object-body' });
    this.element = el('aside', { className: 'olv-object-panel olv-hidden' }, [head, this._body]);
  }

  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  /** Render the object metrics (or a placeholder when none are available). */
  update(metrics: ObjectMetrics | null, shape: ScanShape | null): void {
    this._body.replaceChildren();
    if (!metrics) {
      this._body.append(el('div', { className: 'olv-object-note', text: 'No object measurements available.' }));
      return;
    }
    const m1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—');
    const cm = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} cm` : '—');

    const row = (label: string, value: string, hint?: string): HTMLElement =>
      el('div', { className: 'olv-object-row' }, [
        el('span', { className: 'olv-object-label', text: label }),
        el('span', { className: 'olv-object-value', text: value, title: hint }),
      ]);

    this._body.append(
      row('Dimensions (oriented)', `${m1(metrics.obb.lengthM)} × ${m1(metrics.obb.widthM)} × ${m1(metrics.obb.heightM)} m`,
        'Tight bounding box from the object’s own principal axes.'),
      row('Axis-aligned', `${m1(metrics.aabb.lengthM)} × ${m1(metrics.aabb.widthM)} × ${m1(metrics.aabb.heightM)} m`),
      row('Envelope volume', `${m1(metrics.envelopeVolumeM3)} m³`,
        'Bounding-box volume — an envelope, not a watertight solid volume.'),
      row('Points · spacing', `${metrics.pointCount.toLocaleString()} · ~${cm(metrics.medianSpacingM)}`),
      row('Scan completeness', `${Math.round(metrics.completenessPct)}% of directions`,
        'Share of viewing directions around the object that have returns.'),
    );
    if (metrics.completenessPct < 65) {
      this._body.append(el('div', {
        className: 'olv-object-note is-warn',
        text: 'Parts of the surface (often the underside / occluded sides) were not captured.',
      }));
    }

    // Honesty + escape hatch.
    const why = shape && shape.reasons.length ? ` (${shape.reasons[0].replace(/\.$/, '')})` : '';
    this._body.append(
      el('div', {
        className: 'olv-object-note',
        text: `This looks like an object${why}. Terrain analysis — contours, slope, DTM — is for ground scans and would be misleading here.`,
      }),
    );
    const runBtn = el('button', {
      className: 'olv-object-run-anyway',
      text: 'Run terrain contours anyway',
      title: 'Treat this as a ground scan and run the DTM / contour pipeline.',
    }) as HTMLButtonElement;
    runBtn.type = 'button';
    runBtn.addEventListener('click', () => this._cb.onRunTerrainAnyway?.());
    this._body.append(runBtn);
  }
}
