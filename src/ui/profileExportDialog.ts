/**
 * profileExportDialog.ts: what the user adds to a profile's exported sheets,
 * asked before the PDF is made.
 *
 * Every field is optional: Export with nothing typed gives the sheet as it is.
 * The company, logo and people are kept on this device only when the user
 * ticks the box; the job is kept for the session; the rest belongs to this
 * profile. Measured figures, sources and caveats are not fields.
 */
import { onSheetStyleChange, sheetStyle } from '../export/sheetKit/sessionStyle';
import type { ProfilePaper } from '../render/measure/profilePdf';
import {
  cleanCompany, cleanJob, cleanLogo, cleanProfileFields, companyDetails, FIELD_LIMITS, isEmptyFields, jobDetails,
  MAX_ISSUES, MAX_LOGO_CHARS, MAX_MARKS, setCompanyDetails, setJobDetails,
  type DeliverableStatus, type MarkedPoint, type ProfileDeliverable, type ProfileSheetFields,
} from '../model/deliverableFields';
import { rememberCompany, rememberedCompany } from './companyStore';
import { el } from './dom';
import { exportLanguageControl } from './exportLanguageControl';
import { openModal } from './Modal';
import { sheetStyleControl } from './sheetStyleControl';

export interface ProfileExportDialogInput {
  readonly profileName: string;
  readonly scanName: string | null;
  /** Line length, metres (source units when unverified). */
  readonly lengthM: number;
  readonly unitSystem: 'metric' | 'imperial' | 'unverified';
  readonly fields: ProfileSheetFields;
  readonly defaultFileName: string;
  readonly returnFocusTo?: HTMLElement | null;
}

export interface ProfileExportChoice {
  readonly deliverable: ProfileDeliverable;
  readonly fields: ProfileSheetFields;
  readonly fileName: string;
  readonly paper: ProfilePaper;
  readonly unitSystem: 'metric' | 'imperial' | 'unverified';
}

const FEET = 1 / 0.3048;

/**
 * A chainage as typed, in metres of the line: "34.5", "34,5" or a station,
 * "0+034.50" (metric) or "1+13.45" (feet). Null when it is neither.
 */
export function parseChainage(raw: string, unit: 'metric' | 'imperial' | 'unverified'): number | null {
  const s = raw.trim().replace(',', '.');
  const st = /^(\d{1,4})\+(\d{1,3}(?:\.\d+)?)$/.exec(s);
  let v: number;
  if (st && unit !== 'unverified') v = Number(st[1]) * (unit === 'metric' ? 1000 : 100) + Number(st[2]);
  else if (/^\d+(?:\.\d+)?$/.test(s)) v = Number(s);
  else return null;
  return unit === 'imperial' ? v / FEET : v;
}

/** Characters the sheet fonts may not have. */
export const unusualCharacters = (s: string): boolean => /[^\u0009\u000a -ɏʻ-˝‐-…‰′″‹›₠-₿№™Ω←-↓∂-≥]/u.test(s);

/** Image types a logo can be given as; each is redrawn as PNG. */
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

/** An image file as a PNG data URL small enough to print and keep, scaled down when it must be. Throws with a reason the user can act on. */
async function readLogo(file: File): Promise<string> {
  if (!LOGO_TYPES.includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or SVG image.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('That image could not be read.')); img.src = url; });
    if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) throw new Error('That image does not say how large it is. Save it as PNG and try again.');
    // A drawing is taken large enough to print sharply; a photograph is never enlarged.
    const fit = 800 / Math.max(img.naturalWidth, img.naturalHeight);
    const k = file.type === 'image/svg+xml' ? fit : Math.min(1, fit);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('That image could not be read.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let data: string;
    try {
      data = canvas.toDataURL('image/png');
      // A photograph can be too large as PNG; on white it is the same to the eye as JPEG.
      if (data.length > MAX_LOGO_CHARS) {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        data = canvas.toDataURL('image/jpeg', 0.85);
      }
    } catch {
      throw new Error('That image could not be read. Save it as PNG and try again.');
    }
    canvas.width = 0; canvas.height = 0;
    const clean = cleanLogo(data);
    if (!clean) throw new Error('That image is too large. Choose a simpler or smaller logo.');
    return clean;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let nextId = 0;

/** A labelled control; the label names it for assistive technology. */
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = `olv-pe-${++nextId}`;
  control.id = id;
  const l = el('label', { className: 'olv-modal-label', text: label });
  l.setAttribute('for', id);
  const box = el('div', { className: 'olv-modal-field' }, [l, control]);
  if (hint) {
    const h = el('p', { className: 'olv-modal-hint', text: hint });
    h.id = `${id}-hint`;
    control.setAttribute('aria-describedby', h.id);
    box.append(h);
  }
  return box;
}

