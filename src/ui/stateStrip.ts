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
import { announcePolite } from './politeAnnounce';
import { MOBILE_LANDSCAPE_MAX_HEIGHT, MOBILE_MAX_WIDTH } from './isMobileDevice';
import { fullFileAvailability, reloadAvailability, reviewSampleTip, sampleActionLinks } from '../app/fullFileActions';
import { STATE_GLYPH, STATE_LABEL, type SciState } from './stateChip';
import { linearUnitLabel } from '../io/crs';
import { clipModePhrase, clipStatusText, clipTurnOff } from '../render/clip/clipScope';
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

/**
 * How long a clip that has just turned on waits for its kept count before it
 * is announced without one. The Clip panel counts 120 ms after a change
 * (CLIP_COUNT_DEBOUNCE_MS); a streamed scan never has a count.
 */
export const CLIP_ANNOUNCE_WAIT_MS = 600;

/**
 * The touch-phone layout, where the strip keeps one row and scrolls sideways
 * (the matching rule in stateStrip.css).
 */
export const STRIP_SCROLL_QUERY =
  `(pointer: coarse) and (max-width: ${MOBILE_MAX_WIDTH}px), (pointer: coarse) and (max-height: ${MOBILE_LANDSCAPE_MAX_HEIGHT}px)`;

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
  // Turn off sits beside the clip item (a button cannot nest in a button) and
  // shows with it, so the clip is never more than one click from off.
  const clipOff = el('button', {
    className: 'olv-ss-item olv-ss-clipoff', type: 'button', text: 'Turn off',
    ariaLabel: 'Turn off clipping', tip: 'Turn the clip off and show the whole scan',
  });
  clipOff.hidden = true;
  clipOff.addEventListener('click', () => clipTurnOff()?.());
  const ids: StripItemId[] = ['dataset', 'crs', 'vertical', 'basis', 'clip', 'processing', 'review'];
  for (const id of ids) {
    const b = el('button', { className: `olv-ss-item olv-ss-${id}`, type: 'button', tip: ITEM_TARGET[id] });
    b.dataset.item = id;
    b.addEventListener('click', () => host.open(id));
    buttons.set(id, b);
    element.append(b);
    if (id === 'basis') element.append(fullFileSlot);
    if (id === 'clip') element.append(clipOff);
  }

  /** Repaint one item; true when anything about it changed. */
  const paint = (id: StripItemId, text: string | null, validity: SciState | null, short?: string, wait?: string): boolean => {
    const b = buttons.get(id)!;
    const key = `${text}|${validity}|${short}|${wait}`;
    if (b.dataset.key === key) return false;
    b.dataset.key = key;
    if (text === null) {
      // A hidden item keeps no text: a task that has left must not stay in the
      // DOM or in the accessible name under a hidden processing item.
      b.hidden = true;
      b.replaceChildren();
      b.removeAttribute('aria-label');
      b.dataset.validity = '';
      return true;
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
    // adapter speaks the time every 30 s instead. CSS draws it from data-wait,
    // so it is not part of the button's text either, and the visible text the
    // name must contain is the task alone.
    if (wait) {
      const w = el('span', { className: 'olv-ss-wait' });
      w.dataset.wait = `· ${wait}`;
      w.setAttribute('aria-hidden', 'true');
      parts.push(w);
    }
    b.replaceChildren(...parts);
    b.dataset.validity = validity ?? '';
    const state = validity && caution(validity) ? ` (${STATE_LABEL[validity]})` : '';
    const name = `${ITEM_NAME[id]}: ${text}${state}. ${ITEM_TARGET[id]}`;
    if (b.getAttribute('aria-label') !== name) b.setAttribute('aria-label', name);
    return true;
  };

  // On a touch phone the strip is one row that scrolls sideways and the clip
  // item sits fifth, so it can rest off-screen. When it appears or its text
  // changes, the strip itself is scrolled (never the page, which
  // scrollIntoView can move) until the item and Turn off beside it clear the
  // fade at the row's end; an item wider than the row shows its start.
  const revealClip = (): void => {
    if (typeof matchMedia !== 'function' || !matchMedia(STRIP_SCROLL_QUERY).matches) return;
    const item = buttons.get('clip')!;
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    const padStart = parseFloat(cs?.paddingLeft ?? '') || 0;
    const fade = parseFloat(cs?.paddingRight ?? '') || 0;
    const start = item.offsetLeft - padStart;
    const end = clipOff.hidden ? item.offsetLeft + item.offsetWidth : clipOff.offsetLeft + clipOff.offsetWidth;
    const room = element.clientWidth - fade;
    let next = element.scrollLeft;
    if (end > next + room) next = end - room;
    if (start < next) next = Math.max(0, start);
    if (next !== element.scrollLeft) element.scrollLeft = next;
  };

  // The strip is a row of buttons, not a live region, so clip changes are said
  // through the app's one polite region: the clip turned on (with its count),
  // a side change, the clip turned off. Each once; a new count on the same side
  // is not said. A clip just turned on waits briefly for its count so the one
  // announcement carries it; a count that lands after the wait is said once
  // more. `spoken` is the state last said: 'off', a side, or 'on' when the side
  // is not known; `spokenCounted` is whether that line carried a count.
  let spoken = 'off';
  let spokenCounted = false;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let waitingKey = '';
  let waitingText = '';
  const stopWaiting = (): void => {
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
  };
  const say = (key: string, text: string, counted: boolean): void => {
    stopWaiting();
    spoken = key;
    spokenCounted = counted;
    announcePolite(text);
  };
  const announceClip = (key: string, text: string, counted: boolean): void => {
    if (key === spoken) {
      stopWaiting();
      // Said without a count while waiting for one, and the count is here now.
      if (key !== 'off' && counted && !spokenCounted) say(key, text, true);
      return;
    }
    if (key === 'off') {
      say(key, 'Clip off', false);
      return;
    }
    if (counted) {
      say(key, text, true);
      return;
    }
    // The latest text is said when the wait ends.
    waitingKey = key;
    waitingText = text;
    if (waiting === null) {
      waiting = setTimeout(() => {
        waiting = null;
        say(waitingKey, waitingText, false);
      }, CLIP_ANNOUNCE_WAIT_MS);
    }
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
      stopWaiting();
      observer?.disconnect();
      observer = null;
      if (write) cancelAnimationFrame(write);
      write = 0;
      document.documentElement.style.removeProperty('--olv-strip-measured');
    },
    render(s) {
      element.classList.toggle('olv-hidden', s === null);
      if (!s) {
        // The scan closed: its clip goes with it unsaid, and the next scan starts from off.
        stopWaiting();
        spoken = 'off';
        spokenCounted = false;
        return;
      }
      paint('dataset', s.dataset.value, s.dataset.validity);
      const h = s.horizontal;
      paint(
        'crs',
        h ? `${h.value.crsName} · ${linearUnitLabel(h.value.linearUnit, h.value)}${h.value.assertedBy ? ` · catalogue (${h.value.assertedBy})` : ''}` : null,
        h?.validity ?? null,
        h && h.value.epsg !== undefined ? `EPSG:${h.value.epsg} · ${linearUnitLabel(h.value.linearUnit, h.value)}` : undefined,
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
      // The count wording is the shared one; the side kept is said beside it.
      // A scan with no count (a streamed one) still says the clip is on, and which side.
      const side = s.clip?.mode ?? s.clipOn ?? undefined;
      const phrase = side ? clipModePhrase({ kept: 0, total: 0, mode: side }) : '';
      const clipText = s.clip ? clipStatusText(s.clip) : s.clipOn ? 'Clip on' : null;
      const clipLine = clipText === null ? null : `${clipText}${phrase ? ` · ${phrase}` : ''}`;
      const clipChanged = paint('clip', clipLine, clipText === null ? null : 'info');
      clipOff.hidden = clipText === null;
      if (clipChanged && clipLine !== null) revealClip();
      // Spoken with a comma: some screen readers read "·" aloud as "middle dot".
      const spokenLine = clipText === null ? '' : `${clipText}${phrase ? `, ${phrase}` : ''}`;
      announceClip(clipLine === null ? 'off' : side ?? 'on', spokenLine, !!s.clip);
      const p = s.processing?.value;
      paint(
        'processing',
        // Nothing running shows nothing: an item that always reads "Idle" says no more than its absence.
        !p || p.state === 'idle' ? null : `${p.label || 'Working'}${p.progress != null ? ` ${Math.round(p.progress * 100)}%` : ''}${p.more > 0 ? ` +${p.more}` : ''}`,
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
