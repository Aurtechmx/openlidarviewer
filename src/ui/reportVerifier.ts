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

import { verifyReportFileWithSignature, type VerifyReportResult } from '../export/verifyReport';
import type { SignatureVerdict } from '../export/reportSignature';
import { focusableIn, wireDialogA11y, type DialogA11yHandle } from './Modal';
import { formatBytesIn } from '../io/formatByteSize';
import { createKeyFileLoader } from './keyFileLoader';

function row(label: string, value: string): HTMLElement {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;justify-content:space-between;gap:16px;font:12px system-ui,sans-serif;color:var(--text);';
  const l = document.createElement('span');
  l.textContent = label;
  l.style.cssText = 'opacity:0.7;';
  const v = document.createElement('span');
  v.textContent = value;
  v.style.cssText = 'font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere;min-width:0;';
  r.append(l, v);
  return r;
}

/** Headline, colour and test id for a signature verdict. The words carry the meaning. */
export function signatureHeadline(v: SignatureVerdict): { text: string; color: string; testid: string } {
  switch (v.status) {
    case 'valid-trusted-key':
      return { text: 'Signed by the key you supplied', color: 'var(--rating-excellent)', testid: 'report-verify-sig-trusted' };
    case 'valid-different-key':
      return { text: 'Signed by a different key than the one you supplied', color: 'var(--rating-weak)', testid: 'report-verify-sig-different' };
    case 'valid-unknown-signer':
      return { text: 'Signed, signer unverified', color: 'var(--rating-good)', testid: 'report-verify-sig-unverified' };
    case 'malformed':
      return { text: 'Signature field is malformed', color: 'var(--rating-weak)', testid: 'report-verify-sig-invalid' };
    case 'unsupported':
      return { text: 'Signature is not supported here', color: 'var(--rating-weak)', testid: 'report-verify-sig-invalid' };
    default:
      return { text: 'Signature does not verify', color: 'var(--rating-weak)', testid: 'report-verify-sig-invalid' };
  }
}

/** Re-checks the open report against a public key or key id the reader supplies. */
export type SignerCompare = (keyText: string) => Promise<VerifyReportResult>;

/**
 * Decides which Compare result may be shown. Each request takes a ticket; a
 * result is shown only when its ticket is still the newest, nothing changed the
 * key text since, and the dialog is still open. Editing the key text or closing
 * the dialog retires every ticket in flight.
 */
export interface CompareGate {
  begin(): number;
  retire(): void;
  current(ticket: number, open: boolean): boolean;
}

export function createCompareGate(): CompareGate {
  let latest = 0;
  return {
    begin: () => ++latest,
    retire: () => { latest += 1; },
    current: (ticket, open) => open && ticket === latest,
  };
}

/** What the Compare flow changes on screen. */
export interface KeyCompareView {
  showBaseline(): void;
  showVerdict(v: SignatureVerdict): void;
  setNote(text: string): void;
  setBusy(busy: boolean): void;
}

/**
 * The Compare button's behaviour, apart from the DOM. `keyChanged` runs for
 * every change to the key text, typed or loaded from a file: it retires any
 * check in flight and puts back the verdict that does not depend on a key.
 */
export function createKeyCompareFlow(
  compare: SignerCompare,
  isOpen: () => boolean,
  view: KeyCompareView,
): { keyChanged(): void; run(keyText: string): Promise<void> } {
  const gate = createCompareGate();
  let compared = false;
  const reset = (): void => {
    if (!compared) return;
    compared = false;
    view.showBaseline();
  };
  return {
    keyChanged(): void {
      gate.retire();
      view.setNote(compared ? 'The key changed. Press Compare to check it.' : '');
      reset();
      view.setBusy(false);
    },
    async run(keyText: string): Promise<void> {
      const ticket = gate.begin();
      const checked = describeComparedKey(keyText);
      view.setNote('Checking…');
      view.setBusy(true);
      try {
        const r = await compare(keyText);
        if (!gate.current(ticket, isOpen())) return;
        view.setBusy(false);
        if (!r.signature) {
          reset();
          view.setNote('The check could not be completed.');
          return;
        }
        compared = true;
        view.showVerdict(r.signature);
        view.setNote(`Checked against: ${checked}`);
      } catch {
        if (!gate.current(ticket, isOpen())) return;
        view.setBusy(false);
        reset();
        view.setNote('The comparison could not be completed. Try again.');
      }
    },
  };
}

