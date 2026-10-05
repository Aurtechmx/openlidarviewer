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
import { fullFileAvailability, reloadAvailability, reviewSampleTip, sampleActionLinks } from '../app/fullFileActions';
import { STATE_GLYPH, STATE_LABEL, type SciState } from './stateChip';
import { linearUnitLabel } from '../io/crs';
import { clipScopeText } from '../render/clip/clipScope';
import type { StripSnapshot } from '../app/stateStrip/stripReads';
import type { Coverage } from '../process/ProcessPlan';
import { formatWait, WAIT_SHOWN_AFTER_MS } from '../process/waitClock';

export type StripItemId = 'dataset' | 'crs' | 'vertical' | 'basis' | 'clip' | 'processing' | 'review';

export interface StateStripHost {
  /** Open the place that explains the item. */
  open(item: StripItemId): void;
}

export interface StateStrip {
  readonly element: HTMLElement;
  /** Repaint from a snapshot; null hides the strip. */
  render(snapshot: StripSnapshot | null): void;
  /** Stop measuring the strip and clear the height it published. */
  dispose(): void;
}

const BASIS_TEXT: Readonly<Record<Coverage, string>> = {
  full: 'Full dataset',
  'resident-only': 'Currently loaded points',
  sampled: 'Sampled',
  partial: 'Partial: truncated file',
};

const ITEM_NAME: Readonly<Record<StripItemId, string>> = {
  dataset: 'Dataset',
  crs: 'Horizontal CRS',
  vertical: 'Vertical reference',
  basis: 'Basis',
  clip: 'Clip box',
  processing: 'Processing',
  review: 'Review and blocked',
};

const ITEM_TARGET: Readonly<Record<StripItemId, string>> = {
  dataset: 'Opens Data',
  crs: 'Opens the coordinate system in Data',
  vertical: 'Opens the coordinate system in Data',
  basis: 'Opens Data',
  clip: 'Opens the Clip box',
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
  // The "Export all N points" action sits beside a sampled basis.
  const fullFileSlot = el('span', { className: 'olv-ss-fullfile' });
  let fullFileKey = '';
  const ids: StripItemId[] = ['dataset', 'crs', 'vertical', 'basis', 'clip', 'processing', 'review'];
  for (const id of ids) {
    const b = el('button', { className: `olv-ss-item olv-ss-${id}`, type: 'button', tip: ITEM_TARGET[id] });
    b.dataset.item = id;
    b.addEventListener('click', () => host.open(id));
    buttons.set(id, b);
    element.append(b);
    if (id === 'basis') element.append(fullFileSlot);
  }

  const paint = (id: StripItemId, text: string | null, validity: SciState | null, short?: string, wait?: string): void => {
    const b = buttons.get(id)!;
    const key = `${text}|${validity}|${short}|${wait}`;
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
    // The time a task has run sits in its own span that never shrinks, so a
    // long label is cut before it. It stays out of the accessible name: that
    // would change every second on a focused control, and the busy-task
    // adapter speaks the time every 30 s instead.
    if (wait) parts.push(el('span', { className: 'olv-ss-wait', text: `· ${wait}` }));
    b.replaceChildren(...parts);
    b.dataset.validity = validity ?? '';
    const state = validity && caution(validity) ? ` (${STATE_LABEL[validity]})` : '';
    const name = `${ITEM_NAME[id]}: ${text}${state}. ${ITEM_TARGET[id]}`;
    if (b.getAttribute('aria-label') !== name) b.setAttribute('aria-label', name);
  };

  // The phone strip wraps to a third row on the narrowest screens, so the
  // surfaces parked above it read its real height rather than the two-row
  // token. Written on change, a frame later: a same-frame write re-lays-out
  // the stage and trips the ResizeObserver loop guard.
  let write = 0;
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      const h = element.offsetHeight;
      const root = document.documentElement.style;
      const next = h > 0 ? `${h}px` : '';
      if (root.getPropertyValue('--olv-strip-measured') === next) return;
      cancelAnimationFrame(write);
      write = requestAnimationFrame(() => {
        write = 0;
        if (next) root.setProperty('--olv-strip-measured', next);
        else root.removeProperty('--olv-strip-measured');
      });
    });
    observer.observe(element);
  }

  return {
    element,
    dispose() {
      observer?.disconnect();
      observer = null;
      if (write) cancelAnimationFrame(write);
      write = 0;
      document.documentElement.style.removeProperty('--olv-strip-measured');
    },
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
      const ff = s.basis?.value === 'sampled' ? fullFileAvailability() : null;
      const rl = s.basis?.value === 'sampled' ? reloadAvailability() : null;
      const ffKey = `${ff?.show ? `${ff.label}|${ff.allowed}|${ff.reason ?? ''}` : ''}#${rl?.show ? `${rl.label}|${rl.allowed}` : ''}`;
      if (ffKey !== fullFileKey) {
        fullFileKey = ffKey;
        fullFileSlot.replaceChildren(...(s.basis?.value === 'sampled' ? sampleActionLinks() : []));
      }
      buttons.get('basis')!.title = s.basis?.value === 'resident-only'
        ? 'Only the points currently in memory, not the whole file.'
        : '';
      paint('clip', s.clip ? clipScopeText(s.clip) : null, s.clip ? 'info' : null);
      const p = s.processing?.value;
      paint(
        'processing',
        !p ? null : p.state === 'idle' ? 'Idle' : `${p.label || 'Working'}${p.progress != null ? ` ${Math.round(p.progress * 100)}%` : ''}${p.more > 0 ? ` +${p.more}` : ''}`,
        null,
        undefined,
        p?.state === 'running' && p.elapsedMs >= WAIT_SHOWN_AFTER_MS ? formatWait(p) : undefined,
      );
      const r = s.review;
      paint('review', r ? (r.value.count === 0 ? 'Nothing to review' : `${r.value.count} to review`) : null, r?.validity ?? null);
      // Review stays on for a sampled layer; the tip names the sample and the remedy.
      buttons.get('review')!.title = r && r.value.count > 0 && s.basis?.value === 'sampled' ? reviewSampleTip() : '';
    },
  };
}
