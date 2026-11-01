/**
 * dragPointer.ts — the window listeners one handle drag owns.
 *
 * A drag belongs to the pointer that began it. Another pointer's moves and
 * releases are ignored, so a second finger can neither take the drag over nor
 * end it. The drag is cancelled, never committed, when its own pointer is
 * cancelled (a palm, a scroll, the OS), when the window loses focus (the
 * release may never arrive), on Escape, which goes no further, or when a mouse
 * move arrives with no button held: the release happened where the page could
 * not see it. The returned function detaches every listener.
 */
export interface DragPointerHandlers {
  move(e: PointerEvent): void;
  up(e: PointerEvent): void;
  cancel(): void;
}

export function listenToDragPointer(pointerId: number, h: DragPointerHandlers): () => void {
  const own = (e: PointerEvent): boolean => e.pointerId === pointerId;
  const move = (e: PointerEvent): void => {
    if (!own(e)) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) h.cancel();
    else h.move(e);
  };
  const up = (e: PointerEvent): void => { if (own(e)) h.up(e); };
  const cancel = (e: PointerEvent): void => { if (own(e)) h.cancel(); };
  const blur = (): void => h.cancel();
  const key = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    h.cancel();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', blur);
  window.addEventListener('keydown', key, true);
  return () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', blur);
    window.removeEventListener('keydown', key, true);
  };
}