function input(value: string | undefined, max: number, placeholder = ''): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'olv-modal-input';
  i.maxLength = max;
  i.value = value ?? '';
  i.placeholder = placeholder;
  i.autocomplete = 'off';
  return i;
}

function choose(options: ReadonlyArray<readonly [string, string]>, value: string): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'olv-modal-input';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    s.append(o);
  }
  s.value = value;
  return s;
}

function section(title: string, open: boolean, children: HTMLElement[]): HTMLElement {
  const d = document.createElement('details');
  d.className = 'olv-modal-details';
  d.open = open;
  d.append(el('summary', { className: 'olv-modal-summary', text: title }), el('div', { className: 'olv-modal-grid' }, children));
  return d;
}

interface RowList<R> {
  readonly element: HTMLElement;
  rows(): R[];
}

/** A short list of rows the user adds and removes, with one input per column. */
function rowList(o: {
  readonly columns: ReadonlyArray<{ readonly label: string; readonly max: number; readonly wide?: boolean; readonly placeholder?: string }>;
  readonly values: readonly string[][];
  readonly max: number;
  readonly addLabel: string;
  readonly rowLabel: string;
}): RowList<string[]> {
  const list = el('div', { className: 'olv-pe-rows' });
  const add = el('button', { className: 'olv-modal-btn olv-modal-cancel olv-pe-add', text: o.addLabel }) as HTMLButtonElement;
  add.type = 'button';
  const rows: HTMLInputElement[][] = [];
  const sync = (): void => { add.disabled = rows.length >= o.max; };
  const addRow = (vals: readonly string[], focus: boolean): void => {
    const inputs = o.columns.map((c, n) => {
      const i = input(vals[n], c.max, c.placeholder ?? c.label);
      i.setAttribute('aria-label', `${c.label}, ${o.rowLabel} ${rows.length + 1}`);
      if (c.wide) i.classList.add('olv-pe-wide');
      return i;
    });
    const del = el('button', { className: 'olv-modal-btn olv-modal-cancel olv-pe-del', text: '×', ariaLabel: `Remove ${o.rowLabel}` }) as HTMLButtonElement;
    del.type = 'button';
    const line = el('div', { className: 'olv-pe-row' }, [...inputs, del]);
    del.addEventListener('click', () => {
      rows.splice(rows.indexOf(inputs), 1);
      line.remove();
      sync();
      (rows.length > 0 ? rows[rows.length - 1]![0]! : add).focus();
    });
    rows.push(inputs);
    list.append(line);
    sync();
    if (focus) inputs[0]!.focus();
  };
  for (const v of o.values) addRow(v, false);
  add.addEventListener('click', () => addRow([], true));
  sync();
  return { element: el('div', { className: 'olv-modal-field' }, [list, add]), rows: () => rows.map((r) => r.map((i) => i.value)) };
}

/**
 * Ask, then run `run` with the choice. Stays open with the reason when `run`
 * fails. Resolves true when a file was made, false when the user closed it.
 */
