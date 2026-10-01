/**
 * sessionLogRecorder.ts
 *
 * Feeds the Session log from signals the app already emits. It adds no hook to
 * any owner:
 *
 * - scans: the scan service's active-layer signal and the Inspector's layer
 *   list signal, diffed against the viewer's layer ids;
 * - CRS: the CRS service;
 * - analyses and measurements: the Results index, each line named after the
 *   scan its result was computed on;
 * - annotations: the annotation store's summaries, read on every shell sync;
 * - class filter: the set of hidden classes, read when the class legend
 *   re-renders;
 * - messages and errors: the polite and alert live regions and the toast,
 *   observed directly;
 * - exports: the download anchor every export clicks;
 * - commands: an event from the action registry's chunk.
 *
 * Read only, like the log: nothing here changes what it watches.
 */

import type { SessionLog, SessionLogInput } from './sessionLog';
import { baseName, SESSION_LOG_EVENT } from './sessionLog';
import type { ResolvedCrs } from '../../geo/CoordinateTypes';
import type { ResultEntry } from '../results/resultsIndex';
import { RESULT_TYPE_LABELS } from '../results/resultsIndex';

export interface SessionLogScans {
  clouds(): string[];
  getCloud(id: string): { readonly name: string; readonly sourceFormat?: string } | undefined;
  readonly streamingCloud?: { readonly name: string } | null;
  onActiveChange(fn: () => void): () => void;
  /** A layer was added or removed, active or not. */
  onLayersChange?(fn: () => void): () => void;
  activeName(): string | null;
  /** The stable id a viewer layer id is known by, for owners that record stable ids. */
  stableIdFor?(id: string): string | null | undefined;
}

export interface SessionLogRecorderDeps {
  readonly log: SessionLog;
  readonly doc?: Document;
  /** Clock for the repeat window of announcements; injectable for tests. */
  readonly now?: () => number;
  readonly scans?: SessionLogScans;
  readonly crs?: { current(): ResolvedCrs | null; subscribe(fn: () => void): () => void };
  readonly results?: { entries(): readonly ResultEntry[]; subscribe(fn: () => void): () => void } | null;
  /** The annotation store's summaries, read on every {@link SessionLogRecorder.sync}. */
  readonly annotations?: () => readonly { readonly id: string; readonly title: string }[];
  /** The class legend panel: its re-render is when the filter is read. */
  readonly classLegend?: HTMLElement;
  /** The hidden and present ASPRS classes. */
  readonly classFilter?: { hidden(): readonly number[]; present(): readonly number[] };
}

export interface SessionLogRecorder {
  /** Re-read the owners the shell syncs on (annotations, layers). */
  sync(): void;
  dispose(): void;
}

const CRS_SOURCE: Readonly<Record<string, string>> = {
  'las-vlr': 'from the LAS header',
  'las-evlr': 'from the LAS header',
  'copc-meta': 'from the COPC metadata',
  'ept-srs': 'from the EPT metadata',
  'tileset-region': 'from the tileset region',
  'catalog-tile': 'asserted by the catalogue',
  'user-override': 'set by you',
  'default-assumption': 'assumed',
};

/**
 * Lines left out: a percentage, a running step ("Loading tiles…"), and the
 * location bar's "Location: …" narration. An error that ends in "…" is kept.
 */
const SKIP =
  /\d+\s?%|^Location: |^(?:Loading|Opening|Reading|Decoding|Parsing|Preparing|Streaming|Fetching|Downloading|Building|Computing|Sampling|Indexing|Saving|Exporting|Generating|Rendering)\b[^.!?]*(?:…|\.\.\.)$/i;
/** The class legend announces its banner; the filter line already says it. */
const FILTER_BANNER = /^Filtered — showing \d+ of \d+ classes$/;
/** A message repeated within this window is one line. */
const REPEAT_MS = 2000;
const REGION = '.olv-visually-hidden[role="status"], .olv-visually-hidden[role="alert"], .olv-lasso-toast';

export function crsText(c: ResolvedCrs | null): string {
  if (!c) return 'No coordinate reference system';
  const code = c.epsg != null ? `EPSG:${c.epsg}` : null;
  const name = code && !c.name.includes(code) ? `${c.name} (${code})` : c.name;
  const src = c.source === 'catalog-tile' && c.assertedBy ? `asserted by ${c.assertedBy}` : CRS_SOURCE[c.source] ?? c.source;
  return `${name}, ${src}${c.userConfirmed && c.source !== 'user-override' ? ', confirmed' : ''}`;
}

function resultLabel(e: ResultEntry): string {
  if (e.type === 'measurement') return 'Measurement';
  if (e.type === 'finding') return 'Finding';
  return RESULT_TYPE_LABELS[e.type];
}

