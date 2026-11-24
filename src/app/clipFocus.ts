/**
 * clipFocus.ts: "Focus clipped region", for the Clip page's button and the
 * command palette. The viewer's own frameClip moves the camera (at once under
 * reduced motion); this says whether it can, and what it did.
 */
import { clipFrameBounds } from '../render/clip/clipBox';
import type { Viewer } from '../render/Viewer';

export const NO_CLIP_TO_FOCUS = 'Turn on a Keep inside clip whose box reaches the scan first.';

/** Whether frameClip would move the camera: the same test it makes. */
export function canFocusClip(v: Pick<Viewer, 'getClip' | 'mergedVisibleBounds'> | null): boolean {
  return !!v && clipFrameBounds(v.getClip(), v.mergedVisibleBounds(true)) !== null;
}

/** Focus the clipped region and say so in the polite toast, or say why not. */
export function focusClip(v: Pick<Viewer, 'frameClip'> | null, toast: (message: string) => void): void {
  toast(v?.frameClip() ? 'View moved to the clipped region.' : NO_CLIP_TO_FOCUS);
}
