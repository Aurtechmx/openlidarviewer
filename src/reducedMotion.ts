/**
 * reducedMotion.ts
 *
 * The single `prefers-reduced-motion` reader, shared by the ResultFocus
 * surface, the profile workbench stage and NavController (camera tween,
 * released-drag glide, arrow-key orbit tail). A neutral top-level module so
 * render/ and ui/ can both import it without a new render->ui edge
 * (scripts/lint-module-graph.mjs).
 *
 * Read fresh on every call, so a live change of the OS setting applies on the
 * next frame or tween with no listener (and no owned subscription) to manage.
 */

/** True when the OS asked for reduced motion; false when unreadable. */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
    );
  } catch {
    return false;
  }
}