export function installSessionLogRecorder(d: SessionLogRecorderDeps): SessionLogRecorder {
  const { log } = d;
  const doc = d.doc ?? document;
  const now = d.now ?? (() => Date.now());
  const offs: Array<() => void> = [];
  const add = (input: SessionLogInput): void => {
    log.append(input);
  };
  if (d.scans) {
    const scans = d.scans;
    log.setScanSource(() => scans.activeName());
    offs.push(() => log.setScanSource(null));
  }

  // ── scans ────────────────────────────────────────────────────────────────
  // Names outlive their layers, so a line about a closed scan still names it.
  const names = new Map<string, string>();
  const open = new Set<string>();
  let streaming: string | null = null;
  const checkScans = (): void => {
    const s = d.scans;
    if (!s) return;
    const ids = s.clouds();
    for (const id of ids) {
      if (open.has(id)) continue;
      const c = s.getCloud(id);
      if (!c) continue;
      const name = baseName(c.name) || c.name;
      open.add(id);
      names.set(id, name);
      const stable = s.stableIdFor?.(id);
      if (stable) names.set(stable, name);
      log.append({ kind: 'scan', text: `Opened ${name}`, scan: name, detail: c.sourceFormat ? `source: ${c.sourceFormat}` : undefined });
    }
    for (const id of Array.from(open)) {
      if (ids.includes(id)) continue;
      open.delete(id);
      const name = names.get(id) ?? id;
      log.append({ kind: 'scan', text: `Closed ${name}`, scan: name, status: 'removed' });
    }
    const live = s.streamingCloud?.name ? baseName(s.streamingCloud.name) || s.streamingCloud.name : null;
    if (live !== streaming) {
      if (streaming) log.append({ kind: 'scan', text: `Closed ${streaming}`, scan: streaming, status: 'removed', detail: 'source: streaming' });
      if (live) log.append({ kind: 'scan', text: `Opened ${live}`, scan: live, detail: 'source: streaming' });
      streaming = live;
    }
  };
  if (d.scans) {
    checkScans();
    offs.push(d.scans.onActiveChange(checkScans));
    if (d.scans.onLayersChange) offs.push(d.scans.onLayersChange(checkScans));
  }
  /** The scan a result was computed on, by name; undefined leaves the active scan. */
  const scanOf = (e: ResultEntry): string | undefined => (e.sourceIdentity ? names.get(e.sourceIdentity) : undefined);

  // ── CRS ─────────────────────────────────────────────────────────────────
  if (d.crs) {
    const crs = d.crs;
    const key = (c: ResolvedCrs | null): string => (c ? `${c.kind}|${c.epsg ?? ''}|${c.name}|${c.source}|${c.userConfirmed}` : '');
    let last = key(crs.current());
    offs.push(crs.subscribe(() => {
      const c = crs.current();
      const k = key(c);
      if (k === last) return;
      last = k;
      if (c) add({ kind: 'crs', text: `CRS: ${crsText(c)}` });
    }));
  }

  // ── results: analyses and measurements ─────────────────────────────────
  if (d.results) {
    const results = d.results;
    const seen = new Map<string, ResultEntry>();
    for (const e of results.entries()) seen.set(e.id, e);
    offs.push(results.subscribe(() => {
      checkScans();
      const current = results.entries();
      const ids = new Set(current.map((e) => e.id));
      for (const e of [...current].reverse()) {
        const before = seen.get(e.id);
        seen.set(e.id, e);
        const kind = e.type === 'measurement' ? 'measurement' : 'analysis';
        const method = e.type === 'measurement' ? undefined : `method: ${e.type}`;
        const scan = scanOf(e);
        if (!before) {
          const text = e.type === 'measurement' ? `Measurement created: ${e.title}` : e.type === 'finding' ? `Finding: ${e.title}` : `${resultLabel(e)} result: ${e.title}`;
          add({ kind, text, detail: method, scan, status: e.status === 'stale' ? 'info' : 'done' });
        } else if (before.status !== e.status && e.status === 'stale') {
          add({ kind, text: `${resultLabel(e)} out of date: ${e.title}`, detail: method, scan, status: 'info' });
        }
      }
      for (const [id, e] of Array.from(seen)) {
        if (ids.has(id)) continue;
        seen.delete(id);
        add({ kind: e.type === 'measurement' ? 'measurement' : 'analysis', text: `${resultLabel(e)} deleted: ${e.title}`, scan: scanOf(e), status: 'removed' });
      }
    }));
  }

  // ── annotations, from the store ────────────────────────────────────────
  const notes = new Map<string, string>();
  const readNotes = (): readonly { readonly id: string; readonly title: string }[] | null => {
    try {
      return d.annotations?.() ?? null;
    } catch {
      return null;
    }
  };
  for (const n of readNotes() ?? []) notes.set(n.id, n.title);
  const checkAnnotations = (): void => {
    const list = readNotes();
    if (!list) return;
    const ids = new Set<string>();
    for (const n of list) {
      ids.add(n.id);
      if (notes.has(n.id)) continue;
      notes.set(n.id, n.title);
      add({ kind: 'annotation', text: `Annotation created: ${n.title || 'Annotation'}` });
    }
    for (const [id, title] of Array.from(notes)) {
      if (ids.has(id)) continue;
      notes.delete(id);
      add({ kind: 'annotation', text: `Annotation deleted: ${title || 'Annotation'}`, status: 'removed' });
    }
  };

  // ── class filter: the hidden set, which only the user changes ──────────
  const hiddenKey = (): string | null => {
    try {
      return d.classFilter ? [...d.classFilter.hidden()].sort((a, b) => a - b).join(',') : null;
    } catch {
      return null;
    }
  };
  let lastHidden = hiddenKey();
  const checkFilter = (): void => {
    const k = hiddenKey();
    if (k === null || k === lastHidden || !d.classFilter) return;
    lastHidden = k;
    if (k === '') {
      add({ kind: 'filter', text: 'Class filter cleared: every class shown' });
      return;
    }
    const hidden = new Set(d.classFilter.hidden());
    const present = d.classFilter.present();
    const shown = present.filter((c) => !hidden.has(c)).length;
    add({ kind: 'filter', text: `Class filter: ${shown} of ${present.length} classes shown`, detail: `hidden classes: ${[...hidden].sort((a, b) => a - b).join(', ')}` });
  };

  // ── messages and errors, from the regions that announce them ───────────
  let lastMessage = '';
  let lastAt = -Infinity;
  const message = (region: Element): void => {
    const node = region.matches('.olv-lasso-toast') ? region.querySelector('.olv-lasso-toast-msg') : region;
    const t = (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!t || SKIP.test(t) || FILTER_BANNER.test(t)) return;
    const at = now();
    if (t === lastMessage && at - lastAt < REPEAT_MS) return;
    lastMessage = t;
    lastAt = at;
    const alert = region.getAttribute('role') === 'alert';
    add({ kind: alert ? 'error' : 'message', text: t, status: alert ? 'failed' : 'info' });
  };

  if (typeof MutationObserver === 'function') {
    // One observer per region. The body itself is watched only for its own
    // children, which is where the toast appears the first time it shows.
    const watched = new Map<Element, MutationObserver>();
    const attach = (): void => {
      for (const child of Array.from(doc.body.children)) {
        if (watched.has(child) || !child.matches(REGION)) continue;
        const mo = new MutationObserver(() => message(child));
        mo.observe(child, { subtree: true, childList: true, characterData: true });
        watched.set(child, mo);
        message(child); // a region that already holds a line when the recorder starts
      }
      for (const [el, mo] of Array.from(watched)) {
        if (el.parentElement === doc.body) continue;
        mo.disconnect();
        watched.delete(el);
      }
    };
    attach();
    const mb = new MutationObserver(attach);
    mb.observe(doc.body, { childList: true });
    offs.push(() => {
      mb.disconnect();
      for (const mo of watched.values()) mo.disconnect();
      watched.clear();
    });
    if (d.classLegend && d.classFilter) {
      const mc = new MutationObserver(checkFilter);
      mc.observe(d.classLegend, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
      offs.push(() => mc.disconnect());
    }
  }

  // ── commands, from the action registry's chunk ─────────────────────────
  const KINDS = new Set(['command', 'message', 'error', 'export', 'analysis', 'filter']);
  const STATUS = new Set(['done', 'failed', 'refused', 'info']);
  const onEntry = (e: Event): void => {
    const x = (e as CustomEvent<Partial<SessionLogInput>>).detail;
    if (!x || typeof x.text !== 'string' || !KINDS.has(x.kind as string)) return;
    add({
      kind: x.kind as SessionLogInput['kind'],
      text: x.text,
      ...(typeof x.detail === 'string' ? { detail: x.detail } : {}),
      ...(STATUS.has(x.status as string) ? { status: x.status } : {}),
    });
  };
  doc.addEventListener(SESSION_LOG_EVENT, onEntry);
  offs.push(() => doc.removeEventListener(SESSION_LOG_EVENT, onEntry));

  // ── exports: every export ends in a download anchor that is clicked ────
  const onClick = (e: Event): void => {
    const a = (e.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null;
    if (!a) return;
    const file = baseName(a.getAttribute('download') || '') || 'file';
    const dot = file.lastIndexOf('.');
    const type = dot > 0 ? file.slice(dot + 1).toUpperCase() : 'file';
    add({ kind: 'export', text: `Exported ${file}`, detail: `type: ${type}` });
  };
  doc.addEventListener('click', onClick, true);
  offs.push(() => doc.removeEventListener('click', onClick, true));

  return {
    sync() {
      checkScans();
      checkAnnotations();
    },
    dispose() {
      for (const off of offs.splice(0)) {
        try { off(); } catch { /* already gone */ }
      }
    },
  };
}
