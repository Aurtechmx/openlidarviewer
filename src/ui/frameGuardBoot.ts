/**
 * frameGuardBoot.ts: imported by `embedConfig.ts`, which `main.ts` imports, so
 * it runs before the app's own code. When the page is framed by a site the
 * embed policy does not trust, it shows the notice and throws, so `main.ts`
 * never evaluates and the app does not start. Everywhere else it is a no-op.
 */
import { enforceFramePolicy } from './frameGuard';

/** Thrown to stop the module graph; carries the reason in the console. */
class FramedByUntrustedPage extends Error {
  constructor() {
    super('OpenLiDARViewer did not start: it is framed by a page that is not an allowed embedding origin.');
  }
}

let allowed = true;
try {
  allowed = typeof window === 'undefined' || enforceFramePolicy(window);
} catch {
  // A window the policy cannot read (a test double) is not a framing attack.
  allowed = true;
}
if (!allowed) throw new FramedByUntrustedPage();
