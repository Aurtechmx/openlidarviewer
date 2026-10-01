/**
 * sessionLogRecorder.ts
 *
 * Feeds the Session log from signals the app already emits. It adds no hook to
 * any owner: it subscribes to the scan service's active-layer signal, the CRS
 * service, the Results index, and it watches the DOM the app already writes
 * for users and screen readers (the live regions, the class filter banner, the
 * annotation list) plus the download anchors every export goes through.
 * Palette and dock actions are recorded where the action registry is built.
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
  activeName(): string | null;
}

export interface SessionLogRecorderDeps {
  readonly log: SessionLog;
  readonly doc?: Document;
  readonly scans?: SessionLogScans;
  readonly crs?: { current(): ResolvedCrs | null; subscribe(fn: () => void): () => void };
  readonly results?: { entries(): readonly ResultEntry[]; subscribe(fn: () => void): () => void } | null;
  /** The class legend panel; its filter banner states what is shown. */
  readonly classLegend?: HTMLElement;
  /** The annotation panel; its rows carry `data-id`. */
  readonly annotation?: HTMLElement;
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
 * Progress lines repeat many times a second and say nothing once done, and
 * the location bar's "Location: …" lines narrate navigation, not work.
 */
const PROGRESS = /\d+\s?%|…$|\.\.\.$|^Location: /;

export function crsText(c: ResolvedCrs | null): string {
  if (!c) return 'No coordinate reference system';
  const code = c.epsg != null ? `EPSG:${c.epsg}` : null;
  const name = code && !c.name.includes(code) ? `${c.name} (${code})` : c.name;
  const src = c.source === 'catalog-tile' && c.assertedBy ? `asserted by ${c.assertedBy}` : CRS_SOURCE[c.source] ?? c.source;
  return `${name}, ${src}${c.userConfirmed && c.source !== 'user-override' ? ', confirmed' : ''}`;
}

