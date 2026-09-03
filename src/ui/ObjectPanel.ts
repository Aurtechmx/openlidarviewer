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
 *     resolution, angular coverage) plus capture quality.
 *
 * Both surface honest caveats and an escape hatch to run the terrain pipeline
 * anyway if the auto-detector got it wrong.
 */

import {
  type ObjectMetrics,
  ANGULAR_COVERAGE_LABEL,
  ANGULAR_COVERAGE_HINT,
  OBJECT_ENVELOPE_VOLUME_HINT,
  OBJECT_SURFACE_AREA_HINT,
} from '../terrain/objectMetrics';
import type { SpaceMetrics } from '../terrain/spaceMetrics';
import {
  metresToFeet,
  sqMetresToSqFeet,
  cubicMetresToCubicFeet,
  magnitudeFixed,
} from '../terrain/spaceMetrics';
import type { ScanShape, SpaceKind } from '../terrain/scanShape';
import type { ScanTypeOverride } from '../terrain/scanRoute';
import type { SnapMode } from '../terrain/space/floorplan/vectorize';
// Type-only — the runtime helper (and the heavy extractor it reads) stay in the
// lazy floor-plan chunk; the panel only renders a struct the host computes there.
import type { FloorPlanConfidence } from '../terrain/space/floorplan/floorPlanConfidence';
import {
  createScanTypeControl,
  type ScanTypeControl,
  type ScanTypeDisabledReasons,
} from './scanTypeControl';

/**
 * The user-tunable subset of the floor-plan extraction settings, surfaced as a
 * compact control under the "Floor plan preview" button. The host reads this
 * back via {@link ObjectPanel.floorPlanOptions} and spreads it into BOTH the
 * standalone-SVG and embedded-PDF extract calls, so the two artifacts can never
 * disagree on the policy the user chose.
 *
 *   - `snapMode` — wall axis-snapping: 'auto' (snap only when the scan is
 *     genuinely rectilinear), 'strong' ("Square" — force the dominant axis
 *     pair), 'off' ("As-is" — leave directions exactly as traced);
 *   - `adaptiveBand` — let the wall-slice band widen/retry when the fixed band
 *     is too sparse, vs. pinning the fixed band.
 *
 * The defaults mirror main.ts FLOORPLAN_OPTIONS (the headless defaults this
 * control was plumbed against): snap 'auto', adaptive band on.
 */
export interface FloorPlanExportOptions {
  readonly snapMode: SnapMode;
  readonly adaptiveBand: boolean;
}

/** The control's default selections — must mirror main.ts FLOORPLAN_OPTIONS. */
export const FLOOR_PLAN_EXPORT_DEFAULTS: FloorPlanExportOptions = {
  snapMode: 'auto',
  adaptiveBand: true,
};

/** The three "Walls" segments, in display order, mapped to their snap modes. */
const WALL_SEGMENTS: ReadonlyArray<{
  readonly mode: SnapMode;
  readonly label: string;
  readonly title: string;
}> = [
  { mode: 'auto', label: 'Auto', title: 'Snap walls to right angles only when the scan is genuinely rectilinear (recommended).' },
  { mode: 'strong', label: 'Square', title: 'Force walls onto the dominant perpendicular axis pair — right angles may be assumed where the scan shows none.' },
  { mode: 'off', label: 'As-is', title: 'Leave wall directions exactly as traced — no axis snapping.' },
];

