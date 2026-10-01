/**
 * stateStrip.ts — the scientific state strip (COMMUNITY_SPEC §9).
 *
 * One row of labelled buttons across the foot of the viewport (desktop) or
 * above the dock (phone), shown while a scan is open. Each button states one
 * fact read through its provider and opens the place that explains it. The
 * strip renders a snapshot and derives nothing: the words below are the
 * provider's value or a fixed wording of its token. It raises no toast and no
 * modal (CE-STRIP-05); a caution shows as its state glyph beside the fact.
 */

import './stateStrip.css';
import { el } from './dom';
import { STATE_GLYPH, STATE_LABEL, type SciState } from './stateChip';
import { linearUnitLabel } from '../io/crs';
import type { StripSnapshot } from '../app/stateStrip/stripReads';
import type { Coverage } from '../process/ProcessPlan';

export type StripItemId = 'dataset' | 'crs' | 'vertical' | 'basis' | 'processing' | 'review';

export interface StateStripHost {
  /** Open the place that explains the item. */
  open(item: StripItemId): void;
}

export interface StateStrip {
  readonly element: HTMLElement;
  /** Repaint from a snapshot; null hides the strip. */
  render(snapshot: StripSnapshot | null): void;
}

const BASIS_TEXT: Readonly<Record<Coverage, string>> = {
  full: 'Full dataset',
  'resident-only': 'Resident only',
  sampled: 'Sampled',
};

const ITEM_NAME: Readonly<Record<StripItemId, string>> = {
  dataset: 'Dataset',
  crs: 'Horizontal CRS',
  vertical: 'Vertical reference',
  basis: 'Basis',
  processing: 'Processing',
  review: 'Review and blocked',
};

const ITEM_TARGET: Readonly<Record<StripItemId, string>> = {
  dataset: 'Opens Data',
  crs: 'Opens the coordinate system in Data',
  vertical: 'Opens the coordinate system in Data',
  basis: 'Opens Data',
  processing: 'Opens Analyse',
  review: 'Opens the Analyse list of affected items',
};

/** A caution worth a glyph on the strip: anything short of measured or info. */
function caution(v: SciState): boolean {
  return v !== 'measured' && v !== 'info';
}

export function createStateStrip(host: StateStripHost): StateStrip {
  const element = el('nav', { className: 'olv-state-strip olv-hidden', ariaLabel: 'Scan state' });
  const buttons = new Map<StripItemId, HTMLButtonElement>();
  const ids: StripItemId[] = ['dataset', 'crs', 'vertical', 'basis', 'processing', 'review'];
  for (const id of ids) {
    const b = el('button', { className: `olv-ss-item olv-ss-${id}`, type: 'button', tip: ITEM_TARGET[id] });
    b.dataset.item = id;
    b.addEventListener('click', () => host.open(id));
    buttons.set(id, b);
    element.append(b);
  }

  const paint = (id: StripItemId, text: string | null, validity: SciState | null, short?: string): void => {
    const b = buttons.get(id)!;
    const key = `${text}|${validity}|${short}`;
    if (b.dataset.key === key) return;
    b.dataset.key = key;
    if (text === null) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    const parts: Node[] = [];
    if (validity && caution(validity)) {
      const g = el('span', { className: `olv-ss-glyph is-${validity}`, text: STATE_GLYPH[validity] });
      g.setAttribute('aria-hidden', 'true');
      parts.push(g);
    }
    parts.push(el('span', { className: short ? 'olv-ss-text olv-ss-long' : 'olv-ss-text', text }));
    // The phone's compact row shows the short form of a long value.
    if (short) parts.push(el('span', { className: 'olv-ss-text olv-ss-short', text: short }));
    b.replaceChildren(...parts);
    b.dataset.validity = validity ?? '';
    const state = validity && caution(validity) ? ` (${STATE_LABEL[validity]})` : '';
    b.setAttribute('aria-label', `${ITEM_NAME[id]}: ${text}${state}. ${ITEM_TARGET[id]}`);
  };

  return {
    element,
    render(s) {
      element.classList.toggle('olv-hidden', s === null);
      if (!s) return;
      paint('dataset', s.dataset.value, s.dataset.validity);
      const h = s.horizontal;
      paint(
        'crs',
        h ? `${h.value.crsName} · ${linearUnitLabel(h.value.linearUnit)}${h.value.assertedBy ? ` · catalogue (${h.value.assertedBy})` : ''}` : null,
        h?.validity ?? null,
        h && h.value.epsg !== undefined ? `EPSG:${h.value.epsg} · ${linearUnitLabel(h.value.linearUnit)}` : undefined,
      );
      paint('vertical', s.vertical?.value.label ?? null, s.vertical?.validity ?? null);
      paint('basis', s.basis ? BASIS_TEXT[s.basis.value] : null, s.basis?.validity ?? null);
      const p = s.processing?.value;
      paint(
        'processing',
        !p ? null : p.state === 'idle' ? 'Idle' : `${p.label || 'Working'}${p.progress != null ? ` ${Math.round(p.progress * 100)}%` : ''}${p.more > 0 ? ` +${p.more}` : ''}`,
        null,
      );
      const r = s.review;
      paint('review', r ? (r.value.count === 0 ? 'Nothing to review' : `${r.value.count} to review`) : null, r?.validity ?? null);
    },
  };
}
