/**
 * nativeTitleStrip.ts — keep the browser's `title` bubble off a toolbar that
 * draws its own hover tooltip.
 *
 * The measure bar's controls use the custom, styled `data-tip` tooltip. To stop
 * the native `title` bubble from doubling up, `title` is stripped while a
 * control is hovered or focused and restored on leave; the rich `title` text
 * stays the canonical accessible/help string the rest of the time.
 *
 * Hover and focus are tracked SEPARATELY. They used to share one flag, so
 * whichever ended first restored `title` even though the other was still
 * active. A click is exactly that case: a handler calls `btn.blur()`, the
 * resulting `focusout` restored `title` while the pointer was still over the
 * button, and the native bubble reappeared on top of the custom tip. Chromium
 * focuses a button on mousedown so it hit the bug on every click; WebKit does
 * not, so it never fired the restore. The cross-browser run surfaced it.
 */

/** Strip `title` from any button under `root` while it is hovered or focused. */
export function installNativeTitleStrip(root: HTMLElement): void {
  const hovered = new WeakSet<HTMLElement>();
  const focused = new WeakSet<HTMLElement>();

  const buttonFor = (e: Event): HTMLElement | null =>
    ((e.target as HTMLElement | null)?.closest('button') as HTMLElement | null) ?? null;

  /**
   * True when the event leaves the button entirely. `pointerout` and
   * `focusout` also fire when moving between a button's own children (the
   * inline SVG icon and the label span), which would otherwise restore and
   * re-strip `title` on every internal crossing.
   */
  const leavesButton = (e: Event, btn: HTMLElement): boolean => {
    const to = (e as PointerEvent | FocusEvent).relatedTarget as Node | null;
    return !(to && btn.contains(to));
  };

  const strip = (btn: HTMLElement): void => {
    if (btn.title) {
      btn.dataset.nativeTitle = btn.title;
      btn.removeAttribute('title');
    }
  };
  /** Restore only once BOTH hover and focus have cleared. */
  const restoreIfIdle = (btn: HTMLElement): void => {
    if (hovered.has(btn) || focused.has(btn)) return;
    if (btn.dataset.nativeTitle != null) {
      btn.title = btn.dataset.nativeTitle;
      delete btn.dataset.nativeTitle;
    }
  };

  root.addEventListener('pointerover', (e) => {
    const btn = buttonFor(e);
    if (!btn) return;
    hovered.add(btn);
    strip(btn);
  });
  root.addEventListener('pointerout', (e) => {
    const btn = buttonFor(e);
    if (!btn || !leavesButton(e, btn)) return;
    hovered.delete(btn);
    restoreIfIdle(btn);
  });
  root.addEventListener('focusin', (e) => {
    const btn = buttonFor(e);
    if (!btn) return;
    focused.add(btn);
    strip(btn);
  });
  root.addEventListener('focusout', (e) => {
    const btn = buttonFor(e);
    if (!btn || !leavesButton(e, btn)) return;
    focused.delete(btn);
    restoreIfIdle(btn);
  });
}

/**
 * Set a button's `title` under the strip: while the button is hovered or
 * focused the text is parked in `data-native-title`, so writing `title`
 * directly would be undone on leave.
 */
export function setStrippableTitle(btn: HTMLElement, title: string): void {
  if (btn.dataset.nativeTitle != null) btn.dataset.nativeTitle = title;
  else if (btn.title !== title) btn.title = title;
}
