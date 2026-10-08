/**
 * workplanePanel.ts
 *
 * The reference plane's settings, inside the View panel's "Reference plane"
 * section: orientation, origin, elevation, spacing, the picks that place the
 * plane, and the readout. Loaded with the plane's chunk the first time the
 * plane is turned on or its section is opened.
 *
 * Every number sits beside its unit, and the panel states what the plane is
 * not: it is a reference drawn at a chosen elevation, not measured terrain.
 */

import { el } from './dom';
import type { WorkplaneController, WorkplaneView } from '../app/workplaneController';
import { formatCoord, formatStep, spacingUnit } from '../render/workplane/workplaneReadout';

export interface WorkplanePanel {
  render(view: WorkplaneView): void;
}

let fieldSeq = 0;

/** A labelled number field: label, input, unit. */
function numberField(label: string, tip: string): { row: HTMLElement; input: HTMLInputElement; unit: HTMLElement } {
  const id = `olv-refplane-field-${++fieldSeq}`;
  const input = el('input', { className: 'olv-refplane-input', type: 'number', title: tip }) as HTMLInputElement;
  input.id = id;
  input.step = 'any';
  input.inputMode = 'decimal';
  const lab = el('label', { className: 'olv-render-label', text: label });
  lab.htmlFor = id;
  const unit = el('span', { className: 'olv-refplane-unit' });
  return { row: el('div', { className: 'olv-refplane-row' }, [lab, input, unit]), input, unit };
}

/** Read a number field; NaN when it is empty or not a number. */
const readNumber = (input: HTMLInputElement): number => (input.value.trim() === '' ? NaN : Number(input.value));

/** Write a field unless the user is editing it. */
function setField(input: HTMLInputElement, value: number | null, format: (v: number) => string): void {
  if (document.activeElement === input) return;
  input.value = value === null ? '' : format(value);
}

