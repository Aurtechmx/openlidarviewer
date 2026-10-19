/**
 * frameGuardBoot.ts: the first import of `main.ts` (`embedConfig.ts` imports it
 * as well, for the modules that reach the config without going through
 * `main.ts`), so it runs before the app's own code. When the page is framed by
 * a site the embed policy does not trust, it shows the notice and throws, so
 * `main.ts` never evaluates and the app does not start. Everywhere else it is
 * a no-op.
 *
 * It fails closed: a page that is framed, or whose framing cannot be read, does
 * not start when the policy cannot be evaluated. Only a window that is its own
 * top (a test double) is let through.
 */
import { enforceFramePolicy, renderFramedNotice } from './frameGuard';

/** Thrown to stop the module graph; carries the reason in the console. */
class FramedByUntrustedPage extends Error {
  constructor() {
    super('OpenLiDARViewer did not start: it is framed by a page that is not an allowed embedding origin.');
  }
}

/** Whether `win` is inside another page; a window whose top cannot be read counts as framed. */
function isFramed(win: Window): boolean {
  try {
    return win.top !== win;
  } catch {
    return true;
  }
}

let allowed = true;
try {
  allowed = typeof window === 'undefined' || enforceFramePolicy(window);
} catch {
  // The policy could not be evaluated. A framed page is not started on a guess;
  // a window that is its own top (a test double) is not a framing attack.
  allowed = !isFramed(window);
  if (!allowed) {
    try {
      renderFramedNotice(window.document, window.location.origin + window.location.pathname);
    } catch {
      // No notice can be drawn here; the app still does not start.
    }
  }
}
if (!allowed) throw new FramedByUntrustedPage();