export function installSessionLogRecorder(d: SessionLogRecorderDeps): () => void {
  const { log } = d;
  const doc = d.doc ?? document;
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
  const known = new Map<string, string>();
  let streaming: string | null = null;
  const checkScans = (): void => {
    const s = d.scans;
    if (!s) return;
    const ids = s.clouds();
    for (const id of ids) {
      if (known.has(id)) continue;
      const c = s.getCloud(id);
      if (!c) continue;
      const name = baseName(c.name) || c.name;
      known.set(id, name);
      log.append({ kind: 'scan', text: `Opened ${name}`, scan: name, detail: c.sourceFormat ? `source: ${c.sourceFormat}` : undefined });
    }
    for (const [id, name] of Array.from(known)) {
      if (ids.includes(id)) continue;
      known.delete(id);
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
  }

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
    const verb = (e: ResultEntry): string => (e.type === 'measurement' ? 'Measurement' : RESULT_TYPE_LABELS[e.type]);
    offs.push(results.subscribe(() => {
      checkScans();
      const now = results.entries();
      const ids = new Set(now.map((e) => e.id));
      for (const e of [...now].reverse()) {
        const before = seen.get(e.id);
        seen.set(e.id, e);
        const kind = e.type === 'measurement' ? 'measurement' : 'analysis';
        const method = e.type === 'measurement' ? undefined : `method: ${e.type}`;
        if (!before) {
          add({ kind, text: e.type === 'measurement' ? `Measurement created: ${e.title}` : `${verb(e)} result: ${e.title}`, detail: method, status: e.status === 'stale' ? 'info' : 'done' });
        } else if (before.status !== e.status && e.status === 'stale') {
          add({ kind, text: `${verb(e)} out of date: ${e.title}`, detail: method, status: 'info' });
        }
      }
      for (const [id, e] of Array.from(seen)) {
        if (ids.has(id)) continue;
        seen.delete(id);
        add({ kind: e.type === 'measurement' ? 'measurement' : 'analysis', text: `${verb(e)} deleted: ${e.title}`, status: 'removed' });
      }
    }));
  }

  // ── messages, errors, exports, filters and annotations from the DOM ────
  let lastMessage = '';
  const message = (node: Element, text: string): void => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || t === lastMessage || PROGRESS.test(t)) return;
    lastMessage = t;
    const alert = node.getAttribute('role') === 'alert';
    add({ kind: alert ? 'error' : 'message', text: t, status: alert ? 'failed' : 'info' });
  };
  const regionOf = (n: Node | null): Element | null => {
    const e = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
    return e?.closest?.('.olv-visually-hidden[role="status"], [role="alert"], .olv-lasso-toast') ?? null;
  };

  let bannerText: string | null = null;
  const checkBanner = (): void => {
    const b = d.classLegend?.querySelector<HTMLElement>('.olv-cl-banner');
    if (!b) return;
    const shown = !b.classList.contains('olv-hidden') && (b.textContent ?? '').trim() !== '';
    const t = shown ? (b.textContent ?? '').trim() : '';
    if (bannerText === null) { bannerText = t; return; }
    if (t === bannerText) return;
    bannerText = t;
    add({ kind: 'filter', text: t ? `Class filter: ${t}` : 'Class filter cleared: every class shown' });
  };

  const notes = new Map<string, string>();
  let notesPrimed = false;
  const checkAnnotations = (): void => {
    const root = d.annotation;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.olv-ap-row[data-id]'));
    const ids = new Set<string>();
    for (const r of rows) {
      const id = r.dataset.id as string;
      ids.add(id);
      if (notes.has(id)) continue;
      const name = r.querySelector('.olv-ap-name')?.textContent?.trim() || 'Annotation';
      notes.set(id, name);
      if (notesPrimed) add({ kind: 'annotation', text: `Annotation created: ${name}` });
    }
    // A collapsed or filtered list drops rows without deleting anything, so a
    // removal counts only while the list is not being searched.
    const search = root.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search || search.value === '') {
      for (const [id, name] of Array.from(notes)) {
        if (ids.has(id)) continue;
        notes.delete(id);
        if (notesPrimed) add({ kind: 'annotation', text: `Annotation deleted: ${name}`, status: 'removed' });
      }
    }
    notesPrimed = true;
  };

  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver((records) => {
      const touched = new Set<Element>();
      for (const r of records) {
        const region = regionOf(r.target);
        if (region) touched.add(region);
      }
      for (const region of touched) {
        const msg = region.matches('.olv-lasso-toast') ? region.querySelector('.olv-lasso-toast-msg') : region;
        if (msg) message(region, msg.textContent ?? '');
      }
    });
    mo.observe(doc.body, { subtree: true, childList: true, characterData: true });
    offs.push(() => mo.disconnect());
    if (d.classLegend) {
      checkBanner();
      const mb = new MutationObserver(checkBanner);
      mb.observe(d.classLegend, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
      offs.push(() => mb.disconnect());
    }
    if (d.annotation) {
      checkAnnotations();
      const ma = new MutationObserver(checkAnnotations);
      ma.observe(d.annotation, { subtree: true, childList: true });
      offs.push(() => ma.disconnect());
    }
  }

  // Registry runs (palette, dock, sheet) arrive as an event from their chunk.
  const KINDS = new Set(['command', 'message', 'error', 'export', 'analysis', 'filter']);
  const onEntry = (e: Event): void => {
    const x = (e as CustomEvent<Partial<SessionLogInput>>).detail;
    if (!x || typeof x.text !== 'string' || !KINDS.has(x.kind as string)) return;
    add({ kind: x.kind as SessionLogInput['kind'], text: x.text, ...(typeof x.detail === 'string' ? { detail: x.detail } : {}) });
  };
  doc.addEventListener(SESSION_LOG_EVENT, onEntry);
  offs.push(() => doc.removeEventListener(SESSION_LOG_EVENT, onEntry));

  // Every export ends in a download anchor appended to the body and clicked.
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

  return () => {
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* already gone */ }
    }
  };
}
