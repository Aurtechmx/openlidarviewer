/**
 * scanTypeControl.ts
 *
 * A compact, reusable "Treat as" control: the manual scan-type override the
 * user reaches from BOTH the Object/Space panel and the terrain Analyse panel.
 * A single builder keeps the two placements wired to the same state and styling
 * rather than duplicating the markup and listeners.
 *
 * The control offers four options — Auto / Terrain / Object / Interior — and is
 * honest about what it does: when an override is active it shows a subtle
 * "(manual)" note so it's clear auto-detection was overridden, and its title
 * reflects the current effective type.
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
   * Reflect the current override + the effective route in the control: select
   * the right option, show/hide the "(manual)" note, and stamp the title.
   */
  set(override: ScanTypeOverride, effective: SpaceKind | null): void;
}

const OPTIONS: ReadonlyArray<{ value: ScanTypeOverride; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'terrain', label: 'Terrain' },
  { value: 'object', label: 'Object' },
  { value: 'interior', label: 'Interior' },
];

const EFFECTIVE_LABEL: Record<SpaceKind, string> = {
  terrain: 'Terrain',
  object: 'Object',
  interior: 'Interior',
};

/** Build the "Treat as" override control wired to the host's `onChange`. */
export function createScanTypeControl(opts: ScanTypeControlOptions): ScanTypeControl {
  const root = document.createElement('div');
  root.className = 'olv-scan-type';

  const label = document.createElement('label');
  label.className = 'olv-scan-type-label';
  label.textContent = 'Treat as';

  const select = document.createElement('select') as HTMLSelectElement;
  select.className = 'olv-scan-type-select';
  for (const o of OPTIONS) {
    const opt = document.createElement('option') as HTMLOptionElement;
    opt.value = o.value;
    opt.textContent = o.label;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    opts.onChange(select.value as ScanTypeOverride);
  });
  label.append(select);

  const note = document.createElement('span');
  note.className = 'olv-scan-type-note olv-hidden';
  note.textContent = '(manual)';

  root.append(label, note);

  function set(override: ScanTypeOverride, effective: SpaceKind | null): void {
    select.value = override;
    const manual = override !== 'auto';
    note.classList.toggle('olv-hidden', !manual);
    const eff = effective ? EFFECTIVE_LABEL[effective] : 'detecting…';
    select.title = manual
      ? `Treated as ${eff} (manual override of auto-detection).`
      : `Auto-detected as ${eff}. Override here if it's wrong.`;
  }

  set('auto', null);
  return { element: root, set };
}