export interface ObjectPanelCallbacks {
  /** Reveal + run the terrain pipeline despite the non-terrain verdict. */
  onRunTerrainAnyway?: () => void;
  /** The user forced a scan type via the "Treat as" override. */
  onScanTypeChange?: (override: ScanTypeOverride) => void;
  /**
   * Build + download the Space / Object Report PDF for the current scan. Awaited
   * so the button can show a busy state; rejects/throws are surfaced as the
   * button's error state. Present for both interior and object scans.
   */
  onExportReport?: () => Promise<void>;
  /**
   * Build + download the interior FLOOR-PLAN sketch (SVG). Wired only for
   * interior scans (the button is rendered interior-only).
   */
  onExportFloorPlan?: () => Promise<void>;
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
// Object-scale variants — compact scans are routinely < 1 m² / < 1 m³, where
// the interior path's integer rounding would erase the figure. The precision
// follows the MAGNITUDE (magnitudeFixed): two decimals keep a sub-cubic-metre
// object readable, and a hundred-million-cubic-metre envelope stops claiming
// centimetre resolution it never had. Same exact metre→foot conversions.
const areaMftFine = (v: number): string =>
  Number.isFinite(v)
    ? `${magnitudeFixed(v, 2)} m² (${magnitudeFixed(sqMetresToSqFeet(v), 1)} ft²)`
    : '—';
const volMftFine = (v: number): string =>
  Number.isFinite(v)
    ? `${magnitudeFixed(v, 2)} m³ (${magnitudeFixed(cubicMetresToCubicFeet(v), 1)} ft³)`
    : '—';

/**
 * The unit-dependent value formatters for the OBJECT report, chosen once from
 * the scale the metrics were computed under.
 *
 * The panel used to stamp " m", " ft" and " cm" on every figure regardless of
 * the source frame. Two defects rode on that: a foot CRS was measured in feet
 * and labelled metres, and a scan whose linear unit never resolved was labelled
 * metres on nothing at all. The host now normalises KNOWN units to metres
 * before measuring; an UNKNOWN unit stays in the file's own units, and this
 * record drops the metric suffixes and the foot conversion for it. Same
 * approach as the report layout's UnitFormat (spaceReportLayout.ts).
 */
interface ObjectUnitFormat {
  /** L x W x H, the row value. */
  readonly triple: (l: number, w: number, h: number) => string;
  /** The row hint's leading conversion, empty when there is none. */
  readonly tripleHint: (l: number, w: number, h: number) => string;
  /** A single length. */
  readonly len: (v: number) => string;
  /** A fine area. */
  readonly areaFine: (v: number) => string;
  /** A fine volume. */
  readonly volFine: (v: number) => string;
  /** Mean / median point spacing. */
  readonly spacing: (v: number) => string;
  /** Areal point density. */
  readonly density: (v: number) => string;
}

/** Source-unit qualifiers: dimensionality without a metre claim. */
const SU = '(source units)';
const SU_SQ = '(square source units)';
const SU_CU = '(cubic source units)';

const METRIC_FORMAT: ObjectUnitFormat = {
  triple: (l, w, h) => `${m1(l)} × ${m1(w)} × ${m1(h)} m`,
  tripleHint: (l, w, h) =>
    `${metresToFeet(l).toFixed(1)} × ${metresToFeet(w).toFixed(1)} × ${metresToFeet(h).toFixed(1)} ft — `,
  len: mft,
  areaFine: areaMftFine,
  volFine: volMftFine,
  spacing: cm,
  density: (v) => (Number.isFinite(v) ? `${v.toFixed(1)} pts/m²` : '—'),
};

const SOURCE_FORMAT: ObjectUnitFormat = {
  triple: (l, w, h) => `${m1(l)} × ${m1(w)} × ${m1(h)}  ${SU}`,
  tripleHint: () => '',
  len: (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ${SU}` : '—'),
  areaFine: (v) => (Number.isFinite(v) ? `${magnitudeFixed(v, 2)} ${SU_SQ}` : '—'),
  volFine: (v) => (Number.isFinite(v) ? `${magnitudeFixed(v, 2)} ${SU_CU}` : '—'),
  spacing: (v) => (Number.isFinite(v) ? `${v.toFixed(3)} ${SU}` : '—'),
  density: (v) => (Number.isFinite(v) ? `${v.toFixed(1)} pts per square source unit` : '—'),
};

export class ObjectPanel {
  readonly element: HTMLElement;
  private readonly _cb: ObjectPanelCallbacks;
  private readonly _title: HTMLElement;
  private readonly _body: HTMLElement;
  private readonly _scanTypeControl: ScanTypeControl;
  // Current override + effective route + disabled-with-reason map, re-applied
  // on every render (the body is rebuilt each showSpace/showObject) so the
  // control never loses its state.
  private _scanTypeOverride: ScanTypeOverride = 'auto';
  private _scanTypeEffective: SpaceKind | null = null;
  private _scanTypeDisabled: ScanTypeDisabledReasons | undefined;
  private _scanTypeCommitted = false;
  // The floor-plan export options the user picked, held across body rebuilds
  // (showSpace re-renders the body each call). Seeded with the headless
  // defaults so an export before any interaction matches FLOORPLAN_OPTIONS.
  private _floorPlan: FloorPlanExportOptions = { ...FLOOR_PLAN_EXPORT_DEFAULTS };
  /**
   * The floor-plan confidence summary slot — empty until the host runs a
   * "Floor plan preview" export and feeds back the computed figures. Recreated
   * on each body rebuild, so a re-render clears a stale summary.
   */
  private _floorPlanSummaryEl: HTMLElement | null = null;

  constructor(cb: ObjectPanelCallbacks = {}) {
    this._cb = cb;
    this._title = el('div', { className: 'olv-mp-title', text: 'Object scan' });
    const head = el('div', { className: 'olv-panel-head' }, [this._title]);
    this._body = el('div', { className: 'olv-object-body' });
    this._scanTypeControl = createScanTypeControl({
      onChange: (o) => this._cb.onScanTypeChange?.(o),
    });
    this.element = el('aside', { className: 'olv-object-panel olv-hidden' }, [head, this._body]);
  }

  /**
   * Reflect the host's override + the effective route in the "Treat as"
   * control. `disabled` greys out segments the detection has ruled out (e.g.
   * Terrain on an interior/object scan) with their visible reasons — the
   * "Run terrain contours anyway" escape hatch below stays functional.
   */
  setScanType(
    override: ScanTypeOverride,
    effective: SpaceKind | null,
    disabled?: ScanTypeDisabledReasons,
    detectionCommitted?: boolean,
  ): void {
    this._scanTypeOverride = override;
    this._scanTypeEffective = effective;
    this._scanTypeDisabled = disabled;
    this._scanTypeCommitted = detectionCommitted === true;
    this._scanTypeControl.set(override, effective, disabled, detectionCommitted);
  }

  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  /**
   * The floor-plan export options the user currently has selected. The host
   * spreads this into the extractFloorPlan() call for BOTH the standalone SVG
   * and the report-embedded plan, so a single source of truth drives both
   * artifacts. Returns a copy so callers can't mutate internal state.
   */
  floorPlanOptions(): FloorPlanExportOptions {
    return { ...this._floorPlan };
  }

  private _row(label: string, value: string, hint?: string): HTMLElement {
    return el('div', { className: 'olv-object-row' }, [
      el('span', { className: 'olv-object-label', text: label }),
      el('span', { className: 'olv-object-value', text: value, title: hint }),
    ]);
  }

  private _quality(q: SpaceMetrics['quality'], f: ObjectUnitFormat = METRIC_FORMAT): void {
    this._body.append(
      el('div', { className: 'olv-object-subhead', text: 'Capture quality' }),
      // Named exactly as the report names them (spaceReportLayout
      // captureSection). The second number is the LOADED / resident population,
      // not the file's declared total, so neither surface calls it "source".
      this._row('Points (measured / loaded)', `${i0(q.sampledPointCount)} · ${i0(q.sourcePointCount)}`,
        'Points measured for this analysis and the loaded population they were sampled from.'),
      this._row('Density · spacing', `${f.density(q.densityPerM2)} · ~${f.spacing(q.meanSpacingM)}`,
        'Approximate areal density and mean point spacing.'),
      // HONESTY: coveragePct is occupied-cells / (cols*rows) over the scan's
      // axis-aligned BOUNDING-BOX grid (spaceMetrics.ts) — a fill ratio of the
      // extent, not of a traced footprint outline. Label + hint say exactly
      // that so the words match the computation (label==value).
      this._row('Bounding area filled', `${Math.round(q.coveragePct)}%`,
        'Share of the scan’s bounding-box footprint grid whose cells contain returns — a fill ratio of the extent, not of a measured room outline.'),
      this._row('Colour (RGB)', q.hasRgb ? 'Yes' : 'No'),
    );
  }

  /**
   * Render the honest caveats WITHOUT the orange wall-of-notes. WHY: every
   * `reasons` entry used to stack as its own `.olv-object-note`, so a normal
   * interior scan showed ~5 stacked notes ("Based on points currently
   * loaded…", "N stray returns excluded…", "Density scaled…", "Ceilings
   * sparsely captured…", "Wall and plane figures are pragmatic estimates…")
   * that ate the panel. The single most decision-critical line — the
   * "pragmatic estimates, not a certified survey" honesty statement — stays
   * visible; the remaining secondary caveats fold into ONE collapsed
   * <details> disclosure ("About these figures"). Nothing is removed: the
   * collapsed content is still in the DOM (selectors/e2e that assert a caveat
   * string is present keep passing), just tucked behind a real
   * <details>/<summary> (native a11y, keyboard, animates cleanly).
   */
  private _caveats(reasons: ReadonlyArray<string>): void {
    if (reasons.length === 0) return;
    // Pick the decision-critical headline. A genuine partial-stream "Preliminary
    // —" caveat wins outright (the figures are provisional on a partial load);
    // else the certified-survey honesty line (present for interiors); else the
    // first reason as a fallback.
    const partialIdx = reasons.findIndex((r) => r.startsWith('Preliminary —'));
    // An unverified-unit caveat is a whole-basis honesty flag (every metre figure
    // is an assumption), so it must be VISIBLE, not folded into the disclosure.
    // It outranks the standing "not a certified survey" line but yields to a
    // genuine partial-stream lead (provisional data trumps unit provenance).
    const unitIdx = reasons.findIndex((r) => r.startsWith('Coordinate units are unverified'));
    const certIdx = reasons.findIndex((r) => /not a certified survey/i.test(r));
    let leadIdx: number;
    if (partialIdx >= 0) {
      leadIdx = partialIdx;
    } else if (unitIdx >= 0) {
      leadIdx = unitIdx;
    } else if (certIdx >= 0) {
      leadIdx = certIdx;
    } else {
      leadIdx = 0;
    }
    const lead = reasons[leadIdx];
    const rest = reasons.filter((_, i) => i !== leadIdx);
    const isPreliminary = leadIdx === partialIdx && partialIdx >= 0;

    this._body.append(
      el('div', {
        className: `olv-object-note is-lead${isPreliminary ? ' is-preliminary' : ''}`,
        text: lead,
      }),
    );

    if (rest.length === 0) return;
    // ONE collapsed disclosure for the secondary caveats. Native
    // <details>/<summary> gives real keyboard + aria-expanded semantics for
    // free; the CSS animates the open/close. All `rest` strings live in the
    // DOM even while collapsed, so nothing is hidden from tests or AT users.
    const details = el('details', { className: 'olv-object-caveats' });
    details.append(
      el('summary', {
        className: 'olv-object-caveats-summary',
        text: `About these figures (${rest.length})`,
      }),
      ...rest.map((r) => el('div', { className: 'olv-object-note', text: r })),
    );
    this._body.append(details);
  }

  /**
   * The analysis-export row. A primary "Report PDF" button is ALWAYS offered;
   * "Floor plan preview" is offered ONLY for interior scans (`withFloorPlan`),
   * with the standing experimental note underneath. Mirrors
   * the AnalysePanel DEM/map buttons — the shared button styles, a lazy-loaded
   * builder behind a busy state, and a graceful error state on failure. The
   * point-cloud format converter is unaffected (it lives in the Export panel).
   */
  private _exportRow(withFloorPlan: boolean): void {
    const row = el('div', { className: 'olv-object-export' });

    const runAction = (
      btn: HTMLButtonElement,
      label: string,
      action: (() => Promise<void>) | undefined,
    ): void => {
      if (!action) return;
      btn.disabled = true;
      const prev = btn.textContent ?? label;
      btn.textContent = '…';
      void action()
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('OpenLiDARViewer: space/object export failed.', err);
          btn.textContent = 'Failed';
        })
        .finally(() => {
          btn.disabled = false;
          if (btn.textContent === '…') btn.textContent = prev;
          else if (btn.textContent === 'Failed') {
            setTimeout(() => { btn.textContent = label; }, 2000);
          }
        });
    };

    const reportBtn = el('button', {
      className: 'olv-object-dl is-primary',
      text: 'Report PDF',
      title: 'Download this scan’s measurements as a one-page report (PDF).',
    }) as HTMLButtonElement;
    reportBtn.type = 'button';
    reportBtn.addEventListener('click', () => runAction(reportBtn, 'Report PDF', this._cb.onExportReport));
    row.append(reportBtn);

    if (withFloorPlan) {
      const planBtn = el('button', {
        className: 'olv-object-dl',
        text: 'Floor plan preview',
        title: 'Download an approximate top-down wall-trace sketch (SVG) — not a measured floor plan.',
      }) as HTMLButtonElement;
      planBtn.type = 'button';
      planBtn.addEventListener('click', () => runAction(planBtn, 'Floor plan preview', this._cb.onExportFloorPlan));
      row.append(planBtn);
    }

    this._body.append(row);
    if (withFloorPlan) {
      // The compact options control for the preview export — wall snapping +
      // adaptive band — sits directly under the button it tunes.
      this._body.append(this._floorPlanOptionsRow());
      // The standing experimental hint for the preview export, in the panel's
      // note style (same vocabulary as the sheet and report carry).
      this._body.append(el('div', {
        className: 'olv-object-note',
        text: 'Floor plan preview is experimental — requires visual validation.',
      }));
      // Empty confidence slot — filled by showFloorPlanSummary() after the host
      // builds the preview, so the user gets a one-glance trust read.
      this._floorPlanSummaryEl = el('div', { className: 'olv-floorplan-confidence olv-hidden' });
      this._body.append(this._floorPlanSummaryEl);
    } else {
      this._floorPlanSummaryEl = null;
    }
  }

  /**
   * Render the floor-plan confidence summary after a "Floor plan preview" run.
   * The host computes {@link FloorPlanConfidence} inside the lazy floor-plan
   * chunk (where the extractor already lives) and hands the plain struct here,
   * so the panel never pulls the heavy floor-plan code into its own bundle.
   * Claim-accurate: rooms only when segmented, openings are classified doorways,
   * "weak wall evidence" is a boundary-sample statistic — never survey-grade.
   */
  showFloorPlanSummary(c: FloorPlanConfidence): void {
    const slot = this._floorPlanSummaryEl;
    if (!slot) return;
    const head = el('div', { className: 'olv-floorplan-confidence-head' }, [
      el('span', { className: 'olv-floorplan-confidence-label', text: 'Floor plan confidence' }),
      el('span', {
        className: `olv-floorplan-confidence-band is-${c.band}`,
        text: c.bandLabel,
      }),
    ]);
    const stats = el('div', { className: 'olv-floorplan-confidence-stats' }, [
      el('span', { text: `Rooms: ${c.roomsLabel}` }),
      el('span', { text: `Walls: ${c.walls}` }),
      el('span', { text: `Openings: ${c.openings}` }),
    ]);
    const weak = el('div', {
      className: 'olv-floorplan-confidence-weak',
      text: `Weak wall evidence: ${c.weakWallPct}%`,
    });
    slot.replaceChildren(head, stats, weak);
    slot.classList.remove('olv-hidden');
  }

  /**
   * The compact floor-plan EXPORT OPTIONS control: a 3-segment "Walls" picker
   * (Auto / Square / As-is → snap auto / strong / off) and an "Adaptive height"
   * toggle. Selections write straight into `_floorPlan`, which the host reads
   * via {@link floorPlanOptions} at export time — so both the SVG and the
   * report-embedded plan honour the same choice.
   *
   * a11y: the segments are real <input type="radio"> in a named group inside a
   * <fieldset>/<legend>, so the group is announced and arrow-key navigable; the
   * toggle is a real labelled <input type="checkbox">. The visible chips are the
   * <label>s — clicking text or chip both flip the underlying control.
   */
  private _floorPlanOptionsRow(): HTMLElement {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'olv-fp-options';

    const legend = document.createElement('legend');
    legend.className = 'olv-fp-options-legend';
    legend.textContent = 'Floor plan options';
    fieldset.append(legend);

    // ── Walls segmented control (radio group) ──
    const wallsRow = el('div', { className: 'olv-fp-opt-row' });
    wallsRow.append(el('span', { className: 'olv-fp-opt-label', text: 'Walls' }));
    const seg = document.createElement('div');
    seg.className = 'olv-fp-seg';
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Wall axis snapping');
    // Unique group name so multiple panel instances don't share radio state.
    const nonce = new Uint32Array(1);
    globalThis.crypto.getRandomValues(nonce);
    const groupName = `olv-fp-walls-${nonce[0].toString(36).padStart(7, '0')}`;
    for (const segDef of WALL_SEGMENTS) {
      const id = `${groupName}-${segDef.mode}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.id = id;
      input.className = 'olv-fp-seg-input';
      input.value = segDef.mode;
      input.checked = this._floorPlan.snapMode === segDef.mode;
      input.addEventListener('change', () => {
        if (input.checked) this._floorPlan = { ...this._floorPlan, snapMode: segDef.mode };
      });
      const label = document.createElement('label');
      label.className = 'olv-fp-seg-label';
      label.htmlFor = id;
      label.title = segDef.title;
      label.textContent = segDef.label;
      seg.append(input, label);
    }
    wallsRow.append(seg);
    fieldset.append(wallsRow);

    // ── Adaptive height toggle (checkbox) ──
    const toggle = document.createElement('label');
    toggle.className = 'olv-fp-toggle';
    toggle.title =
      'Let the wall-height slice widen and retry when the fixed band is too sparse, instead of pinning the fixed band.';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'olv-fp-toggle-input';
    check.checked = this._floorPlan.adaptiveBand;
    check.addEventListener('change', () => {
      this._floorPlan = { ...this._floorPlan, adaptiveBand: check.checked };
    });
    const toggleText = document.createElement('span');
    toggleText.className = 'olv-fp-toggle-text';
    toggleText.textContent = 'Adaptive height';
    toggle.append(check, toggleText);
    fieldset.append(toggle);

    return fieldset;
  }

