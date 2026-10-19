/**
 * frameGuard.ts
 *
 * Safe mode for a viewer framed by a page nothing authorises (see
 * `embedPolicy.ts`). Where the host cannot send `frame-ancestors` (GitHub Pages
 * or a bucket host) any page can frame the viewer, so the viewer withholds its
 * interface itself: it shows a plain notice with a link to open it in its own
 * tab, and the app does not start (see `frameGuardBoot.ts`).
 *
 * Styling goes through the CSSOM so it works under the page's CSP, which allows
 * no inline `<style>`, and with the stylesheet not yet loaded.
 */

import {
  decideFramePolicy,
  deployerEmbedOrigins,
  readFrameFacts,
  type FrameDecision,
} from './embedPolicy';

/** The decision for `win`, held to the deployer's allow-list. */
export function frameDecisionFor(win: Window): FrameDecision {
  return decideFramePolicy(readFrameFacts(win), { deployerOrigins: deployerEmbedOrigins() });
}

/** Replace the page body with the notice. `openUrl` is the viewer's own address, without a query. */
export function renderFramedNotice(doc: Document, openUrl: string): void {
  const wrap = doc.createElement('main');
  Object.assign(wrap.style, {
    boxSizing: 'border-box',
    minHeight: '100vh',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    textAlign: 'center',
    font: '16px/1.5 system-ui, sans-serif',
    colorScheme: 'light dark',
    background: 'Canvas',
    color: 'CanvasText',
  });
  const title = doc.createElement('h1');
  title.textContent = 'OpenLiDARViewer is not shown inside this page';
  title.style.fontSize = '20px';
  title.style.margin = '0';
  const text = doc.createElement('p');
  text.textContent = 'The page that embeds it is not on this viewer’s list of allowed embedding sites, so the viewer has not started.';
  text.style.margin = '0';
  const link = doc.createElement('a');
  link.href = openUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open the viewer in its own tab';
  link.style.color = 'LinkText';
  wrap.append(title, text, link);
  doc.body.replaceChildren(wrap);
}

/**
 * Apply the frame policy to `win`: true when the app may start, false after
 * the notice has replaced the page.
 */
export function enforceFramePolicy(win: Window = window): boolean {
  if (frameDecisionFor(win).kind !== 'safe') return true;
  renderFramedNotice(win.document, win.location.origin + win.location.pathname);
  return false;
}