export function openProfileExportDialog(p: ProfileExportDialogInput, run: (c: ProfileExportChoice) => Promise<void>): Promise<boolean> {
  const remembered = rememberedCompany();
  const who = isEmptyFields(companyDetails()) && remembered ? remembered : companyDetails();
  const job = jobDetails(), f = p.fields;
  const unitOf = { metric: 'm', imperial: 'ft', unverified: 'units' } as const;

  const title = input(f.title, FIELD_LIMITS.title, p.profileName);
  const subtitle = input(f.subtitle, FIELD_LIMITS.subtitle, 'Longitudinal section A to B, corridor width');
  const project = input(job.project, FIELD_LIMITS.project, p.scanName ?? '');
  const client = input(job.client, FIELD_LIMITS.client);
  const location = input(job.location, FIELD_LIMITS.location);
  const company = input(who.company, FIELD_LIMITS.company);
  const prepared = input(who.preparedBy, FIELD_LIMITS.preparedBy);
  const checked = input(who.checkedBy, FIELD_LIMITS.checkedBy);
  const approved = input(who.approvedBy, FIELD_LIMITS.approvedBy);
  const drawing = input(f.drawingNo, FIELD_LIMITS.drawingNo);
  const revision = input(f.revision, FIELD_LIMITS.revision);
  const date = input(job.date, FIELD_LIMITS.date, 'As it should print, such as 23 Nov 2026');
  const status = choose([['preliminary', 'Preliminary'], ['review', 'For review'], ['issued', 'Issued']], job.status ?? 'preliminary');
  const endA = input(f.endA, FIELD_LIMITS.endA), endB = input(f.endB, FIELD_LIMITS.endB);
  const notes = document.createElement('textarea');
  notes.className = 'olv-modal-input olv-modal-textarea';
  notes.maxLength = FIELD_LIMITS.notes;
  notes.rows = 4;
  notes.value = f.notes ?? '';
  const paper = choose([['a3', 'A3'], ['tabloid', 'Tabloid (11 x 17 in)']], 'a3');
  const units = p.unitSystem === 'unverified'
    ? choose([['unverified', 'Source units (unverified)']], 'unverified')
    : choose([['metric', 'Metres'], ['imperial', 'Feet']], p.unitSystem);
  if (p.unitSystem === 'unverified') units.disabled = true;
  const fileName = input(p.defaultFileName.replace(/\.pdf$/i, ''), 120);

  // ── logo ───────────────────────────────────────────────────────────────
  let logo = who.logoDataUrl;
  const logoFile = document.createElement('input');
  logoFile.type = 'file';
  logoFile.accept = LOGO_TYPES.join(',');
  logoFile.className = 'olv-modal-input';
  const logoShow = document.createElement('img');
  logoShow.className = 'olv-pe-logo';
  logoShow.alt = 'Logo to print';
  const logoDrop = el('button', { className: 'olv-modal-btn olv-modal-cancel', text: 'Remove logo' }) as HTMLButtonElement;
  logoDrop.type = 'button';
  const logoSay = el('p', { className: 'olv-modal-hint' });
  logoSay.setAttribute('role', 'status');
  const showLogo = (): void => {
    logoShow.hidden = logoDrop.hidden = !logo;
    if (logo) logoShow.src = logo; else logoShow.removeAttribute('src');
  };
  logoFile.addEventListener('change', () => {
    const file = logoFile.files?.[0];
    if (!file) return;
    logoSay.textContent = '';
    void readLogo(file).then((d) => { logo = d; showLogo(); }, (e: unknown) => {
      logoSay.textContent = e instanceof Error ? e.message : 'That image could not be read.';
      logoFile.value = '';
    });
  });
  logoDrop.addEventListener('click', () => { logo = undefined; logoFile.value = ''; showLogo(); logoFile.focus(); });
  showLogo();
  const logoField = field('Logo', logoFile, 'PNG, JPEG, WebP or SVG. Printed at the head of every Light and Dark sheet, on white on a Dark one.');
  logoField.append(logoShow, logoDrop, logoSay);

  const remember = document.createElement('input');
  remember.type = 'checkbox';
  remember.checked = remembered !== null;
  const rememberLabel = el('label', { className: 'olv-pe-check' }, [remember, 'Remember company, logo and people on this device']);

  // ── rows ───────────────────────────────────────────────────────────────
  const issues = rowList({
    columns: [
      { label: 'Issue', max: FIELD_LIMITS.issue }, { label: 'Description', max: FIELD_LIMITS.issueDescription, wide: true }, { label: 'Date', max: FIELD_LIMITS.date },
      { label: 'By', max: FIELD_LIMITS.issueBy }, { label: 'Checked', max: FIELD_LIMITS.issueBy },
    ],
    values: (f.issues ?? []).map((r) => [r.issue, r.description, r.date, r.by, r.checked]), max: MAX_ISSUES, addLabel: 'Add an issue', rowLabel: 'issue',
  });
  const shownUnit = (): 'metric' | 'imperial' | 'unverified' => (p.unitSystem === 'unverified' ? 'unverified' : (units.value as 'metric' | 'imperial'));
  const toShown = (m: number): string => Number((p.unitSystem === 'imperial' ? m * FEET : m).toFixed(3)).toString();
  const marks = rowList({
    columns: [{ label: 'Chainage', max: 14, placeholder: '0+034.5' }, { label: 'Text', max: FIELD_LIMITS.mark, wide: true }],
    values: (f.marks ?? []).map((m) => [toShown(m.chainage), m.text]), max: MAX_MARKS, addLabel: 'Add a marked point', rowLabel: 'marked point',
  });
  const marksHint = el('p', { className: 'olv-modal-hint', text: `Distance along the line in ${unitOf[p.unitSystem]}, as a number or a station. Numbered on the section and listed on the method sheet.` });

  // ── output ─────────────────────────────────────────────────────────────
  const classicHint = el('p', { className: 'olv-modal-hint', text: 'Classic is in English on A3, and prints the title, project, status, drawing number, revision and issues.' });
  const lang = exportLanguageControl('the profile sheets');
  const paperField = field('Paper', paper);
  const syncStyle = (): void => {
    const classic = sheetStyle() === 'classic';
    classicHint.hidden = !classic;
    for (const c of lang.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) c.disabled = classic;
    paper.disabled = classic;
  };
  const off = onSheetStyleChange(syncStyle);
  syncStyle();

  const body = el('div', { className: 'olv-modal-form' }, [
    section('Sheet', true, [
      field('Title', title), field('Subtitle', subtitle), field('Project', project, 'Left empty, the sheet names the scan.'),
      field('Client', client), field('Location', location),
    ]),
    section('Company and people', !isEmptyFields(who), [
      field('Company', company), logoField, field('Prepared by', prepared), field('Checked by', checked), field('Approved by', approved), rememberLabel,
    ]),
    section('Drawing', !!(f.drawingNo || f.revision || f.issues || job.date || job.status), [
      field('Drawing number', drawing), field('Revision', revision), field('Date', date),
      field('Status', status, 'The suitability note is printed whatever the status.'),
      el('div', { className: 'olv-modal-label', text: 'Issues' }), issues.element,
    ]),
    section('Line and notes', !!(f.endA || f.endB || f.marks || f.notes), [
      field('Name of end A', endA), field('Name of end B', endB),
      el('div', { className: 'olv-modal-label', text: 'Marked points' }), marks.element, marksHint,
      field('Notes', notes, 'Printed as typed, under their own heading.'),
    ]),
    section('Output', true, [sheetStyleControl(), classicHint, lang, field('Units', units), paperField, field('File name', fileName, 'A single .pdf is added on download.')]),
  ]);

  const err = el('p', { className: 'olv-modal-error' });
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const chars = el('p', { className: 'olv-modal-hint', text: 'Some characters may print as “?”: the sheet fonts cover Latin scripts.' });
  chars.hidden = true;
  const textBoxes = (): string => [...body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type="text"], textarea')].map((i) => i.value).join('');
  body.addEventListener('input', () => { chars.hidden = !unusualCharacters(textBoxes()); });
  chars.hidden = !unusualCharacters(textBoxes());
  const cancel = el('button', { className: 'olv-modal-btn olv-modal-cancel', text: 'Cancel' }) as HTMLButtonElement;
  const go = el('button', { className: 'olv-modal-btn olv-modal-cta', text: 'Export PDF' }) as HTMLButtonElement;
  cancel.type = go.type = 'button';
  const footer = el('div', { className: 'olv-modal-actions' }, [err, chars, cancel, go]);

  return new Promise<boolean>((resolve) => {
    let made = false, busy = false;
    const fail = (m: string): void => { err.textContent = m; err.hidden = false; };
    const handle = openModal({
      title: 'Export profile (PDF)', body, footer, returnFocusTo: p.returnFocusTo ?? null,
      onClose: () => { off(); resolve(made); },
    });
    handle.element.classList.add('olv-pe');
    cancel.addEventListener('click', () => handle.close());

    /** The marked points as typed, or the reason one cannot be used. */
    const readMarks = (): MarkedPoint[] | string => {
      const out: MarkedPoint[] = [];
      for (const [c, t] of marks.rows()) {
        if (c!.trim() === '' && t!.trim() === '') continue;
        const m = parseChainage(c!, p.unitSystem);
        if (m === null) return `“${c}” is not a chainage. Use a number, such as 34.5, or a station.`;
        if (t!.trim() === '') return `The marked point at ${c} has no text.`;
        if (m > p.lengthM + 1e-6) return `The marked point at ${c} is past the end of the line (${toShown(p.lengthM)} ${unitOf[p.unitSystem]}).`;
        out.push({ chainage: Math.min(m, p.lengthM), text: t! });
      }
      return out;
    };

    go.addEventListener('click', () => {
      if (busy) return;
      err.hidden = true;
      const mk = readMarks();
      if (typeof mk === 'string') { fail(mk); return; }
      const fields = cleanProfileFields({
        title: title.value, subtitle: subtitle.value, drawingNo: drawing.value, revision: revision.value, endA: endA.value, endB: endB.value, notes: notes.value,
        issues: issues.rows().map(([issue, description, d, by, chk]) => ({ issue, description, date: d, by, checked: chk })), marks: mk,
      });
      const j = cleanJob({ project: project.value, client: client.value, location: location.value, date: date.value, status: status.value as DeliverableStatus });
      const c = cleanCompany({ company: company.value, logoDataUrl: logo, preparedBy: prepared.value, checkedBy: checked.value, approvedBy: approved.value });
      busy = true;
      go.disabled = cancel.disabled = true;
      go.textContent = 'Exporting…';
      void run({ deliverable: { ...c, ...j, ...fields }, fields, fileName: fileName.value, paper: paper.value as ProfilePaper, unitSystem: shownUnit() }).then(() => {
        // Kept only once a sheet was made with them.
        setJobDetails(j);
        setCompanyDetails(c);
        const wanted = remember.checked && !isEmptyFields(c);
        const held = rememberCompany(wanted ? c : null);
        made = true;
        if (wanted && !held) {
          // The file is made; say what was not kept before closing.
          fail('The PDF was saved. This browser did not keep the company details for next time.');
          busy = false;
          go.hidden = true;
          cancel.disabled = false;
          cancel.textContent = 'Close';
          return;
        }
        handle.close();
      }, (e: unknown) => {
        // eslint-disable-next-line no-console
        console.error('OpenLiDARViewer: profile PDF export failed.', e);
        fail('The PDF could not be made, so nothing was saved. Reload the page and try again.');
        busy = false;
        go.disabled = cancel.disabled = false;
        go.textContent = 'Export PDF';
      });
    });
  });
}
