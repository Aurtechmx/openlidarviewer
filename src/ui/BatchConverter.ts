/**
 * BatchConverter.ts — the splash-screen batch format converter.
 *
 * A self-contained modal overlay: add many files, choose one output format and
 * a CRS action, convert all in one click, then download each result or all of
 * them as a single .zip. No project or 3D view required — it decodes, converts
 * and writes entirely client-side.
 *
 * UX shape (Gestalt: one grouped region per decision, top → bottom):
 *   Files  →  Output format  →  Coordinate system  →  Convert  →  Results
 * A single primary action ("Convert"); validation gates it with a plain-language
 * reason; each file is isolated so one failure never sinks the batch; LAZ is
 * shown but disabled with an honest reason rather than producing a bad file.
 */

import { el } from './dom';
import { downloadBytes } from '../io/download';
import { formatByteSize as formatBytes } from '../io/formatByteSize';
import { decodeFull } from '../convert/decodeFull';
import { runBatch, summariseBatch, type BatchInput, type BatchItemResult } from '../convert/convertRunner';
import { buildZip, assessZipDownload } from '../convert/zipStore';
import { CONVERT_FORMATS, type ConvertFormat, type CrsMode, type ConvertOptions } from '../convert/types';

const ACCEPT = '.las,.laz,.xyz,.asc,.txt,.csv,.pts,.ptx,.ply,.pcd,.e57';

export class BatchConverter {
  readonly element: HTMLElement;
  private readonly _dialog: HTMLElement;
  private readonly _fileList: HTMLElement;
  private readonly _crsExtra: HTMLElement;
  private readonly _convertBtn: HTMLButtonElement;
  private readonly _hint: HTMLElement;
  private readonly _results: HTMLElement;
  private readonly _formatRow: HTMLElement;
  /**
   * Visible footnote for any format pill that is shown but disabled. WHY
   * visible: the pill's `title` carries the "why" (e.g. LAZ isn't available
   * yet), but a `title` is hover-only — on touch the greyed pill had no
   * explanation at all. This line restates it in the flow.
   */
  private readonly _formatNote: HTMLElement;
  private readonly _crsRow: HTMLElement;

  private _files: BatchInput[] = [];
  // LAS 1.4 is the default: modern consumers all read it, and its extended
  // point formats keep the full 8-bit classification (1.2 clamps to 5 bits).
  // LAS 1.2 stays selectable for legacy-tool compatibility.
  private _format: ConvertFormat = 'las14';
  private _crsMode: CrsMode = 'keep';
  private _targetEpsg = '';
  private _sourceEpsg = '';
  private _busy = false;
  private _produced: { filename: string; bytes: Uint8Array }[] = [];