/** A short, readable echo of the key text a verdict was checked against. */
export function describeComparedKey(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= 24 ? t : `${t.slice(0, 12)}…${t.slice(-8)}`;
}

function fillSignature(box: HTMLElement, v: SignatureVerdict): void {
  box.replaceChildren();
  const h = signatureHeadline(v);
  const head = document.createElement('div');
  head.setAttribute('data-testid', h.testid);
  head.textContent = h.text;
  head.style.cssText = `font:600 13px system-ui,sans-serif;color:${h.color};`;
  const why = document.createElement('div');
  why.textContent = v.reason;
  why.style.cssText = 'font:12px system-ui,sans-serif;color:var(--text);opacity:0.85;';
  box.append(head, why);
  if (v.keyId) box.append(row('Key id', v.keyId));
  if (v.signedAtClaim) box.append(row('Signed at (signer\'s claim)', v.signedAtClaim));
  if (v.signerLabelUnverified) box.append(row('Signer label (not verified)', v.signerLabelUnverified));
}

/** The most a key file may hold; a public key is a few hundred bytes. */
export const KEY_FILE_MAX_BYTES = 4096;

/** What the picker says when a key file is over {@link KEY_FILE_MAX_BYTES}. */
export const KEY_FILE_TOO_LARGE = 'That key file is too large (over 4 KB), so it was not loaded. A public key is much smaller. Check that you chose the key file.';

/** The message for a key file of `size` bytes, or null when it can be read. */
export function keyFileProblem(size: number): string | null {
  return size > KEY_FILE_MAX_BYTES ? KEY_FILE_TOO_LARGE : null;
}

function signatureSection(v: SignatureVerdict, compare?: SignerCompare): HTMLElement {
  const sec = document.createElement('section');
  sec.setAttribute('data-testid', 'report-verify-signature');
  sec.setAttribute('aria-label', 'Signature');
  sec.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:4px;padding-top:8px;border-top:1px solid var(--hairline);';
  const result = document.createElement('div');
  result.setAttribute('aria-live', 'polite');
  result.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
  fillSignature(result, v);
  sec.append(result);
  if (!v.signatureValid || !compare) return sec;

  const label = document.createElement('label');
  label.textContent = 'Compare with a public key or key id you trust';
  label.htmlFor = 'olv-verify-trusted-key';
  label.style.cssText = 'font:12px system-ui,sans-serif;opacity:0.85;';
  const warn = document.createElement('div');
  warn.textContent = 'Use a key you got from the signer by another route. A key copied out of this same report proves nothing, because the report supplies it.';
  warn.style.cssText = 'font:11px system-ui,sans-serif;opacity:0.7;';
  const input = document.createElement('textarea');
  input.id = 'olv-verify-trusted-key';
  input.rows = 2;
  input.maxLength = 4096;
  input.spellcheck = false;
  input.setAttribute('data-testid', 'report-verify-trusted-key');
  input.style.cssText = 'width:100%;box-sizing:border-box;font:11px ui-monospace,monospace;color:var(--text);background:var(--panel);border:1px solid var(--hairline);border-radius:6px;padding:6px;resize:vertical;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  const btnCss = 'padding:6px 12px;border:1px solid var(--hairline);border-radius:8px;cursor:pointer;font:600 12px system-ui,sans-serif;color:var(--text);background:transparent;';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.json,.txt,application/json,text/plain';
  file.hidden = true;
  file.setAttribute('aria-label', 'Load a public key file');
  file.setAttribute('data-testid', 'report-verify-trusted-file');
  const fileNote = document.createElement('div');
  fileNote.setAttribute('role', 'status');
  fileNote.setAttribute('data-testid', 'report-verify-key-file-note');
  fileNote.style.cssText = 'font:11px system-ui,sans-serif;color:var(--rating-weak);';
  const load = document.createElement('button');
  load.type = 'button';
  load.textContent = 'Load key file';
  load.title = 'Read a public key from a file on this device.';
  load.style.cssText = btnCss;
  load.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    // Clear the chooser so picking the same file again fires `change` again.
    void keyFile.load(f).finally(() => { file.value = ''; });
  });
  const go = document.createElement('button');
  go.type = 'button';
  go.textContent = 'Compare';
  go.title = 'Check whether this signature was made by the key you entered.';
  go.setAttribute('data-testid', 'report-verify-compare');
  go.style.cssText = btnCss;
  const note = document.createElement('div');
  note.setAttribute('aria-live', 'polite');
  note.setAttribute('data-testid', 'report-verify-compare-note');
  note.style.cssText = 'font:11px system-ui,sans-serif;opacity:0.8;';
  const flow = createKeyCompareFlow(compare, () => sec.isConnected, {
    showBaseline: () => fillSignature(result, v),
    showVerdict: (sig) => fillSignature(result, sig),
    setNote: (t) => { note.textContent = t; },
    setBusy: (b) => { go.disabled = b; },
  });
  const keyFile = createKeyFileLoader({
    setText: (t) => { input.value = t; },
    keyChanged: () => flow.keyChanged(),
    setProblem: (m) => { fileNote.textContent = m; },
  }, KEY_FILE_MAX_BYTES, keyFileProblem);
  input.addEventListener('input', () => keyFile.typed());
  go.addEventListener('click', () => { void flow.run(input.value); });
  actions.append(load, go, file);
  sec.append(label, warn, input, actions, fileNote, note);
  return sec;
}

