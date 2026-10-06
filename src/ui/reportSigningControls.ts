/**
 * reportSigningControls.ts
 *
 * The "Sign this report" option in the Export panel's Products lane: a toggle
 * (off by default), a one-time key-creation step that says what the key is and
 * is not, a signer-label field, and Show / Copy for the public key. All text
 * is set with textContent. No network calls: the key never leaves the browser.
 */

import { el } from './dom';
import { SigningError, cleanSignerLabel, MAX_SIGNER_LABEL_CHARS, signingAvailable } from '../export/reportSignature';
import {
  createSigningKey,
  deleteSigningKey,
  indexedDbBackend,
  loadSigningKey,
  publicKeyText,
  type SigningKeyBackend,
} from '../export/reportSigningKeyStore';
import { reportSignerLabel, reportSigningRequested, setReportSignerLabel, setReportSigningRequested } from '../export/reportSigningState';

export const KEY_CREATION_EXPLANATION =
  'This creates a signing key in this browser. The private key cannot be exported and stays on this device. ' +
  'It lives in this browser profile only: clearing site data deletes it, and a private window forgets it when the window closes. ' +
  'Every report you sign carries this key\'s id, so anyone holding two of them can tell the same key signed both. ' +
  'A signature shows that the holder of this key signed the report. It does not show who that person is.';