  /** The "Treat as" override row — placed near the run-anyway escape hatch so
   *  fixing a misdetection is one obvious click. Re-applies the current state
   *  because the body is rebuilt on every render. */
  private _scanTypeRow(): void {
    this._scanTypeControl.set(
      this._scanTypeOverride,
      this._scanTypeEffective,
      this._scanTypeDisabled,
      this._scanTypeCommitted,
    );
    this._body.append(this._scanTypeControl.element);
  }

  private _runAnywayButton(): void {
    this._scanTypeRow();
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
      this._row('Floor', p.floorPresent ? `Yes · ${areaMft(p.floorAreaM2 ?? Number.NaN)}` : 'Not detected'),
      this._row('Ceiling', p.ceilingPresent ? `Yes · ${areaMft(p.ceilingAreaM2 ?? Number.NaN)}` : 'Not detected'),
      this._row('Walls', `${Math.round(p.wallCoveragePct)}% coverage · ~${p.dominantWallDirections} direction(s)`,
        'Share of perimeter spanning most of the height; approximate dominant-wall count.'),
    );
    this._quality(space.quality);
    this._caveats(space.reasons);
    // Interior export row: Report PDF + the interior-only Floor plan preview.
    this._exportRow(true);
    const why = shape?.reasons.length ? shape.reasons[0].replace(/\.$/, '') : 'interior space';
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
    const o = metrics.obb;
    const a = metrics.aabb;
    // The scale the figures were COMPUTED under, straight off the metrics the
    // CRS authority produced. A known unit was normalised to metres before
    // measuring; an unknown one was left in source units and is labelled so.
    // No space metrics (the back-compat shim) keeps the legacy metric render.
    const f = space && !space.linearUnit.known ? SOURCE_FORMAT : METRIC_FORMAT;
    this._body.append(
      this._row('Dimensions (oriented)', f.triple(o.lengthM, o.widthM, o.heightM),
        `${f.tripleHint(o.lengthM, o.widthM, o.heightM)}tight box from the object’s own principal axes.`),
      this._row('Largest dimension', f.len(metrics.longestDimensionM),
        'Longest side of the oriented box — the headline size figure.'),
      this._row('Axis-aligned', f.triple(a.lengthM, a.widthM, a.heightM),
        `${f.tripleHint(a.lengthM, a.widthM, a.heightM)}box aligned to the scan axes.`),
      this._row('Envelope volume', f.volFine(metrics.envelopeVolumeM3),
        OBJECT_ENVELOPE_VOLUME_HINT),
      this._row('Bounding surface area', f.areaFine(metrics.surfaceAreaM2),
        OBJECT_SURFACE_AREA_HINT),
      this._row('Points · spacing', `${metrics.pointCount.toLocaleString()} · ~${f.spacing(metrics.medianSpacingM)}`),
      // Was "Scan completeness", which read as capture completeness. The ratio
      // bins directions about the centroid, so its ceiling is the shape of the
      // point set, not how much of the object was scanned.
      this._row(ANGULAR_COVERAGE_LABEL, `${Math.round(metrics.completenessPct)}% of directions`,
        ANGULAR_COVERAGE_HINT),
    );
    if (space) {
      this._quality(space.quality, f);
      this._caveats(space.reasons);
    }
    // Object export row: Report PDF only (no floor plan for objects).
    this._exportRow(false);
    const why = shape?.reasons.length ? ` (${shape.reasons[0].replace(/\.$/, '')})` : '';
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
