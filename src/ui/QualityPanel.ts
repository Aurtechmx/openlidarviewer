/**
 * QualityPanel.ts
 *
 * The body of the Speed ↔ Quality control: one slider, an Auto checkbox, a
 * readout of what the current position resolves to, and an Advanced disclosure
 * that still exposes every knob the slider drives, individually.
 *
 * LAZY. This module is reached through `loadQualityPanel()` on the first click
 * of the header button, so ~280 px of popover markup stays out of the startup
 * shell. What does NOT wait for a click is the policy and the apply: the
 * controller in `qualityControl.ts` resolves and applies the stored position
 * during boot, because a weak device must get its degraded display settings on
 * the first frame.
 *
 * The panel owns no policy and no state. It renders a
 * {@link QualityPreference} + the {@link QualitySettings} it resolved to, and
 * emits preference patches. Where the stops are, why a position resolves the
 * way it does, and what is deliberately NOT driven are all stated in
 * `src/render/quality/qualityPolicy.ts`.
 *
 * Advanced is additive. The Inspector's Rendering section and the Streaming
 * panel's Quality chips are untouched and keep working exactly as before.
 */

import { el, formatCount } from './dom';
import { collapsibleSection } from './collapsibleSection';
import {
  QUALITY_MAX,
  QUALITY_MIN,
  qualityLabelFor,
  type QualityOverrides,
  type QualityPreference,
  type QualitySettings,
  QUALITY_SCOPE_NOTE,
} from '../render/quality/qualityPolicy';
import {
  MAX_PIXEL_RATIO_DEFAULT,
  MAX_PIXEL_RATIO_MAX,
  MAX_PIXEL_RATIO_MIN,
} from '../render/quality/pixelRatioCeiling';
import type { StreamingQuality } from '../render/streaming/streamingBudget';
import {
  PRECISION_METHOD_NOTE,
  PRECISION_SCOPE,
  PRECISION_TOLERANCES,
  precisionCertificate,
  readPrecision,
  type PrecisionDeps,
} from '../app/precisionCheck';

/** The streaming presets, in slider order. */
const STREAMING_PRESETS: readonly StreamingQuality[] = ['low', 'balanced', 'high'];

/** The pixel-ratio ceilings the Advanced row offers, within the module bounds. */
const PIXEL_RATIO_CHOICES: readonly number[] = [
  MAX_PIXEL_RATIO_MIN,
  1.25,
  MAX_PIXEL_RATIO_DEFAULT,
  MAX_PIXEL_RATIO_MAX,
];

/** What the panel raises. The controller resolves and applies; the panel never does. */
export interface QualityPanelCallbacks {
  /**
   * REPLACE the named preference keys — a slider move, the Auto checkbox, or
   * "Follow the slider" handing the pinned set back as `{}`.
   */
  onPreference(patch: Partial<QualityPreference>): void;
  /**
   * MERGE one Advanced field into the pinned set. Separate from `onPreference`
   * because the panel holds no state: it knows the field the user just touched,
   * not the rest of the set, and a replace here would silently unpin the others.
   */
  onPin(field: QualityOverrides): void;
  /** The scene the precision check reads; without it the section is not shown. */
  readonly precision?: PrecisionDeps;
}

/** Title-case a preset id for a chip label. */
function presetLabel(preset: StreamingQuality): string {
  return preset[0].toUpperCase() + preset.slice(1);
}

/** A labelled row: caption on the left, control or value on the right. */
function row(label: string, control: Node): HTMLElement {
  return el('div', { className: 'olv-quality-row' }, [
    el('span', { className: 'olv-quality-row-label', text: label }),
    control,
  ]);
}

/** A checkbox with its label, wired to a handler. */
function checkboxRow(
  label: string,
  onToggle: (on: boolean) => void,
  extraClass = '',
): { readonly element: HTMLElement; readonly input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
  input.addEventListener('change', () => onToggle(input.checked));
  const element = el('label', { className: `olv-quality-check ${extraClass}`.trim() }, [
    input,
    el('span', { text: label }),
  ]);
  return { element, input };
}

export class QualityPanel {
  /** The popover root. The controller anchors it under the header button. */
  readonly element: HTMLElement;

