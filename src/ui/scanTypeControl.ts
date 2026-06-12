/**
 * scanTypeControl.ts
 *
 * A compact, reusable "Treat scan as" control: the manual scan-type override the
 * user reaches from BOTH the Object/Space panel and the terrain Analyse panel.
 * A single builder keeps the two placements wired to the same state and styling
 * rather than duplicating the markup and listeners.
 *
 * Rendered as a VISIBLE segmented selector — Terrain · Object · Interior · Auto
 * — not a buried dropdown, so correcting a misdetected scan (common with iPhone
 * LiDAR and mixed datasets) is one obvious click. It is honest about what it
 * does: when an override is active it shows a subtle "(manual)" note so it's
 * clear auto-detection was overridden.
 *
 * While detection is still UNSETTLED (a streaming cloud mid-fill) `Auto` stays
 * the selected segment and the provisional verdict is only surfaced: the Auto
 * label reads "Auto (Interior)" and the detected pill carries a "detected"
 * dot + aria-description. Once the verdict SETTLES (static-load detection, or
 * the streaming settle one-shot) the host passes `detectionCommitted` and the
 * control soft-commits: the detected pill becomes the SELECTED one
 * (aria-pressed), still wearing its "detected" dot so the auto-detected origin
 * stays visible, and Auto reverts to a plain pill whose click re-runs
 * detection. A commit is detection-sourced — never a manual override (no
 * "(manual)" note), never pinned, reset to Auto on every new scan. v0.4.5.
 */

import type { SpaceKind } from '../terrain/scanShape';
import type { ScanTypeOverride } from '../terrain/scanRoute';

export interface ScanTypeControlOptions {
  /** Fired when the user picks an option. The host owns the override state. */
  onChange: (override: ScanTypeOverride) => void;
}

/**
 * Options the host has ruled out, each with its honest reason — e.g. 'terrain'
 * on a scan detection reads as an interior/object, where running contours
 * would be misleading. A disabled segment follows the codebase's
 * disabled-with-reason pattern (disabled + title/aria-disabled + a visible
 * reason line) and clicking it is a guarded no-op. The CURRENT override is
 * never locked out: a previously-forced choice must stay escapable, so the
 * active segment ignores its disabled entry.
 */
export type ScanTypeDisabledReasons = Partial<Record<ScanTypeOverride, string>>;

export interface ScanTypeControl {
  /** The control root — append into either panel. */
  readonly element: HTMLElement;
  /**
   * Reflect the current override + the effective route in the control: highlight
   * the active segment, show/hide the "(manual)" note, and stamp the titles.
   * `disabled` greys out the listed segments with their reasons (see
   * {@link ScanTypeDisabledReasons}); omitted ⇒ every segment is clickable.
   * `detectionCommitted` (only meaningful while `override === 'auto'` with a
   * resolved `effective`) soft-commits the display: the detected pill becomes
   * the selected segment (keeping its "detected" dot) instead of Auto — the
   * settled-verdict presentation. Internally the mode is still auto.
   */
  set(
    override: ScanTypeOverride,
    effective: SpaceKind | null,
    disabled?: ScanTypeDisabledReasons,
    detectionCommitted?: boolean,
  ): void;
}

const OPTIONS: ReadonlyArray<{ value: ScanTypeOverride; label: string }> = [
  { value: 'terrain', label: 'Terrain' },
  { value: 'object', label: 'Object' },
  { value: 'interior', label: 'Interior' },
  { value: 'auto', label: 'Auto' },
];

const EFFECTIVE_LABEL: Record<SpaceKind, string> = {
  terrain: 'Terrain',
  object: 'Object',
  interior: 'Interior',
};

