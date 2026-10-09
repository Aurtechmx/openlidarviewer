/**
 * transientLane.ts
 *
 * On the phone layout a freshly opened scan used to raise the Project card, the
 * instant-analysis toast and the recovery notice together, and they covered
 * most of the screen. The lane lets one transient card show at a time: the
 * first to claim it shows, later claimants wait (CSS hides them through
 * `olv-lane-wait`) and show in turn as each one before them is released.
 *
 * A claimant's `onFront` runs when it reaches the front, so a card that times
 * itself out starts its timer only once it is on screen. Off the phone layout
 * the lane is inactive: every claim goes straight to the front and nothing is
 * hidden, which keeps the desktop behaviour unchanged.
 */

import { MOBILE_LAYOUT_QUERY } from './isMobileDevice';

export interface TransientLane {
  /**
   * Queue `el`; `onFront` runs once it is the card on screen. Re-claiming a
   * queued card keeps its place. With `first` the card goes to the front and
   * the card that was showing waits behind it: its `onBack` runs then, so it
   * can stop its own timer, and its `onFront` runs again when it returns.
   */
  claim(el: HTMLElement, onFront?: () => void, opts?: ClaimOptions): void;
  /** Remove `el` from the lane and show the next card waiting, if any. */
  release(el: HTMLElement): void;
  /** The card currently shown, or null. */
  front(): HTMLElement | null;
  /** True while the lane queues cards (the phone layout). */
  active(): boolean;
}

export interface ClaimOptions {
  /** Take the front, sending the card on screen back to wait. */
  readonly first?: boolean;
  /** Runs when another card's `first` claim sends this one back to wait. */
  readonly onBack?: () => void;
}

interface Entry { el: HTMLElement; onFront?: () => void; onBack?: () => void }

const WAIT_CLASS = 'olv-lane-wait';

export function createTransientLane(active: () => boolean): TransientLane {
  const queue: Entry[] = [];

  /** Put `entry` in front, sending the card on screen back to wait. */
  const takeFront = (entry: Entry): void => {
    const prior = queue[0];
    if (prior) {
      prior.el.classList.add(WAIT_CLASS);
      prior.onBack?.();
    }
    queue.unshift(entry);
    promote();
  };

  const promote = (): void => {
    const head = queue[0];
    if (!head) return;
    head.el.classList?.remove(WAIT_CLASS);
    head.onFront?.();
  };

  return {
    claim(el, onFront, opts = {}) {
      const { first = false, onBack } = opts;
      if (!active()) {
        el.classList?.remove(WAIT_CLASS);
        onFront?.();
        return;
      }
      const at = queue.findIndex((q) => q.el === el);
      if (at >= 0) {
        const entry = queue[at];
        entry.onFront = onFront;
        entry.onBack = onBack;
        if (at === 0) onFront?.();
        else if (first) {
          queue.splice(at, 1);
          takeFront(entry);
        }
        return;
      }
      const entry: Entry = { el, onFront, onBack };
      if (first && queue.length > 0) {
        takeFront(entry);
        return;
      }
      queue.push(entry);
      if (queue.length === 1) promote();
      else el.classList.add(WAIT_CLASS);
    },
    release(el) {
      el.classList?.remove(WAIT_CLASS);
      const at = queue.findIndex((q) => q.el === el);
      if (at < 0) return;
      queue.splice(at, 1);
      if (at === 0) promote();
    },
    front() {
      return queue[0]?.el ?? null;
    },
    active,
  };
}

let shared: TransientLane | null = null;

/** The app's one lane, active while the phone layout applies. */
export function appTransientLane(): TransientLane {
  shared ??= createTransientLane(
    () => typeof matchMedia === 'function' && matchMedia(MOBILE_LAYOUT_QUERY).matches,
  );
  return shared;
}
