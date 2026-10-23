/**
 * labGuide.ts
 *
 * The small DOM pieces the three labs share so a first-time reader can find
 * their way: the purpose line with numbered stages, the readiness checklist,
 * the missing-ground-surface notice, the progress shown while terrain runs
 * first, the one status chip that folds every caveat, the one collapsed
 * "Details" section, a glyph-and-text legend, a "How to read this" note and a
 * collapsed "Method details" section. Presentation only: nothing here reads
 * or changes a run.
 */
import { el } from './dom';
import { showBusyScan } from './busyScan';
import { LAB_NAME, LAB_PURPOSE, LAB_STAGES, NEEDS_GROUND, type LabId, type ReadinessItem } from '../process/labGuideCopy';
import { labPageStatus, onLabPageStatus } from './labSurface';

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
    const run = el('button', { className: 'olv-lab-fix', type: 'button', text: 'Run terrain analysis', tip: 'Build the ground surface from this scan. The lab opens when it is done.' });
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

/**
 * Method IDs, digests and internal IDs, kept but collapsed. `flat` writes
 * them as a plain section instead, for a card that already sits inside a
 * collapsed Details (no accordion inside another, UX-D4).
 */
export function methodDetails(children: readonly HTMLElement[], flat = false): HTMLElement {
  if (flat) {
    return el('section', { className: 'olv-lab-method is-flat' }, [
      el('p', { className: 'olv-lab-method-summary', text: 'Method details' }),
      ...children,
    ]);
  }
  return el('details', { className: 'olv-lab-method' }, [
    el('summary', { className: 'olv-lab-method-summary', text: 'Method details' }),
    ...children,
  ]);
}

/** Shown on the lab's page while the terrain run it needs builds the ground surface. */
export function preparingGround(lab: LabId): HTMLElement {
  const line = el('p', { className: 'olv-lab-preparing-line' });
  line.setAttribute('role', 'status');
  showBusyScan(line, 'Building the ground surface…', 'emblem');
  return el('div', { className: 'olv-lab-preparing' }, [
    line,
    el('p', { className: 'olv-lab-preparing-note', text: `Terrain analysis runs once per scan. ${LAB_NAME[lab]} opens when it is done.` }),
  ]);
}

/** The one "Details" disclosure under a result: method, limitations and reading notes. */
export function labDetails(children: readonly HTMLElement[]): HTMLElement {
  return el('details', { className: 'olv-lab-details' }, [
    el('summary', { className: 'olv-lab-details-summary', text: 'Details' }),
    el('div', { className: 'olv-lab-details-body' }, [...children]),
  ]);
}

export type ChipTone = 'ready' | 'review' | 'blocked';

/** What the lab itself knows about its result, for {@link statusChip}. */
export interface ChipFacts {
  readonly tone: ChipTone;
  /** A few words, e.g. "Illustration only · 53% interpolated". */
  readonly summary: string;
  /** Every caveat behind the summary, shown when the chip is opened. */
  readonly lines: readonly HTMLElement[];
}

const TONE_RANK: Readonly<Record<string, number>> = { ready: 0, review: 1, needs: 2, blocked: 2 };
const TONE_LABEL: Readonly<Record<ChipTone, string>> = { ready: 'Ready', review: 'Review', blocked: 'Blocked' };

/**
 * The lab's one status line: a badge and a few words that open, on click or
 * tap, to every caveat behind them. The more restrictive of the lab's own
 * facts and the Analyse home's row picks the badge; both reasons are inside.
 */
export function statusChip(lab: LabId): { element: HTMLElement; set: (f: ChipFacts) => void; dispose: () => void } {
  const badge = el('span', { className: 'olv-ah-badge' });
  const text = el('span', { className: 'olv-lab-chip-text' });
  const pageReason = el('p', { className: 'olv-lab-chip-reason' });
  const lines = el('div', { className: 'olv-lab-chip-lines' });
  const details = el('details', { className: 'olv-lab-chip' }, [
    el('summary', { className: 'olv-lab-chip-summary' }, [badge, text]),
    el('div', { className: 'olv-lab-chip-body' }, [pageReason, lines]),
  ]);
  // A closed <details> hides its body from assistive tech, so the live line sits beside it.
  const live = el('span', { className: 'olv-visually-hidden' });
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  let facts: ChipFacts = { tone: 'ready', summary: '', lines: [] };
  const paint = (): void => {
    const page = labPageStatus(lab);
    const pageRank = page ? TONE_RANK[page.tone] ?? 0 : -1;
    const usePage = !!page && pageRank >= TONE_RANK[facts.tone];
    const tone = usePage ? page.tone : facts.tone;
    const label = usePage ? page.badge : TONE_LABEL[facts.tone];
    details.className = `olv-lab-chip is-${tone}`;
    badge.className = `olv-ah-badge is-${tone}`;
    badge.textContent = label;
    // The words follow the badge: the home row's reason when it is the stricter.
    text.textContent = (pageRank > TONE_RANK[facts.tone] ? page?.reason : facts.summary) || page?.reason || '';
    pageReason.textContent = page?.reason ?? '';
    pageReason.hidden = !page?.reason || page.reason === text.textContent;
    lines.replaceChildren(...facts.lines);
    live.textContent = `${label}: ${text.textContent}`;
  };
  const off = onLabPageStatus(paint);
  return {
    element: el('div', { className: 'olv-lab-chip-wrap' }, [details, live]),
    set: (f) => { facts = f; paint(); },
    dispose: off,
  };
}
