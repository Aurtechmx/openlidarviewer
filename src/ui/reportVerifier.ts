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
  r.style.cssText = 'display:flex;justify-content:space-between;gap:16px;font:12px system-ui,sans-serif;color:var(--text);';
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
    'background:var(--panel);border:1px solid var(--hairline);color:var(--text);' +
    'box-shadow:0 8px 30px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:10px;';
  // Dialog semantics, matching the app's other modals (Modal.ts, TourOverlay):
  // a screen reader announces the boundary and reads the verdict headline as the
  // accessible name, so the tamper/intact result is conveyed, not just coloured.
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'olv-verify-status');

  // Status headline — colour carries the verdict, the WORD carries it too. A
  // digest match with a NON-cryptographic (FNV-1a) checksum is forgeable, so it
  // is an amber caution, never a green "intact".
  const ok = result.valid;
  const weak = ok && result.cryptographic === false;
  const status = document.createElement('div');
  status.id = 'olv-verify-status';
  let statusTestid: string;
  if (!ok) {
    statusTestid = 'report-verify-invalid';
  } else if (weak) {
    statusTestid = 'report-verify-weak';
  } else {
    statusTestid = 'report-verify-valid';
  }
  status.setAttribute('data-testid', statusTestid);
  let statusText: string;
  if (!result.recognised) {
    statusText = 'Not a report';
  } else if (!ok) {
    statusText = 'Report has been modified';
  } else if (weak) {
    statusText = 'Checksum matches — not tamper-proof';
  } else {
    statusText = 'Report is intact';
  }
  status.textContent = statusText;
  let statusColor: string;
  if (!ok) {
    statusColor = 'var(--rating-weak)';
  } else if (weak) {
    statusColor = 'var(--rating-good)';
  } else {
    statusColor = 'var(--rating-excellent)';
  }
  status.style.cssText = `font:600 16px system-ui,sans-serif;color:${statusColor};`;
  card.append(status);

  const reason = document.createElement('div');
  reason.textContent = result.reason;
  reason.style.cssText = 'font:12px system-ui,sans-serif;color:var(--text);opacity:0.85;';
  card.append(reason);

  if (result.recognised) {
    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-top:4px;padding-top:8px;border-top:1px solid var(--hairline);';
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
    'font:600 12px system-ui,sans-serif;color:var(--on-accent);background:var(--accent);';
  const esc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dismiss();
  };
  // dismiss tears down BOTH the node and the document-level key listener, so
  // closing via Close / backdrop / Escape never leaves a stale handler attached.
  const dismiss = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', esc);
  };
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  document.addEventListener('keydown', esc);
  card.append(close);

  backdrop.append(card);
  document.body.append(backdrop);
}

/**
 * Whole-file ceiling for a report the verifier reads into a single string. A
 * verifiable report is a small JSON-with-signature document; anything in the
 * tens of megabytes is not one, and reading it in full would exhaust memory
 * before the verifier could reject it. Mirrors the `.olvsession` read cap.
 */
export const MAX_REPORT_TEXT_BYTES = 32 * 1024 * 1024;

/**
 * The verification result an over-ceiling file justifies, or `undefined` when
 * the file is small enough to read. Pure and DOM-free so the size gate can be
 * tested without standing up the modal.
 */
export function oversizeReportResult(sizeBytes: number): VerifyReportResult | undefined {
  if (sizeBytes <= MAX_REPORT_TEXT_BYTES) return undefined;
  return {
    recognised: false,
    valid: false,
    reason:
      `This file is too large to be a report ` +
      `(${Math.round(sizeBytes / (1024 * 1024))} MB; limit ` +
      `${Math.round(MAX_REPORT_TEXT_BYTES / (1024 * 1024))} MB).`,
  };
}

/** Read a report file, verify it, and show the result. Never throws. */
export async function verifyAndShow(file: File): Promise<void> {
  const oversize = oversizeReportResult(file.size);
  if (oversize) {
    showReportVerification(oversize);
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    showReportVerification({ recognised: false, valid: false, reason: 'Could not read the file.' });
    return;
  }
  showReportVerification(verifyReportFile(text));
}