/** Render the verification result as a dismissible modal card. */
export function showReportVerification(result: VerifyReportResult, compare?: SignerCompare): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'olv-verify-backdrop';
  backdrop.setAttribute('data-testid', 'report-verify');
  backdrop.style.cssText =
    'position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.45);backdrop-filter:blur(2px);';

  const card = document.createElement('div');
  card.style.cssText =
    'min-width:min(300px,calc(100vw - 32px));max-width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:18px 20px;border-radius:12px;' +
    'background:var(--panel);border:1px solid var(--hairline);color:var(--text);' +
    'box-shadow:0 8px 30px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:10px;';
  // Dialog semantics, matching the app's other modals (Modal.ts, TourOverlay):
  // a screen reader announces the boundary and reads the verdict headline as the
  // accessible name, so the verdict is conveyed, not just coloured.
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'olv-verify-status');

  // Status headline — colour carries the verdict, the WORD carries it too. A
  // match with the legacy FNV-1a checksum is an amber caution, never the green
  // SHA-256 headline.
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
  const sigFailed = !!result.signature && !result.signature.signatureValid;
  if (!result.recognised) {
    statusText = 'Not a report';
  } else if (sigFailed) {
    statusText = 'Signature does not verify';
  } else if (!ok) {
    statusText = 'Report has been modified';
  } else if (weak) {
    statusText = 'Checksum matches (weaker FNV-1a check)';
  } else {
    statusText = 'Digest matches the contents';
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
    if (result.signature) card.append(signatureSection(result.signature, compare));
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.title = 'Close this verification report.';
  close.setAttribute('data-testid', 'report-verify-close');
  close.style.cssText =
    'align-self:flex-end;margin-top:6px;padding:6px 14px;border:0;border-radius:8px;cursor:pointer;' +
    'font:600 12px system-ui,sans-serif;color:var(--on-accent);background:var(--accent);';
  // The card joins the shared dialog stack (Modal.ts) once it is in the page;
  // dismiss removes the node and takes the card off the stack, so closing via
  // Close / backdrop / Escape never leaves a stale handler attached.
  let a11y: DialogA11yHandle | null = null;
  const dismiss = (): void => {
    backdrop.remove();
    a11y?.teardown();
  };
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  card.append(close);

  backdrop.append(card);
  document.body.append(backdrop);
  // Escape dismisses, Tab / Shift+Tab cycle inside it, and the palette, the
  // shortcut sheet and Help do not open over it. A dialog opened above it
  // takes those keys until it closes.
  a11y = wireDialogA11y(card, { onEscape: dismiss });
  // Land focus inside the dialog so the trap has somewhere to cycle from.
  (focusableIn(card)[0] ?? close).focus();
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
      `(${formatBytesIn(sizeBytes, 'MiB', 0)}; limit ` +
      `${formatBytesIn(MAX_REPORT_TEXT_BYTES, 'MiB', 0)}).`,
  };
}

/** Read a report file, verify it, and show the result. Never throws. */
export async function verifyAndShow(file: File): Promise<void> {
  const oversize = oversizeReportResult(file.size);
  if (oversize) {
    showReportVerification(oversize);
    return;
  }
  try {
    await verifyAndShowChecked(file);
  } catch {
    showReportVerification({ recognised: false, valid: false, reason: 'This file could not be checked.' });
  }
}

async function verifyAndShowChecked(file: File): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    showReportVerification({ recognised: false, valid: false, reason: 'Could not read the file.' });
    return;
  }
  showReportVerification(await verifyReportFileWithSignature(text), (key) => verifyReportFileWithSignature(text, key));
}
