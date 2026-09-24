/**
 * recommendedViewChipTiming.test.ts
 *
 * INSPECT-INSP-5: the recommended-view chip auto-hid after a fixed 9s with no
 * pause on hover or focus, so a keyboard user who Tabbed to the Apply button
 * and took more than ~9s to act had the chip vanish under them, silently
 * dropping focus to `<body>` with no relocation and no announcement.
 *
 * These tests pin the fix: the timer pauses while the chip is hovered or
 * focused (and resumes once neither is true), moving focus between the
 * chip's own buttons does not count as leaving it, and hiding while it holds
 * focus restores focus to whatever held it before the chip appeared.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { RecommendedViewChip } from '../src/ui/RecommendedViewChip';
import { FakeEl, installFakeDom, byClass } from './support/measurePanelDom';
import type { ViewRecommendation } from '../src/render/camera/recommendView';

beforeAll(() => {
  installFakeDom();
});

beforeEach(() => {
  vi.useFakeTimers();
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { setTimeout, clearTimeout };
  // `show()` narrows `document.activeElement instanceof HTMLElement`; FakeEl
  // IS the element type here, so map HTMLElement onto it (same pattern as
  // tests/modalConfirm.test.ts, which guards the equivalent Modal.ts check).
  g.HTMLElement = FakeEl;
  // The focusout handler narrows its relatedTarget with `instanceof Node`.
  g.Node = FakeEl;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    activeElement: null as FakeEl | null,
    contains: (node: unknown) => node != null,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const REC: ViewRecommendation = { preset: 'top', reason: 'Flat, wide scan' };

function makeChip(): { chip: RecommendedViewChip; el: FakeEl } {
  const chip = new RecommendedViewChip();
  return { chip, el: chip.element as unknown as FakeEl };
}

function setActiveElement(node: FakeEl | null): void {
  (globalThis as unknown as { document: { activeElement: FakeEl | null } }).document.activeElement =
    node;
}

/** A focusable fake node: `.focus()` makes it the fake document's active element. */
function focusableNode(tag = 'button'): FakeEl {
  const node = new FakeEl(tag);
  node.focus = () => setActiveElement(node);
  return node;
}

describe('RecommendedViewChip — auto-hide timing', () => {
  it('auto-hides after 9s when left alone', () => {
    const { chip, el } = makeChip();
    chip.show(REC, vi.fn());
    expect(el.classList.contains('olv-hidden')).toBe(false);
    vi.advanceTimersByTime(9000);
    expect(el.classList.contains('olv-hidden')).toBe(true);
  });

  /** Dispatching `eventType` (hover-in or focus-in) suspends the auto-hide
   * timer indefinitely — the shape shared by the mouseenter and focusin
   * pause tests, which differ only in which event holds it up. */
  function assertPausesTimer(eventType: string): void {
    const { chip, el } = makeChip();
    chip.show(REC, vi.fn());
    el.dispatchEvent({ type: eventType });
    vi.advanceTimersByTime(20_000);
    expect(el.classList.contains('olv-hidden')).toBe(false);
  }

  it('pauses the timer while hovered, and does not hide at 9s', () => {
    assertPausesTimer('mouseenter');
  });

  it('resumes the timer once the pointer leaves, from a fresh 9s', () => {
    const { chip, el } = makeChip();
    chip.show(REC, vi.fn());
    el.dispatchEvent({ type: 'mouseenter' });
    vi.advanceTimersByTime(20_000); // well past the original 9s, but paused
    el.dispatchEvent({ type: 'mouseleave' });
    vi.advanceTimersByTime(8_999);
    expect(el.classList.contains('olv-hidden')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains('olv-hidden')).toBe(true);
  });

  it('pauses the timer while a button inside it is focused', () => {
    assertPausesTimer('focusin');
  });

  it('moving focus between the two buttons inside the chip does not resume the timer', () => {
    const { chip, el } = makeChip();
    chip.show(REC, vi.fn());
    const dismiss = byClass(el, 'olv-rvc-dismiss')!;
    el.dispatchEvent({ type: 'focusin' });
    // Apply -> Dismiss: relatedTarget (the next focus target) is still
    // inside the chip, so this must not read as "focus left the chip".
    el.dispatchEvent({ type: 'focusout', relatedTarget: dismiss } as unknown as { type: string });
    el.dispatchEvent({ type: 'focusin' });
    vi.advanceTimersByTime(20_000);
    expect(el.classList.contains('olv-hidden')).toBe(false);
  });

  it('stays paused on mouseleave while focus is still inside (hover and focus tracked independently)', () => {
    const { chip, el } = makeChip();
    chip.show(REC, vi.fn());
    el.dispatchEvent({ type: 'focusin' }); // keyboard focus arrives first
    el.dispatchEvent({ type: 'mouseenter' }); // the pointer also happens to be over it
    el.dispatchEvent({ type: 'mouseleave' }); // pointer leaves — focus does not
    // A single combined flag would have resumed the timer here even though
    // the chip is still focused; independent tracking must not.
    vi.advanceTimersByTime(20_000);
    expect(el.classList.contains('olv-hidden')).toBe(false);
  });

  it('resumes once focus actually leaves the chip for an outside element', () => {
    const { chip, el } = makeChip();
    chip.show(REC, vi.fn());
    const outside = new FakeEl('button');
    el.dispatchEvent({ type: 'focusin' });
    el.dispatchEvent({ type: 'focusout', relatedTarget: outside } as unknown as { type: string });
    vi.advanceTimersByTime(8_999);
    expect(el.classList.contains('olv-hidden')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains('olv-hidden')).toBe(true);
  });
});

describe('RecommendedViewChip — focus return', () => {
  it('restores focus to whatever held it before the chip appeared, when hide() runs while it holds focus', () => {
    const { chip, el } = makeChip();
    const opener = focusableNode();
    opener.focus();

    chip.show(REC, vi.fn());
    const apply = byClass(el, 'olv-rvc-apply')!;
    apply.focus = () => setActiveElement(apply);
    apply.focus(); // the user tabbed onto Apply

    chip.hide();

    expect(
      (globalThis as unknown as { document: { activeElement: FakeEl | null } }).document
        .activeElement,
    ).toBe(opener);
  });

  it('does not move focus when hide() runs and focus was never inside the chip', () => {
    const { chip } = makeChip();
    const opener = focusableNode();
    opener.focus();
    chip.show(REC, vi.fn());

    // Focus stayed on `opener` throughout — never moved into the chip.
    chip.hide();

    expect(
      (globalThis as unknown as { document: { activeElement: FakeEl | null } }).document
        .activeElement,
    ).toBe(opener);
  });

  it('the timer that fires after focus has genuinely left the chip does not move focus again', () => {
    const { chip, el } = makeChip();
    const opener = focusableNode();
    opener.focus();
    chip.show(REC, vi.fn());
    const apply = byClass(el, 'olv-rvc-apply')!;
    apply.focus = () => setActiveElement(apply);
    apply.focus();
    el.dispatchEvent({ type: 'focusin' });
    // Tab away for good — focus returns to `opener` on its own, same as a
    // real Shift+Tab out of the chip.
    el.dispatchEvent({ type: 'focusout', relatedTarget: opener } as unknown as { type: string });
    opener.focus();

    vi.advanceTimersByTime(9000);

    expect(el.classList.contains('olv-hidden')).toBe(true);
    // `hide()` found focus already outside the chip, so it left `opener`
    // alone rather than re-focusing it a second time.
    expect(
      (globalThis as unknown as { document: { activeElement: FakeEl | null } }).document
        .activeElement,
    ).toBe(opener);
  });
});