export function createWorkplanePanel(host: HTMLElement, controller: WorkplaneController): WorkplanePanel {
  const honesty = el('p', { className: 'olv-refplane-honesty', text: 'Reference plane, not measured terrain.' });

  const orientation = el('select', {
    className: 'olv-report-select',
    title: 'Which way the plane faces: level, upright along an axis, or through three points you pick',
  }) as HTMLSelectElement;
  orientation.id = `olv-refplane-orientation-${++fieldSeq}`;
  const orientationLabel = el('label', { className: 'olv-render-label', text: 'Orientation' });
  orientationLabel.htmlFor = orientation.id;
  const options: Array<[string, string]> = [
    ['horizontal', 'Horizontal'],
    ['vertical-x', 'Vertical, along X'],
    ['vertical-north', 'Vertical, along Y'],
    ['three-point', 'Through 3 picked points'],
  ];
  for (const [value, text] of options) {
    const o = el('option', { text });
    o.value = value;
    orientation.append(o);
  }
  orientation.addEventListener('change', () => {
    if (orientation.value === 'three-point') controller.beginPick('three-point');
    else controller.setOrientation(orientation.value as 'horizontal' | 'vertical-x' | 'vertical-north');
  });

  const east = numberField('Origin X', 'Origin on the first horizontal axis, in source coordinates');
  const north = numberField('Origin Y', 'Origin on the second horizontal axis, in source coordinates');
  const elevation = numberField('Elevation', 'Elevation of the plane at its origin, in source vertical units');
  const commitOrigin = (): void => controller.setOriginH(readNumber(east.input), readNumber(north.input));
  east.input.addEventListener('change', commitOrigin);
  north.input.addEventListener('change', commitOrigin);
  elevation.input.addEventListener('change', () => controller.setElevation(readNumber(elevation.input)));

  const pickOrigin = el('button', {
    className: 'olv-chip',
    type: 'button',
    text: 'Use picked point',
    title: 'Click a point on the scan to set the origin and elevation from it',
  });
  pickOrigin.addEventListener('click', () => controller.beginPick('origin'));
  const scanCentre = el('button', {
    className: 'olv-chip',
    type: 'button',
    text: 'Use scan centre',
    title: 'Put the horizontal origin at the centre of the scan, rounded to the grid',
  });
  scanCentre.addEventListener('click', () => controller.useScanCentre());
  const scanMin = el('button', {
    className: 'olv-chip',
    type: 'button',
    text: 'Use scan minimum',
    title: 'Set the elevation to the lowest point in the scan. That point is not ground.',
  });
  scanMin.addEventListener('click', () => controller.useScanMinimum());
  const pickThree = el('button', {
    className: 'olv-chip',
    type: 'button',
    text: 'Pick 3 points',
    title: 'Click three points on the scan; the plane passes through them exactly',
  });
  pickThree.addEventListener('click', () => controller.beginPick('three-point'));
  const cancel = el('button', {
    className: 'olv-chip olv-hidden',
    type: 'button',
    text: 'Cancel picking',
    title: 'Stop picking points; the plane stays as it was (Esc does the same)',
  });
  cancel.addEventListener('click', () => controller.cancelPick());

  const spacingMode = el('select', {
    className: 'olv-report-select',
    title: 'Automatic spacing follows the zoom in 1, 2, 5 steps; fixed keeps the value you type',
  }) as HTMLSelectElement;
  spacingMode.id = `olv-refplane-spacing-${++fieldSeq}`;
  const spacingLabel = el('label', { className: 'olv-render-label', text: 'Spacing' });
  spacingLabel.htmlFor = spacingMode.id;
  for (const [value, text] of [['auto', 'Automatic'], ['fixed', 'Fixed']] as const) {
    const o = el('option', { text });
    o.value = value;
    spacingMode.append(o);
  }
  const fixed = numberField('Every', 'Fixed spacing between major lines, in the grid unit');
  fixed.input.min = '0';
  // "Fixed" chosen but no valid value typed yet: keep the field open for it.
  let pendingFixed = false;
  const commitSpacing = (): void => {
    pendingFixed = false;
    if (spacingMode.value === 'auto') {
      fixed.row.classList.add('olv-hidden');
      controller.setFixedSpacing(null);
      return;
    }
    fixed.row.classList.remove('olv-hidden');
    const v = readNumber(fixed.input);
    if (Number.isFinite(v) && v > 0) controller.setFixedSpacing(v);
    else {
      pendingFixed = true;
      fixed.input.focus();
    }
  };
  spacingMode.addEventListener('change', commitSpacing);
  fixed.input.addEventListener('change', commitSpacing);

  const status = el('p', { className: 'olv-refplane-status' });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const readout = el('ul', { className: 'olv-refplane-readout' });
  readout.setAttribute('aria-label', 'Reference plane readout');

  host.append(
    honesty,
    el('div', { className: 'olv-refplane-row' }, [orientationLabel, orientation]),
    east.row,
    north.row,
    elevation.row,
    el('div', { className: 'olv-chips' }, [pickOrigin, scanCentre, scanMin, pickThree, cancel]),
    el('div', { className: 'olv-refplane-row' }, [spacingLabel, spacingMode]),
    fixed.row,
    status,
    readout,
  );

  return {
    render(view) {
      const s = view.settings;
      host.dataset.drawn = view.drawn ? 'true' : 'false';
      host.dataset.gpuResources = String(view.liveResources);
      orientation.value = s.orientation;
      orientation.options[2].text = `Vertical, along ${view.axisNames[1]}`;
      east.row.querySelector('label')!.textContent = `Origin ${view.axisNames[0]}`;
      north.row.querySelector('label')!.textContent = `Origin ${view.axisNames[1]}`;
      east.unit.textContent = view.units.horizontal;
      north.unit.textContent = view.units.horizontal;
      elevation.unit.textContent = view.units.vertical;
      fixed.unit.textContent = spacingUnit(view.units, s.orientation);
      setField(east.input, view.originH?.[0] ?? null, formatCoord);
      setField(north.input, view.originH?.[1] ?? null, formatCoord);
      // On a three-point plane this is the plane's elevation at the origin, as the readout states.
      setField(elevation.input, view.elevation, formatCoord);
      // A three-point plane sets its own elevation at the origin.
      elevation.input.disabled = s.orientation === 'three-point';
      spacingMode.value = s.fixedSpacing !== null || pendingFixed ? 'fixed' : 'auto';
      fixed.row.classList.toggle('olv-hidden', spacingMode.value === 'auto');
      if (s.fixedSpacing !== null) setField(fixed.input, s.fixedSpacing, formatStep);
      cancel.classList.toggle('olv-hidden', view.picking === null);
      status.textContent = view.status ?? '';
      readout.replaceChildren(...view.readout.map((line) => el('li', { text: line })));
    },
  };
}
