/**
 * labGuide.ts
 *
 * The small DOM pieces the three labs share so a first-time reader can find
 * their way: the purpose line with numbered stages, the readiness checklist,
 * the missing-ground-surface notice, a glyph-and-text legend, a "How to read
 * this" note and a collapsed "Method details" section. Presentation only:
 * nothing here reads or changes a run.
 */
import { el } from './dom';
import { LAB_PURPOSE, LAB_STAGES, NEEDS_GROUND, type LabId, type ReadinessItem } from '../process/labGuideCopy';

/** The lab's purpose line and its numbered stages; `setStage` moves the highlight (0-based). */
export function labHeader(lab: LabId, stage: number): { element: HTMLElement; setStage: (n: number) => void } {
  const steps = LAB_STAGES[lab].map((name, i) => el('li', { className: 'olv-lab-stage', text: `${i + 1}. ${name}` }));
  const list = el('ol', { className: 'olv-lab-stages', ariaLabel: 'Stages' }, steps);
  const setStage = (n: number): void => {
    steps.forEach((s, i) => {
      s.classList.toggle('is-current', i === n);
      s.classList.toggle('is-done', i < n);
      if (i === n) s.setAttribute('aria-current', 'step');
      else s.removeAttribute('aria-current');
    });
  };
  setStage(stage);
  const element = el('header', { className: 'olv-lab-head' }, [
    el('p', { className: 'olv-lab-purpose', text: LAB_PURPOSE[lab] }),
    list,
  ]);
  return { element, setStage };
}

/** One line under the stages that states only the next step. */
export function nextStep(text: string): HTMLElement {
  return el('p', { className: 'olv-lab-next', text });
}

/** The prerequisites, met or missing, each with a glyph and a sentence. */
export function readinessList(items: readonly ReadinessItem[]): HTMLElement {
  const rows = items.map((i) => {
    const state = i.met ? 'met' : i.pending ? 'pending' : i.blocking ? 'missing' : 'partial';
    const glyph = { met: '✓', pending: '…', missing: '✗', partial: '!' }[state];
    const li = el('li', { className: `olv-lab-ready is-${state}` }, [
      el('span', { className: 'olv-lab-ready-glyph', text: glyph }),
      el('span', { className: 'olv-lab-ready-label', text: `${i.label}: ` }),
      el('span', { className: 'olv-lab-ready-note', text: i.note }),
    ]);
    li.dataset.state = state;
    return li;
  });
  return el('ul', { className: 'olv-lab-readiness', ariaLabel: 'Before you start' }, rows);
}

/**
 * Shown in place of the lab's controls when the ground surface is missing:
 * plain text and, when the host can start one, the terrain run itself.
 */
export function needsGround(onRunTerrain: (() => void) | null): HTMLElement {
  const box = el('div', { className: 'olv-lab-needs' }, [el('p', { className: 'olv-lab-needs-text', text: NEEDS_GROUND })]);
  if (onRunTerrain) {
    const run = el('button', { className: 'olv-lab-fix', type: 'button', text: 'Run terrain analysis', tip: 'Build the ground surface from this scan. The Terrain page then offers the way back here.' });
    run.addEventListener('click', onRunTerrain);
    box.append(run);
  }
  return box;
}

export interface LegendItem {
  readonly glyph: string;
  readonly label: string;
  /** The colour the grid already draws for this item. */
  readonly color: string;
}

/** A legend: swatch, glyph and word per item, so colour never carries it alone. */
export function legend(title: string, items: readonly LegendItem[]): HTMLElement {
  const rows = items.map((i) => {
    const swatch = el('span', { className: 'olv-lab-swatch' });
    swatch.style.background = i.color;
    return el('li', { className: 'olv-lab-legend-item' }, [
      swatch,
      el('span', { className: 'olv-lab-legend-glyph', text: i.glyph }),
      el('span', { text: i.label }),
    ]);
  });
  return el('ul', { className: 'olv-lab-legend', ariaLabel: title }, rows);
}

/** Two to four plain lines on how to read a result. */
export function howToRead(lines: readonly string[]): HTMLElement {
  return el('div', { className: 'olv-lab-read' }, [
    el('p', { className: 'olv-lab-read-title', text: 'How to read this' }),
    ...lines.map((t) => el('p', { className: 'olv-lab-read-line', text: t })),
  ]);
}

/** Method IDs, digests and internal IDs, kept but collapsed. */
export function methodDetails(children: readonly HTMLElement[]): HTMLElement {
  return el('details', { className: 'olv-lab-method' }, [
    el('summary', { className: 'olv-lab-method-summary', text: 'Method details' }),
    ...children,
  ]);
}