export function buildReportSigningControls(backend: SigningKeyBackend = indexedDbBackend): HTMLElement {
  const root = el('div', { className: 'olv-sign' });
  root.setAttribute('data-testid', 'report-signing');

  const row = el('div', { className: 'olv-export-fullres' });
  const label = el('label', { className: 'olv-export-fullres-label' });
  const box = el('input', { className: 'olv-export-fullres-box', type: 'checkbox' });
  box.setAttribute('data-testid', 'report-sign-toggle');
  label.append(box, el('span', { text: 'Sign this report' }));
  const hint = el('span', {
    className: 'olv-export-fullres-hint',
    text: 'Adds a signature from a key kept in this browser, so a later change to its figures is detected. Applies to both report exports.',
  });
  row.append(label, hint);

  const body = el('div', { className: 'olv-sign-body' });
  body.hidden = true;
  const status = el('div', { className: 'olv-sign-status' });
  status.setAttribute('role', 'status');
  status.setAttribute('data-testid', 'report-sign-status');
  root.append(row, body, status);

  const say = (t: string): void => { status.textContent = t; };
  // Each toggle starts a new run. A run that finds it is no longer the latest, or
  // finds the box unchecked, stops without touching the signing choice.
  let run = 0;

  if (!signingAvailable()) {
    box.disabled = true;
    say('Signing is unavailable: this browser cannot sign reports.');
    return root;
  }

  const button = (text: string, testid: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', { className: 'olv-bc-pill olv-export-product-btn', type: 'button', text }) as HTMLButtonElement;
    b.title = title;
    b.setAttribute('data-testid', testid);
    b.addEventListener('click', onClick);
    return b;
  };

  const showKeyControls = (key: { publicKey: Parameters<typeof publicKeyText>[0]['publicKey']; keyId: string }): void => {
    body.replaceChildren();
    const labelId = 'olv-sign-label';
    const labelText = el('label', { className: 'olv-export-fullres-hint', text: 'Signer label (optional, not verified)' });
    labelText.htmlFor = labelId;
    const input = el('input', { className: 'olv-sign-label', type: 'text' }) as HTMLInputElement;
    input.id = labelId;
    input.maxLength = MAX_SIGNER_LABEL_CHARS;
    input.autocomplete = 'off';
    input.setAttribute('data-testid', 'report-sign-label');
    input.value = reportSignerLabel();
    input.addEventListener('input', () => setReportSignerLabel(cleanSignerLabel(input.value)));

    const keyBox = el('textarea', { className: 'olv-sign-key' }) as HTMLTextAreaElement;
    keyBox.readOnly = true;
    keyBox.rows = 4;
    keyBox.hidden = true;
    keyBox.value = publicKeyText(key);
    keyBox.setAttribute('aria-label', 'Your public key');
    keyBox.setAttribute('data-testid', 'report-sign-public-key');

    const idLine = el('div', { className: 'olv-export-fullres-hint', text: `Key id: ${key.keyId}` });
    idLine.setAttribute('data-testid', 'report-sign-key-id');

    const show = button('Show my public key', 'report-sign-show', 'Show the public key that verifies your signatures.', () => {
      keyBox.hidden = !keyBox.hidden;
      show.setAttribute('aria-expanded', String(!keyBox.hidden));
      show.textContent = keyBox.hidden ? 'Show my public key' : 'Hide my public key';
    });
    show.setAttribute('aria-expanded', 'false');
    const copy = button('Copy public key', 'report-sign-copy', 'Copy the public key so others can compare it.', () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(publicKeyText(key));
          say('Public key copied.');
        } catch {
          say('Could not copy. Choose Show my public key and select the text.');
        }
      })();
    });
    const del = button('Delete signing key', 'report-sign-delete', 'Delete the signing key from this browser. Reports signed earlier still verify.', () => {
      confirmRow.hidden = false;
      del.hidden = true;
    });
    const confirmRow = el('div', { className: 'olv-sign-intro' });
    confirmRow.hidden = true;
    confirmRow.setAttribute('role', 'group');
    confirmRow.setAttribute('aria-label', 'Confirm deleting the signing key');
    const sure = el('p', { className: 'olv-export-fullres-hint', text: 'Delete this key? Reports signed with it still verify, but you cannot sign with it again. Creating a new key gives a new key id.' });
    const yes = button('Delete key', 'report-sign-delete-confirm', 'Delete the signing key now.', () => {
      void (async () => {
        const mine = ++run;
        try {
          await deleteSigningKey(backend);
        } catch {
          say('The key could not be deleted. It is still in use.');
          return;
        }
        if (mine !== run) return;
        box.checked = false;
        setReportSigningRequested(false);
        showCreate();
        say('Signing key deleted. Reports stay unsigned until you create a new key.');
      })();
    });
    const no = button('Keep key', 'report-sign-delete-cancel', 'Keep the signing key.', () => {
      confirmRow.hidden = true;
      del.hidden = false;
    });
    confirmRow.append(sure, yes, no);
    body.append(labelText, input, idLine, show, keyBox, copy, del, confirmRow);
  };

  const showCreate = (): void => {
    body.replaceChildren();
    const intro = el('div', { className: 'olv-sign-intro' });
    intro.setAttribute('role', 'group');
    intro.setAttribute('aria-label', 'Create a signing key');
    const text = el('p', { className: 'olv-export-fullres-hint', text: KEY_CREATION_EXPLANATION });
    const create = button('Create signing key', 'report-sign-create', 'Create the signing key in this browser.', () => {
      void (async () => {
        const mine = ++run;
        try {
          const key = await createSigningKey(new Date().toISOString(), backend);
          if (mine !== run) return;
          box.checked = true;
          setReportSigningRequested(true);
          showKeyControls(key);
          say('Signing key created. Reports will be signed.');
        } catch {
          say('The key could not be created in this browser. Reports stay unsigned.');
        }
      })();
    });
    intro.append(text, create);
    body.append(intro);
  };

  const apply = (): void => {
    void (async () => {
      const mine = ++run;
      if (!box.checked) {
        setReportSigningRequested(false);
        body.hidden = true;
        say('');
        return;
      }
      body.hidden = false;
      try {
        const key = await loadSigningKey(backend);
        if (mine !== run || !box.checked) return;
        if (key) {
          setReportSigningRequested(true);
          showKeyControls(key);
          say('Reports will be signed with your key.');
        } else {
          box.checked = false;
          setReportSigningRequested(false);
          showCreate();
          say('Create a signing key to sign reports.');
        }
      } catch (e) {
        if (mine !== run) return;
        box.checked = false;
        setReportSigningRequested(false);
        body.hidden = true;
        say(e instanceof SigningError ? e.message : 'Signing is unavailable: this browser would not open its key storage.');
      }
    })();
  };
  box.addEventListener('change', apply);
  // The panel rebuilds this block when its measurements change. A choice made
  // earlier must show as made, or the file would be signed while the box reads off.
  if (reportSigningRequested()) {
    box.checked = true;
    apply();
  }

  return root;
}
