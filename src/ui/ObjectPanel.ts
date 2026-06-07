/**
 * ObjectPanel.ts
 *
 * The unified non-terrain panel, shown instead of the terrain Analyse panel
 * when a scan reads as a compact 3-D OBJECT or an INTERIOR space (a phone /
 * 360 / iPhone-LiDAR room) rather than a ground height field.
 *
 *   - interior → a room report: dimensions, floor area, ceiling height,
 *     enclosed volume, floor/wall/ceiling planes, storeys, capture quality;
 *   - object   → the object measurements (oriented box, envelope volume, scan
 *     resolution, completeness) plus capture quality.
 *
 * Both surface honest caveats and an escape hatch to run the terrain pipeline
 * anyway if the auto-detector got it wrong.
 */

import type { ObjectMetrics } from '../terrain/objectMetrics';
import type { SpaceMetrics } from '../terrain/spaceMetrics';
import {
  metresToFeet,
  sqMetresToSqFeet,
  cubicMetresToCubicFeet,
} from '../terrain/spaceMetrics';
import type { ScanShape } from '../terrain/scanShape';

export interface ObjectPanelCallbacks {
  /** Reveal + run the terrain pipeline despite the non-terrain verdict. */
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

const m1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—');
const i0 = (v: number): string => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
const cm = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} cm` : '—');
/** "12.3 m (40.4 ft)" — metres with feet in parentheses. */
const mft = (v: number): string =>
  Number.isFinite(v) ? `${v.toFixed(1)} m (${metresToFeet(v).toFixed(1)} ft)` : '—';
const areaMft = (v: number): string =>
  Number.isFinite(v) ? `${Math.round(v).toLocaleString()} m² (${Math.round(sqMetresToSqFeet(v)).toLocaleString()} ft²)` : '—';
const volMft = (v: number): string =>
  Number.isFinite(v) ? `${Math.round(v).toLocaleString()} m³ (${Math.round(cubicMetresToCubicFeet(v)).toLocaleString()} ft³)` : '—';

export class ObjectPanel {
  readonly element: HTMLElement;
  private readonly _cb: ObjectPanelCallbacks;
  private readonly _title: HTMLElement;
  private readonly _body: HTMLElement;

  constructor(cb: ObjectPanelCallbacks = {}) {
    this._cb = cb;
    this._title = el('div', { className: 'olv-mp-title', text: 'Object scan' });
    const head = el('div', { className: 'olv-panel-head' }, [this._title]);
    this._body = el('div', { className: 'olv-object-body' });
    this.element = el('aside', { className: 'olv-object-panel olv-hidden' }, [head, this._body]);
  }

  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  private _row(label: string, value: string, hint?: string): HTMLElement {
    return el('div', { className: 'olv-object-row' }, [
      el('span', { className: 'olv-object-label', text: label }),
      el('span', { className: 'olv-object-value', text: value, title: hint }),
    ]);
  }

  private _quality(q: SpaceMetrics['quality']): void {
    this._body.append(
      el('div', { className: 'olv-object-subhead', text: 'Capture quality' }),
      this._row('Points (used · source)', `${i0(q.sampledPointCount)} · ${i0(q.sourcePointCount)}`,
        'Points used for this analysis and the total they were sampled from.'),
      this._row('Density · spacing', `${q.densityPerM2.toFixed(1)} pts/m² · ~${cm(q.meanSpacingM)}`,
        'Approximate areal density and mean point spacing.'),
      this._row('Coverage', `${Math.round(q.coveragePct)}% of footprint`,
        'Share of the footprint with returns — completeness so far.'),
      this._row('Colour (RGB)', q.hasRgb ? 'Yes' : 'No'),
    );
  }

  private _caveats(reasons: ReadonlyArray<string>): void {
    for (const r of reasons) {
      this._body.append(el('div', { className: 'olv-object-note', text: r }));
    }
  }

  private _runAnywayButton(): void {
    const runBtn = el('button', {
      className: 'olv-object-run-anyway',
      text: 'Run terrain contours anyway',
      title: 'Treat this as a ground scan and run the DTM / contour pipeline.',
    }) as HTMLButtonElement;
    runBtn.type = 'button';
    runBtn.addEventListener('click', () => this._cb.onRunTerrainAnyway?.());
    this._body.append(runBtn);
  }

  /** Render the INTERIOR (room) report. */
  showSpace(space: SpaceMetrics | null, shape: ScanShape | null): void {
    this._title.textContent = 'Space scan';
    this._body.replaceChildren();
    if (!space) {
      this._body.append(el('div', { className: 'olv-object-note', text: 'No space measurements available.' }));
      this._runAnywayButton();
      return;
    }
    const d = space.dims;
    this._body.append(
      this._row('Dimensions (L×W×H)',
        `${m1(d.lengthM)} × ${m1(d.widthM)} × ${m1(d.heightM)} m`,
        `${metresToFeet(d.lengthM).toFixed(1)} × ${metresToFeet(d.widthM).toFixed(1)} × ${metresToFeet(d.heightM).toFixed(1)} ft`),
      this._row('Floor area', areaMft(space.floorAreaM2)),
      this._row('Ceiling height', space.ceilingHeightM != null ? mft(space.ceilingHeightM) : '—',
        'Floor→ceiling gap from the height histogram peaks.'),
      this._row('Enclosed volume', space.enclosedVolumeM3 != null ? volMft(space.enclosedVolumeM3) : '—',
        'Floor area × ceiling height — an envelope, not a watertight solid volume.'),
      this._row('Storeys / levels', i0(space.storyCount)),
    );
    this._body.append(el('div', { className: 'olv-object-subhead', text: 'Planes' }));
    const p = space.planes;
    this._body.append(
      this._row('Floor', p.floorPresent ? `Yes · ${areaMft(p.floorAreaM2 ?? NaN)}` : 'Not detected'),
      this._row('Ceiling', p.ceilingPresent ? `Yes · ${areaMft(p.ceilingAreaM2 ?? NaN)}` : 'Not detected'),
      this._row('Walls', `${Math.round(p.wallCoveragePct)}% coverage · ~${p.dominantWallDirections} direction(s)`,
        'Share of perimeter spanning most of the height; approximate dominant-wall count.'),
    );
    this._quality(space.quality);
    this._caveats(space.reasons);
    const why = shape && shape.reasons.length ? shape.reasons[0].replace(/\.$/, '') : 'interior space';
    this._body.append(el('div', {
      className: 'olv-object-note',
      text: `This looks like a ${why}. Terrain analysis — contours, slope, DTM — is for ground scans and would be misleading here.`,
    }));
    this._runAnywayButton();
  }

  /** Render the OBJECT measurements (with optional capture quality). */
  showObject(metrics: ObjectMetrics | null, space: SpaceMetrics | null, shape: ScanShape | null): void {
    this._title.textContent = 'Object scan';
    this._body.replaceChildren();
    if (!metrics) {
      this._body.append(el('div', { className: 'olv-object-note', text: 'No object measurements available.' }));
      this._runAnywayButton();
      return;
    }
    this._body.append(
      this._row('Dimensions (oriented)', `${m1(metrics.obb.lengthM)} × ${m1(metrics.obb.widthM)} × ${m1(metrics.obb.heightM)} m`,
        'Tight bounding box from the object’s own principal axes.'),
      this._row('Axis-aligned', `${m1(metrics.aabb.lengthM)} × ${m1(metrics.aabb.widthM)} × ${m1(metrics.aabb.heightM)} m`),
      this._row('Envelope volume', `${m1(metrics.envelopeVolumeM3)} m³`,
        'Bounding-box volume — an envelope, not a watertight solid volume.'),
      this._row('Points · spacing', `${metrics.pointCount.toLocaleString()} · ~${cm(metrics.medianSpacingM)}`),
      this._row('Scan completeness', `${Math.round(metrics.completenessPct)}% of directions`,
        'Share of viewing directions around the object that have returns.'),
    );
    if (metrics.completenessPct < 65) {
      this._body.append(el('div', {
        className: 'olv-object-note is-warn',
        text: 'Parts of the surface (often the underside / occluded sides) were not captured.',
      }));
    }
    if (space) {
      this._quality(space.quality);
      this._caveats(space.reasons);
    }
    const why = shape && shape.reasons.length ? ` (${shape.reasons[0].replace(/\.$/, '')})` : '';
    this._body.append(el('div', {
      className: 'olv-object-note',
      text: `This looks like an object${why}. Terrain analysis — contours, slope, DTM — is for ground scans and would be misleading here.`,
    }));
    this._runAnywayButton();
  }

  /** Back-compat shim — render object metrics only. */
  update(metrics: ObjectMetrics | null, shape: ScanShape | null): void {
    this.showObject(metrics, null, shape);
  }
}
