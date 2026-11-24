/**
 * sunShadingControl.ts: the Sun shading sliders under Colour by, Height.
 * Strength first; the sun's two sliders appear once it is above zero. The
 * module holds no state of its own: `show` reflects the controller.
 */

import { el } from '../dom';

export interface SunValues {
  readonly strength: number;
  readonly azimuthDeg: number;
  readonly altitudeDeg: number;
}

export interface SunShadingControl {
  readonly element: HTMLElement;
  show(s: { status: string; busy: boolean; enabled: boolean; settings: SunValues }): void;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** The eight-point name of an azimuth. */
export function compassName(azimuthDeg: number): string {
  return COMPASS[Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8];
}

interface Row {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  set(value: number, label: string, spoken: string): void;
}

function row(name: string, aria: string, tip: string, range: readonly [number, number, number], onInput: (v: number) => void): Row {
  const input = el('input', { type: 'range', className: 'olv-sun-slider', ariaLabel: aria, tip }) as HTMLInputElement;
  [input.min, input.max, input.step] = range.map(String);
  const label = el('span', { className: 'olv-sun-value' });
  input.addEventListener('input', () => { if (Number.isFinite(input.valueAsNumber)) onInput(input.valueAsNumber); });
  return {
    element: el('div', { className: 'olv-sun-row' }, [el('span', { className: 'olv-sun-name', text: name }), input, label]),
    input,
    set(value, text, spoken) {
      if (input.value !== String(value)) input.value = String(value);
      label.textContent = text;
      input.setAttribute('aria-valuetext', spoken);
    },
  };
}

export function createSunShadingControl(cb: {
  onChange(patch: Partial<SunValues>): void;
  onCancel(): void;
}): SunShadingControl {
  const strength = row('Sun shading', 'Sun shading strength (percent)',
    'Lights slopes as if from a low sun, with relief doubled, so ditches, banks and tracks show. Level ground and vegetation keep their ramp colour. Display only.',
    [0, 100, 5], (v) => cb.onChange({ strength: v / 100 }));
  const azimuth = row('Sun from', 'Sun direction (degrees clockwise from north)',
    'Where the light comes from, clockwise from the scan’s north axis.',
    [0, 355, 5], (v) => cb.onChange({ azimuthDeg: v }));
  const altitude = row('Sun height', 'Sun height above the horizon (degrees)',
    'A lower sun brings out gentler relief.',
    [5, 85, 5], (v) => cb.onChange({ altitudeDeg: v }));
  const status = el('span', { className: 'olv-sun-status' });
  status.setAttribute('role', 'status');
  const cancel = el('button', { className: 'olv-chip', text: 'Cancel', tip: 'Stop and switch sun shading off' });
  cancel.type = 'button';
  cancel.addEventListener('click', () => { cb.onCancel(); strength.input.focus(); });
  const foot = el('div', { className: 'olv-sun-row olv-hidden' }, [status, cancel]);

  return {
    element: el('div', { className: 'olv-sun' }, [strength.element, azimuth.element, altitude.element, foot]),
    show(s) {
      const pct = Math.round(s.settings.strength * 100);
      const az = Math.round(s.settings.azimuthDeg);
      const al = Math.round(s.settings.altitudeDeg);
      strength.set(pct, pct === 0 ? 'Off' : `${pct}%`, pct === 0 ? 'Off' : `${pct} percent`);
      azimuth.set(az, `${az}°`, `${az} degrees, ${compassName(az)}`);
      altitude.set(al, `${al}°`, `${al} degrees`);
      strength.input.disabled = !s.enabled;
      const sun = s.enabled && pct > 0;
      azimuth.element.classList.toggle('olv-hidden', !sun);
      altitude.element.classList.toggle('olv-hidden', !sun);
      if (status.textContent !== s.status) status.textContent = s.status;
      cancel.classList.toggle('olv-hidden', !s.busy);
      foot.classList.toggle('olv-hidden', s.status === '' && !s.busy);
    },
  };
}