  private readonly _callbacks: QualityPanelCallbacks;
  private readonly _slider: HTMLInputElement;
  private readonly _positionLabel: HTMLElement;
  private readonly _autoInput: HTMLInputElement;
  private readonly _summary: HTMLElement;
  private readonly _presetChips = new Map<StreamingQuality, HTMLButtonElement>();
  private readonly _ratioChips = new Map<number, HTMLButtonElement>();
  private readonly _edlInput: HTMLInputElement;
  private readonly _aaInput: HTMLInputElement;
  private readonly _followButton: HTMLButtonElement;
  private _tolerance: number = PRECISION_TOLERANCES[0].metres;
  private readonly _toleranceChips = new Map<number, HTMLButtonElement>();
  private readonly _precisionLine: HTMLElement;
  private readonly _precisionNote: HTMLElement;
  private readonly _copyButton: HTMLButtonElement;
  private _noteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: QualityPanelCallbacks) {
    this._callbacks = callbacks;

    this._slider = el('input', { type: 'range', className: 'olv-slider' }) as HTMLInputElement;
    this._slider.min = String(QUALITY_MIN);
    this._slider.max = String(QUALITY_MAX);
    this._slider.step = '1';
    this._slider.setAttribute('aria-label', 'Speed to quality');
    this._slider.addEventListener('input', () => {
      // Moving the slider is an explicit choice of position, so it leaves Auto.
      this._callbacks.onPreference({ auto: false, position: Number(this._slider.value) });
    });

    this._positionLabel = el('div', { className: 'olv-quality-position' });
    this._summary = el('div', { className: 'olv-quality-summary' });

    const auto = checkboxRow(
      'Auto',
      (on) => this._callbacks.onPreference({ auto: on }),
      'olv-quality-auto',
    );
    this._autoInput = auto.input;

    for (const preset of STREAMING_PRESETS) {
      const chip = el('button', {
        className: 'olv-chip', text: presetLabel(preset),
        title: 'Pin how much of a streamed scan is drawn. Turns off the automatic setting.',
      }) as HTMLButtonElement;
      chip.type = 'button';
      chip.addEventListener('click', () => this._pin({ streamingQuality: preset }));
      this._presetChips.set(preset, chip);
    }
    for (const ratio of PIXEL_RATIO_CHOICES) {
      const chip = el('button', {
        className: 'olv-chip', text: `${ratio}×`,
        title: 'How sharply the view is drawn. Higher is crisper on a retina screen and slower.',
      }) as HTMLButtonElement;
      chip.type = 'button';
      chip.addEventListener('click', () => this._pin({ maxPixelRatio: ratio }));
      this._ratioChips.set(ratio, chip);
    }

    const edl = checkboxRow('Eye Dome Lighting', (on) => this._pin({ edlEnabled: on }));
    this._edlInput = edl.input;
    const aa = checkboxRow('Antialiasing', (on) => this._pin({ antialiasing: on }));
    this._aaInput = aa.input;

    this._followButton = el('button', {
      className: 'olv-quality-follow',
      text: 'Follow the slider',
      tip: 'Clear the manual quality overrides and let the auto quality slider control rendering again.',
    }) as HTMLButtonElement;
    this._followButton.type = 'button';
    this._followButton.addEventListener('click', () => this._callbacks.onPreference({ overrides: {} }));

    // Precision at this view: the per-draw bound against a chosen tolerance,
    // and a certificate of it to copy (app/precisionCheck.ts).
    this._precisionLine = el('div', { className: 'olv-precision-line' });
    this._precisionLine.setAttribute('role', 'status');
    this._precisionLine.setAttribute('aria-live', 'polite');
    this._precisionNote = el('div', { className: 'olv-precision-note' });
    this._precisionNote.setAttribute('aria-live', 'polite');
    for (const t of PRECISION_TOLERANCES) {
      const chip = el('button', {
        className: 'olv-chip', text: t.label,
        title: `Check positions against a ${t.label} limit.`,
      }) as HTMLButtonElement;
      chip.type = 'button';
      chip.addEventListener('click', () => { this._tolerance = t.metres; this.refreshPrecision(); });
      this._toleranceChips.set(t.metres, chip);
    }
    const checkButton = el('button', {
      className: 'olv-precision-check', text: 'Check precision',
      tip: 'Bound each point’s rendering error against its reference position, computed in double precision from the stored coordinates, before projection.',
    }) as HTMLButtonElement;
    checkButton.type = 'button';
    checkButton.addEventListener('click', () => this.refreshPrecision());
    this._copyButton = el('button', {
      className: 'olv-precision-copy', text: 'Copy certificate',
      tip: 'Copy a record of this check: the bound, the limit, and the data, view and shader it covers.',
    }) as HTMLButtonElement;
    this._copyButton.type = 'button';
    this._copyButton.addEventListener('click', () => { void this._copyCertificate(); });
    const precisionSection = callbacks.precision
      ? el('section', { className: 'olv-precision' }, [
        el('div', { className: 'olv-quality-subtitle', text: 'Precision at this view' }),
        row('Limit', el('div', { className: 'olv-quality-chips' }, [...this._toleranceChips.values()])),
        this._precisionLine,
        el('div', { className: 'olv-precision-actions' }, [checkButton, this._copyButton]),
        this._precisionNote,
        el('p', { className: 'olv-quality-note', text: `${PRECISION_SCOPE} ${PRECISION_METHOD_NOTE}` }),
      ])
      : null;

    this.element = el('div', { className: 'olv-quality-pop' }, [
      el('div', { className: 'olv-quality-title', text: 'Performance' }),
      el('div', { className: 'olv-quality-track' }, [
        el('span', { className: 'olv-quality-end', text: 'Speed' }),
        this._slider,
        el('span', { className: 'olv-quality-end', text: 'Quality' }),
      ]),
      this._positionLabel,
      auto.element,
      this._summary,
      ...(precisionSection ? [precisionSection] : []),
      collapsibleSection(
        'Advanced',
        el('div', { className: 'olv-quality-advanced' }, [
          row('Streaming detail', el('div', { className: 'olv-quality-chips' }, [...this._presetChips.values()])),
          row('Render resolution', el('div', { className: 'olv-quality-chips' }, [...this._ratioChips.values()])),
          edl.element,
          aa.element,
          this._followButton,
        ]),
      ),
      el('p', { className: 'olv-quality-note', text: QUALITY_SCOPE_NOTE }),
    ]);
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Performance');
  }

  /** Paint every control from a preference and the settings it resolved to. */
  render(preference: QualityPreference, settings: QualitySettings): void {
    const pinned = Object.keys(preference.overrides).length > 0;

    this._slider.value = String(settings.position);
    this._slider.disabled = preference.auto;
    this._autoInput.checked = preference.auto;
    this._positionLabel.textContent = pinned
      ? `${qualityLabelFor(settings.position)} · adjusted`
      : qualityLabelFor(settings.position);

    this._summary.replaceChildren(
      row('Resolution', el('span', { text: `${settings.maxPixelRatio}× pixel ratio` })),
      row('Streaming budget', el('span', { text: `${formatCount(settings.streamingPointBudget)} points` })),
      row('Concurrent decodes', el('span', { text: String(settings.maxConcurrentDecodes) })),
    );

    for (const [preset, chip] of this._presetChips) {
      const active = preset === settings.streamingQuality;
      chip.classList.toggle('olv-chip-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    for (const [ratio, chip] of this._ratioChips) {
      const active = ratio === settings.maxPixelRatio;
      chip.classList.toggle('olv-chip-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    this._edlInput.checked = settings.edlEnabled;
    this._aaInput.checked = settings.antialiasing;
    this._followButton.disabled = !pinned;
  }

  /** Check the active scan at the current view against the chosen limit. */
  refreshPrecision(): void {
    const deps = this._callbacks.precision;
    if (!deps) return;
    for (const [metres, chip] of this._toleranceChips) {
      const active = metres === this._tolerance;
      chip.classList.toggle('olv-chip-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const reading = readPrecision(deps, this._tolerance);
    this._precisionLine.textContent = reading.line;
    this._precisionLine.dataset.state = reading.state;
    this._copyButton.disabled = reading.diagnostic === null;
  }

  /** Copy the certificate, or save it as a file where the clipboard is refused. */
  private async _copyCertificate(): Promise<void> {
    const deps = this._callbacks.precision;
    if (!deps) return;
    this.refreshPrecision();
    const json = precisionCertificate(deps, this._tolerance);
    if (!json) return;
    try {
      await navigator.clipboard.writeText(json);
      this._note('Certificate copied.');
    } catch {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = el('a', { href: url }) as HTMLAnchorElement;
      a.download = 'precision-certificate.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this._note('The clipboard was not available, so the certificate was saved as a file.');
    }
  }

  private _note(text: string): void {
    this._precisionNote.textContent = text;
    if (this._noteTimer !== null) clearTimeout(this._noteTimer);
    this._noteTimer = setTimeout(() => { this._precisionNote.textContent = ''; }, 4000);
  }

  /** Emit one pinned Advanced field for the controller to merge. */
  private _pin(field: QualityOverrides): void {
    this._callbacks.onPin(field);
  }
}
