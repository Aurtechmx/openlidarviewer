/**
 * frameGuardBoot.ts — imported first by `main.ts`. When the page is framed by
 * a site the embed policy does not trust, it shows the notice and stops the
 * module graph, so the app never starts. Everything else is a no-op.
 */
import { enforceFramePolicy } from './frameGuard';

if (typeof window !== 'undefined' && !enforceFramePolicy(window)) {
  throw new Error('OpenLiDARViewer did not start: it is framed by a page that is not an allowed embedding origin.');
}