/** Build the "Treat scan as" override control wired to the host's `onChange`. */
export function createScanTypeControl(opts: ScanTypeControlOptions): ScanTypeControl {
  const root = document.createElement('div');
  root.className = 'olv-scan-type';

  const label = document.createElement('span');
  label.className = 'olv-scan-type-label';
  label.textContent = 'Treat scan as';

  const note = document.createElement('span');
  note.className = 'olv-scan-type-note olv-hidden';
  note.textContent = '(manual)';

  const head = document.createElement('div');
  head.className = 'olv-scan-type-head';
  head.append(label, note);

  const group = document.createElement('div');
  group.className = 'olv-scan-type-seg';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Treat scan as');

  const buttons = new Map<ScanTypeOverride, HTMLButtonElement>();
  for (const o of OPTIONS) {
    const btn = document.createElement('button') as HTMLButtonElement;
    btn.type = 'button';
    btn.className = 'olv-scan-type-opt';
    btn.dataset.value = o.value;
    btn.textContent = o.label;
    btn.setAttribute('aria-pressed', 'false');
    // Guarded against the disabled state explicitly — the native `disabled`
    // attribute already blocks real clicks, but the guard keeps synthetic
    // clicks (tests, programmatic) honest too.
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      opts.onChange(o.value);
    });
    buttons.set(o.value, btn);
    group.append(btn);
  }

  // The visible "why is this greyed out" line — shown only while a segment is
  // disabled, so the reason is readable without hovering for the title.
  const reason = document.createElement('p');
  reason.className = 'olv-scan-type-reason olv-hidden';

  root.append(head, group, reason);

  function set(
    override: ScanTypeOverride,
    effective: SpaceKind | null,
    disabled?: ScanTypeDisabledReasons,
    detectionCommitted?: boolean,
  ): void {
    const manual = override !== 'auto';
    // Under Auto the effective route IS the detected verdict, so the resolved
    // type can be surfaced honestly: the matching pill gets a "detected" dot +
    // aria-description. Before the verdict settles, Auto stays the SELECTED
    // segment and its label reads "Auto (Interior)" etc — detection is shown,
    // never silently adopted. Once the host reports the verdict as SETTLED
    // (`detectionCommitted`), the detected pill becomes the selected segment
    // itself (soft commit): still detection-sourced (the dot stays, no
    // "(manual)" note), with Auto one click away to re-run detection.
    const detectedKind: SpaceKind | null = !manual ? effective : null;
    const committed = detectionCommitted === true && detectedKind !== null;
    const selected: ScanTypeOverride = manual ? override : committed ? detectedKind! : 'auto';
    let reasonText: string | null = null;
    for (const [value, btn] of buttons) {
      const active = value === selected;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      const isDetected = detectedKind !== null && value === detectedKind;
      btn.classList.toggle('is-detected', isDetected);
      if (isDetected) {
        btn.setAttribute(
          'aria-description',
          `Detected automatically — the scan currently reads as ${EFFECTIVE_LABEL[detectedKind!].toLowerCase()}.`,
        );
      } else {
        btn.removeAttribute('aria-description');
      }
      // Never lock out the CURRENT override — a previously-forced choice must
      // remain visible as the active state, and re-clicking it is harmless.
      const why = !active ? disabled?.[value] : undefined;
      const isDisabled = why != null;
      btn.disabled = isDisabled;
      btn.classList.toggle('is-disabled', isDisabled);
      btn.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
      btn.title = isDisabled ? why : '';
      if (isDisabled && reasonText === null) reasonText = why;
    }
    reason.textContent = reasonText ?? '';
    reason.classList.toggle('olv-hidden', reasonText === null);
    note.classList.toggle('olv-hidden', !manual);
    const eff = effective ? EFFECTIVE_LABEL[effective] : 'detecting…';
    const autoBtn = buttons.get('auto');
    if (autoBtn) {
      // The Auto pill carries the resolved verdict in its label only while it
      // is itself the selected segment (verdict still unsettled) — "Auto
      // (Interior)". After a commit the detected pill is selected, so Auto
      // reverts to a plain pill whose click re-runs detection; same under a
      // manual override (the override pill is the active one then).
      autoBtn.textContent =
        detectedKind !== null && !committed ? `Auto (${EFFECTIVE_LABEL[detectedKind]})` : 'Auto';
      autoBtn.title = manual
        ? `Auto-detection is overridden. Click to return to automatic (${eff}).`
        : committed
          ? `Detection settled on ${eff}. Click to re-run auto-detection.`
          : `Auto-detected as ${eff}.`;
    }
    group.title = manual
      ? `Treated as ${eff} — manual override of auto-detection.`
      : committed
        ? `Auto-detected as ${eff} — the detected type is selected. Pick a different type if it's wrong.`
        : `Auto-detected as ${eff}. Pick a type here if it's wrong.`;
  }

  set('auto', null);
  return { element: root, set };
}
