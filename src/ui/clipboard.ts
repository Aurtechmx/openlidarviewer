/**
 * clipboard.ts: copy text to the clipboard.
 *
 * DOM-only leaf with no three.js dependency, so the startup shell can import
 * it (the measurement result card's Copy button) without pulling the
 * renderer chunk into the first load.
 */

/**
 * Copy text to the clipboard. Uses the async Clipboard API, falling back to a
 * hidden-textarea `execCommand` for older or non-secure contexts.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
