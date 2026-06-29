/**
 * reportVerifier.ts — the lazy "Verify integrity report" dialog.
 *
 * Lazy on purpose: the verifier (and the pure `verifyReportFile` it pulls in) is
 * only loaded when the user asks to check a report, so none of it ships in the
 * startup shell. Routed through `lazyChunks` so the obfuscator can't scramble
 * the specifier. Inline-styled (themed via CSS custom properties; CSP allows
 * style-src unsafe-inline); every text node is `textContent`, never innerHTML,
 * so a hostile report field can't inject markup.
 */

import { verifyReportFile, type VerifyReportResult } from '../export/verifyReport';

function row(label: string, value: string): HTMLElement {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;justify-content:space-between;gap:16px;font:12px system-ui,sans-serif;color:var(--olv-fg,#e8eef5);';
  const l = document.createElement('span');
  l.textContent = label;
  l.style.cssText = 'opacity:0.7;';
  const v = document.createElement('span');
  v.textContent = value;
  v.style.cssText = 'font-variant-numeric:tabular-nums;text-align:right;';
  r.append(l, v);
  return r;
}

/** Render the verification result as a dismissible modal card. */
export function showReportVerification(result: VerifyReportResult): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'olv-verify-backdrop';
  backdrop.setAttribute('data-testid', 'report-verify');
  backdrop.style.cssText =
    'position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.45);backdrop-filter:blur(2px);';

  const card = document.createElement('div');
  card.style.cssText =
    'min-width:300px;max-width:440px;padding:18px 20px;border-radius:12px;' +
    'background:var(--olv-surface,#141820);border:1px solid var(--olv-border,rgba(255,255,255,0.16));' +
    'box-shadow:0 8px 30px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:10px;';

  // Status headline — colour carries the verdict, the WORD carries it too.
  const ok = result.valid;
  const status = document.createElement('div');
  status.setAttribute('data-testid', ok ? 'report-verify-valid' : 'report-verify-invalid');
  status.textContent = !result.recognised
    ? 'Not a report'
    : ok
      ? 'Report is intact'
      : 'Report has been modified';
  status.style.cssText =
    `font:600 16px system-ui,sans-serif;color:${ok ? 'var(--olv-ok,#46c08a)' : 'var(--olv-bad,#ff6b6b)'};`;
  card.append(status);

  const reason = document.createElement('div');
  reason.textContent = result.reason;
  reason.style.cssText = 'font:12px system-ui,sans-serif;color:var(--olv-fg,#e8eef5);opacity:0.85;';
  card.append(reason);

  if (result.recognised) {
    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-top:4px;padding-top:8px;border-top:1px solid var(--olv-border,rgba(255,255,255,0.12));';
    if (result.algorithm) meta.append(row('Digest', result.algorithm));
    if (result.software) meta.append(row('Produced by', `OpenLiDARViewer ${result.software}`));
    if (result.classificationEpoch !== undefined) meta.append(row('Classification epoch', String(result.classificationEpoch)));
    if (result.findingsCount !== undefined) meta.append(row('Findings', String(result.findingsCount)));
    card.append(meta);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.setAttribute('data-testid', 'report-verify-close');
  close.style.cssText =
    'align-self:flex-end;margin-top:6px;padding:6px 14px;border:0;border-radius:8px;cursor:pointer;' +
    'font:600 12px system-ui,sans-serif;color:#0b0e13;background:var(--olv-accent,#5ab0ff);';
  const dismiss = (): void => backdrop.remove();
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', esc); }
  });
  card.append(close);

  backdrop.append(card);
  document.body.append(backdrop);
}

/** Read a report file, verify it, and show the result. Never throws. */
export async function verifyAndShow(file: File): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    showReportVerification({ recognised: false, valid: false, reason: 'Could not read the file.' });
    return;
  }
  showReportVerification(verifyReportFile(text));
}
