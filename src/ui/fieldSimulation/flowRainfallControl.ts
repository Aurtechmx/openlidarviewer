/**
 * flowRainfallControl.ts — the Flow Pulse Lab's rainfall intensity and runoff
 * coefficient controls.
 *
 * Two sliders and a preset picker: rainfall intensity in mm/h (1 to 200,
 * default 25) and the rational method's runoff coefficient C (0.05 to 1),
 * with presets that are midpoints of published ranges. The control only
 * reports the setting; the Lab turns it into peak flows and the drawn network
 * (see `rationalDischarge.ts`). A line under the sliders says what the map
 * draws at this setting, or that the estimate is withheld.
 */

import { el } from '../dom';
import {
  RAINFALL_MAX_MM_H, RAINFALL_MIN_MM_H, RAINFALL_STEP_MM_H, RUNOFF_C_MAX, RUNOFF_C_MIN, RUNOFF_C_STEP,
  RUNOFF_PRESETS, clampRainfall, formatRunoffC, presetOf, type RainfallSetting,
} from '../../simulation/flowPulse/rationalDischarge';

export interface RainfallControl {
  readonly element: HTMLElement;
  /** The setting on the sliders now. */
  setting(): RainfallSetting;
  /** Show what the map draws at this setting, or that the estimate is withheld. */
  setNote(text: string, withheld: boolean): void;
}

const CUSTOM = 'custom';

/** A labelled range input with its value read out beside it. */
function slider(
  label: string, aria: string, tip: string, min: number, max: number, step: number, value: number,
): { row: HTMLElement; input: HTMLInputElement; out: HTMLElement } {
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'olv-flow-rain-slider';
  input.setAttribute('aria-label', aria);
  input.setAttribute('data-tip', tip);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el('output', { className: 'olv-flow-rain-value' });
  const row = el('label', { className: 'olv-flow-rain-row' }, [
    el('span', { className: 'olv-flow-rain-label', text: label }),
    input,
    out,
  ]);
  return { row, input, out };
}

/** Build the control; `onChange` runs on every slider or picker move. */
export function buildRainfallControl(initial: RainfallSetting, onChange: (s: RainfallSetting) => void): RainfallControl {
  let current = clampRainfall(initial);
  const intensity = slider(
    'Rainfall intensity', 'Rainfall intensity in millimetres per hour',
    'Rain falling evenly over the catchment, in mm per hour. Lines show where the estimated peak flow reaches 1 L/s.',
    RAINFALL_MIN_MM_H, RAINFALL_MAX_MM_H, RAINFALL_STEP_MM_H, current.intensityMmH,
  );
  const coefficient = slider(
    'Runoff coefficient C', 'Runoff coefficient C, the share of rain that becomes flow',
    'The share of rain that becomes flow; it lumps infiltration and other losses. Presets are midpoints of published ranges.',
    RUNOFF_C_MIN, RUNOFF_C_MAX, RUNOFF_C_STEP, current.runoffC,
  );
  const picker = document.createElement('select');
  picker.className = 'olv-flow-rain-preset';
  picker.setAttribute('aria-label', 'Ground cover preset for C');
  picker.setAttribute('data-tip', 'Pick a ground cover to set C to the midpoint of its published range.');
  for (const p of RUNOFF_PRESETS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.label} (C ${formatRunoffC(p.c)})`;
    picker.append(o);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM;
  custom.textContent = 'Custom C';
  picker.append(custom);
  const presetSource = el('p', { className: 'olv-flow-rain-source' });
  const note = el('p', { className: 'olv-flow-rain-note' });

  const sync = (): void => {
    intensity.out.textContent = `${Math.round(current.intensityMmH)} mm/h`;
    coefficient.out.textContent = `C ${formatRunoffC(current.runoffC)}`;
    const p = presetOf(current);
    picker.value = p ? p.id : CUSTOM;
    presetSource.textContent = p
      ? `${p.label}: C ${p.range[0]} to ${p.range[1]} (${p.source}); the midpoint is used.`
      : 'C set by hand.';
  };
  const commit = (next: RainfallSetting): void => {
    current = clampRainfall(next);
    sync();
    onChange(current);
  };

  intensity.input.addEventListener('input', () => commit({ ...current, intensityMmH: Number(intensity.input.value) }));
  coefficient.input.addEventListener('input', () => commit({ ...current, runoffC: Number(coefficient.input.value), presetId: null }));
  picker.addEventListener('change', () => {
    const p = RUNOFF_PRESETS.find((x) => x.id === picker.value);
    if (!p) { sync(); return; }
    coefficient.input.value = String(p.c);
    commit({ ...current, runoffC: p.c, presetId: p.id });
  });
  sync();

  const element = el('fieldset', { className: 'olv-flow-rain' }, [
    el('legend', { className: 'olv-flow-rain-title', text: 'Rainfall (peak-flow estimate)' }),
    intensity.row,
    el('div', { className: 'olv-flow-rain-row' }, [
      el('span', { className: 'olv-flow-rain-label', text: 'Ground cover' }),
      picker,
    ]),
    coefficient.row,
    presetSource,
    note,
  ]);

  return {
    element,
    setting: () => current,
    setNote(text, withheld) {
      note.textContent = text;
      note.dataset.withheld = withheld ? 'true' : 'false';
      intensity.input.disabled = withheld;
      coefficient.input.disabled = withheld;
      picker.disabled = withheld;
    },
  };
}