  constructor(host: HTMLElement) {
    this.element = el('div', { className: 'olv-bc-overlay olv-bc-hidden' });
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close(); // click backdrop to dismiss
    });

    this._dialog = el('div', { className: 'olv-bc-dialog' });
    const head = el('div', { className: 'olv-bc-head' });
    head.append(
      el('h2', { className: 'olv-bc-title', text: 'Batch convert' }),
      (() => {
        const x = el('button', { className: 'olv-bc-close', text: '✕', ariaLabel: 'Close' });
        x.addEventListener('click', () => this.close());
        return x;
      })(),
    );

    this._fileList = el('div', { className: 'olv-bc-files' });
    this._formatRow = el('div', { className: 'olv-bc-pills' });
    this._formatNote = el('p', { className: 'olv-bc-format-note olv-bc-hidden' });
    this._crsRow = el('div', { className: 'olv-bc-pills' });
    this._crsExtra = el('div', { className: 'olv-bc-crs-extra' });
    this._hint = el('p', { className: 'olv-bc-hint' });
    this._convertBtn = el('button', { className: 'olv-bc-convert', type: 'button' }) as HTMLButtonElement;
    this._convertBtn.addEventListener('click', () => void this._convert());
    this._results = el('div', { className: 'olv-bc-results' });

    this._dialog.append(
      head,
      this._section('Files', this._buildFilesSection()),
      this._section('Output format', (() => {
        const wrap = el('div');
        wrap.append(this._formatRow, this._formatNote);
        return wrap;
      })()),
      this._section('Coordinate system', (() => {
        const wrap = el('div');
        wrap.append(this._crsRow, this._crsExtra);
        return wrap;
      })()),
      (() => {
        const actions = el('div', { className: 'olv-bc-actions' });
        actions.append(this._convertBtn, this._hint);
        return actions;
      })(),
      this._results,
    );
    this.element.append(this._dialog);
    host.append(this.element);

    this._renderFormatPills();
    this._renderCrsPills();
    this._renderCrsExtra();
    this._renderFileList();
    this._refresh();
  }

  open(): void {
    this.element.classList.remove('olv-bc-hidden');
  }

  close(): void {
    this.element.classList.add('olv-bc-hidden');
  }

  // ── sections ────────────────────────────────────────────────────────────
  private _section(title: string, body: HTMLElement): HTMLElement {
    const s = el('section', { className: 'olv-bc-section' });
    s.append(el('div', { className: 'olv-bc-section-label', text: title }), body);
    return s;
  }

  private _buildFilesSection(): HTMLElement {
    const wrap = el('div');
    const drop = el('label', { className: 'olv-bc-drop' });
    const input = el('input', { className: 'olv-file-input', type: 'file' }) as HTMLInputElement;
    input.multiple = true;
    input.accept = ACCEPT;
    input.addEventListener('change', () => {
      if (input.files) void this._addFiles(input.files);
      input.value = '';
    });
    drop.append(
      input,
      el('span', { className: 'olv-bc-drop-text', text: 'Drop point-cloud files here, or click to choose' }),
      el('span', { className: 'olv-bc-drop-sub', text: 'LAS, LAZ, XYZ, ASC and more · everything stays on your device' }),
    );
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-drag');
      if (e.dataTransfer?.files) void this._addFiles(e.dataTransfer.files);
    });
    wrap.append(drop, this._fileList);
    return wrap;
  }

  private _addFiles(files: FileList): void {
    for (const f of Array.from(files)) {
      // Store a File reference + a LAZY byte reader, never the bytes. A File is a
      // cheap handle to the on-disk blob; its ArrayBuffer is materialised only
      // when this file's turn comes in `runBatch`, then released — so adding ten
      // multi-GB files no longer loads them all into memory at once. An
      // unreadable file now surfaces a per-file error at convert time instead of
      // silently vanishing here.
      this._files.push({ name: f.name, sizeBytes: f.size, bytes: () => f.arrayBuffer() });
    }
    this._renderFileList();
    this._refresh();
  }

  private _renderFileList(): void {
    this._fileList.replaceChildren();
    if (this._files.length === 0) return;
    this._files.forEach((f, i) => {
      const row = el('div', { className: 'olv-bc-file-row' });
      const remove = el('button', { className: 'olv-bc-file-del', text: '✕', ariaLabel: `Remove ${f.name}` });
      remove.addEventListener('click', () => {
        this._files.splice(i, 1);
        this._renderFileList();
        this._refresh();
      });
      row.append(
        el('span', { className: 'olv-bc-file-name', text: f.name }),
        el('span', { className: 'olv-bc-file-size', text: formatBytes(f.sizeBytes) }),
        remove,
      );
      this._fileList.append(row);
    });
  }

  // ── format + CRS controls ────────────────────────────────────────────────
  private _renderFormatPills(): void {
    this._formatRow.replaceChildren();
    // The reason an unavailable format is disabled — shared between the pill's
    // (hover-only) title and the visible footnote so touch users see it too.
    const unavailableReason =
      'In-browser LAZ compression isn’t available yet — choose LAS for an uncompressed file.';
    let anyUnavailable = false;
    (Object.keys(CONVERT_FORMATS) as ConvertFormat[]).forEach((fmt) => {
      const spec = CONVERT_FORMATS[fmt];
      const pill = el('button', {
        className: `olv-bc-pill${this._format === fmt ? ' is-active' : ''}${spec.available ? '' : ' is-disabled'}`,
        text: spec.label,
        type: 'button',
      }) as HTMLButtonElement;
      if (!spec.available) {
        anyUnavailable = true;
        pill.disabled = true;
        pill.title = unavailableReason;
      } else {
        pill.addEventListener('click', () => {
          this._format = fmt;
          this._renderFormatPills();
          this._refresh();
        });
      }
      this._formatRow.append(pill);
    });
    // Restate the gate reason visibly when a format is greyed out.
    this._formatNote.textContent = anyUnavailable ? unavailableReason : '';
    this._formatNote.classList.toggle('olv-bc-hidden', !anyUnavailable);
  }

  private _renderCrsPills(): void {
    this._crsRow.replaceChildren();
    const modes: { mode: CrsMode; label: string; title: string }[] = [
      { mode: 'keep', label: 'Keep', title: 'Leave coordinates and any CRS tag as they are' },
      { mode: 'assign', label: 'Assign EPSG', title: 'Tag a CRS without moving points (fix a mislabelled file)' },
      { mode: 'reproject', label: 'Reproject', title: 'Transform coordinates to a target CRS' },
    ];
    modes.forEach(({ mode, label, title }) => {
      const pill = el('button', {
        className: `olv-bc-pill${this._crsMode === mode ? ' is-active' : ''}`,
        text: label,
        title,
        type: 'button',
      });
      pill.addEventListener('click', () => {
        this._crsMode = mode;
        this._renderCrsPills();
        this._renderCrsExtra();
        this._refresh();
      });
      this._crsRow.append(pill);
    });
  }

  private _renderCrsExtra(): void {
    this._crsExtra.replaceChildren();
    if (this._crsMode === 'keep') return;
    if (this._crsMode === 'reproject') {
      this._crsExtra.append(
        this._epsgField('Source EPSG (optional — uses the file’s CRS if present)', this._sourceEpsg, (v) => { this._sourceEpsg = v; this._refresh(); }),
      );
    }
    this._crsExtra.append(
      this._epsgField('Target EPSG (e.g. 32611)', this._targetEpsg, (v) => { this._targetEpsg = v; this._refresh(); }),
    );
  }

  private _epsgField(label: string, value: string, onInput: (v: string) => void): HTMLElement {
    const wrap = el('label', { className: 'olv-bc-field' });
    const input = el('input', { className: 'olv-bc-input', type: 'text' }) as HTMLInputElement;
    input.inputMode = 'numeric';
    input.placeholder = 'EPSG code';
    input.value = value;
    input.addEventListener('input', () => onInput(input.value.trim()));
    wrap.append(el('span', { className: 'olv-bc-field-label', text: label }), input);
    return wrap;
  }

  // ── validation + convert ─────────────────────────────────────────────────
  private _validate(): { ok: boolean; reason: string } {
    if (this._files.length === 0) return { ok: false, reason: 'Add at least one file to convert.' };
    const target = parseEpsg(this._targetEpsg);
    if (this._crsMode === 'assign' && target == null) {
      return { ok: false, reason: 'Enter the EPSG code to assign.' };
    }
    if (this._crsMode === 'reproject' && target == null) {
      return { ok: false, reason: 'Enter the target EPSG to reproject to.' };
    }
    // Files convert one at a time (bounded memory), but a very large total is
    // still worth surfacing so the user isn't surprised by a long run.
    const totalBytes = this._files.reduce((sum, f) => sum + f.sizeBytes, 0);
    const n = this._files.length;
    return {
      ok: true,
      reason: `${n} file${n > 1 ? 's' : ''} (${formatBytes(totalBytes)}) ready · ${CONVERT_FORMATS[this._format].label} output`,
    };
  }

  private _refresh(): void {
    const n = this._files.length;
    this._convertBtn.textContent = this._busy ? 'Converting…' : `Convert ${n || ''} file${n === 1 ? '' : 's'}`.replace('  ', ' ');
    const v = this._validate();
    this._convertBtn.disabled = this._busy || !v.ok;
    this._hint.textContent = this._busy ? '' : v.reason;
    this._hint.className = `olv-bc-hint${v.ok ? '' : ' is-blocked'}`;
  }

  private async _convert(): Promise<void> {
    if (this._busy || !this._validate().ok) return;
    this._busy = true;
    this._produced = [];
    this._results.replaceChildren();
    this._refresh();

    const options: ConvertOptions = {
      format: this._format,
      crsMode: this._crsMode,
      targetEpsg: parseEpsg(this._targetEpsg),
      sourceEpsg: parseEpsg(this._sourceEpsg),
    };

    let results: BatchItemResult[] = [];
    try {
      results = await runBatch(this._files, options, decodeFull, (p) => {
        this._convertBtn.textContent = `Converting ${p.index + 1}/${p.total}…`;
      });
    } catch (err) {
      this._results.append(el('p', { className: 'olv-bc-row-error', text: `Conversion stopped: ${err instanceof Error ? err.message : String(err)}` }));
    }

    this._produced = results.flatMap((r) => {
      const out: { filename: string; bytes: Uint8Array }[] = [];
      if (r.file) out.push({ filename: r.file.filename, bytes: r.file.bytes });
      if (r.sidecar) out.push({ filename: r.sidecar.filename, bytes: r.sidecar.bytes });
      return out;
    });
    this._busy = false;
    this._renderResults(results);
    this._refresh();
  }

  private _renderResults(results: BatchItemResult[]): void {
    this._results.replaceChildren();
    if (results.length === 0) return;

    const sum = summariseBatch(results);
    const header = el('div', { className: 'olv-bc-results-head' });
    header.append(
      el('span', {
        className: 'olv-bc-results-summary',
        text: `${sum.ok} converted${sum.failed ? `, ${sum.failed} failed` : ''} · ${sum.points.toLocaleString()} points`,
      }),
    );
    if (this._produced.length > 1) {
      // The .zip is assembled whole in memory with classic 32-bit ZIP fields, so
      // a very large batch can't be zipped (it would overflow or exhaust memory).
      // In that case steer to the per-file Download buttons below instead.
      const z = assessZipDownload(this._produced.map((p) => ({ name: p.filename, bytes: p.bytes })));
      if (z.ok) {
        const all = el('button', { className: 'olv-bc-dlall', text: `Download all (.zip)`, type: 'button' });
        all.addEventListener('click', () => this._downloadZip());
        header.append(all);
      } else {
        header.append(
          el('span', {
            className: 'olv-bc-dlall-note',
            text: `Too large for one .zip (${z.reason}) — download files individually below.`,
          }),
        );
      }
    }
    this._results.append(header);

    for (const r of results) {
      const ok = r.report.ok;
      const row = el('div', { className: `olv-bc-row ${ok ? 'is-ok' : 'is-error'}` });
      const top = el('div', { className: 'olv-bc-row-top' });
      top.append(
        el('span', { className: 'olv-bc-row-icon', text: ok ? '●' : '▲' }),
        el('span', { className: 'olv-bc-row-name', text: r.source }),
        el('span', { className: 'olv-bc-row-meta', text: ok ? `${r.report.pointCount.toLocaleString()} pts · ${r.report.crsNote}` : 'failed' }),
      );
      if (ok && r.file) {
        const dl = el('button', { className: 'olv-bc-row-dl', text: 'Download', type: 'button' });
        dl.addEventListener('click', () => downloadBytes(r.file!.filename, r.file!.bytes, r.file!.mime));
        top.append(dl);
      }
      row.append(top);
      // Surface warnings/errors inline, near their source.
      const notable = r.report.log.filter((l) => l.level !== 'info');
      if (notable.length) {
        const log = el('ul', { className: 'olv-bc-row-log' });
        for (const line of notable) {
          log.append(el('li', { className: `olv-bc-log-${line.level}`, text: line.message }));
        }
        row.append(log);
      }
      this._results.append(row);
    }
  }

  private _downloadZip(): void {
    const zip = buildZip(this._produced.map((p) => ({ name: p.filename, bytes: p.bytes })));
    downloadBytes('openlidarviewer-converted.zip', zip, 'application/zip');
  }
}

// ── small local helpers ─────────────────────────────────────────────────────
function parseEpsg(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}


