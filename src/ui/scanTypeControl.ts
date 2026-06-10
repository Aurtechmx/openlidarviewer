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
 * clear auto-detection was overridden, and `Auto` shows the detected type in its
 * title.
 */

import type { SpaceKind } from '../terrain/scanShape';
import type { ScanTypeOverride } from '../terrain/scanRoute';

export interface ScanTypeControlOptions {
  /** Fired when the user picks an option. The host owns the override state. */
  onChange: (override: ScanTypeOverride) => void;
}

export interface ScanTypeControl {
  /** The control root — append into either panel. */
  readonly element: HTMLElement;
  /**
   * Reflect the current override + the effective route in the control: highlight
   * the active segment, show/hide the "(manual)" note, and stamp the titles.
   */
  set(override: ScanTypeOverride, effective: SpaceKind | null): void;
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
    btn.addEventListener('click', () => opts.onChange(o.value));
    buttons.set(o.value, btn);
    group.append(btn);
  }

  root.append(head, group);

  function set(override: ScanTypeOverride, effective: SpaceKind | null): void {
    for (const [value, btn] of buttons) {
      const active = value === override;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const manual = override !== 'auto';
    note.classList.toggle('olv-hidden', !manual);
    const eff = effective ? EFFECTIVE_LABEL[effective] : 'detecting…';
    const autoBtn = buttons.get('auto');
    if (autoBtn) {
      autoBtn.title = manual
        ? `Auto-detection is overridden. Click to return to automatic (${eff}).`
        : `Auto-detected as ${eff}.`;
    }
    group.title = manual
      ? `Treated as ${eff} — manual override of auto-detection.`
      : `Auto-detected as ${eff}. Pick a type here if it's wrong.`;
  }

  set('auto', null);
  return { element: root, set };
}
