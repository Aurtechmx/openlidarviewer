/**
 * sessionLogRecorder.test.ts
 *
 * The recorder's sources with a stub DOM: annotations come from the store,
 * not from the panel's rows; result lines name the scan they were computed on;
 * a layer closed while another is active is logged when it closes; file names
 * keep `#` and `?`; only the announcement regions are observed; a class
 * filter is one line per change the user made; and an error whose link ends
 * in `?…` is kept.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionLog, SESSION_LOG_EVENT } from '../src/app/sessionLog/sessionLog';
import { installSessionLogRecorder, type SessionLogRecorderDeps, type SessionLogScans } from '../src/app/sessionLog/sessionLogRecorder';
import type { ResultEntry } from '../src/app/results/resultsIndex';
import { installSessionLogDom, SMutationObserver, SNode, uninstallSessionLogDom, type SDoc } from './helpers/sessionLogDom';

let doc: SDoc;
beforeEach(() => { doc = installSessionLogDom(); });
afterEach(() => uninstallSessionLogDom());

function emitter(): { fire(): void; on(fn: () => void): () => void } {
  const subs = new Set<() => void>();
  return { fire: () => { for (const fn of subs) fn(); }, on: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
}

function entry(over: Partial<ResultEntry> & Pick<ResultEntry, 'id' | 'type' | 'title'>): ResultEntry {
  return { createdAt: 0, sourceIdentity: null, status: 'ready', route: { mode: 'work', page: 'measure' }, anchor: null, fit: null, ...over };
}

type Rec = ReturnType<typeof installSessionLogRecorder>;

function scansFixture() {
  let clouds: Array<{ id: string; name: string }> = [];
  let active: string | null = null;
  const activeSig = emitter();
  const layerSig = emitter();
  const scans: SessionLogScans = {
    clouds: () => clouds.map((c) => c.id),
    getCloud: (id) => clouds.find((c) => c.id === id),
    streamingCloud: null,
    onActiveChange: activeSig.on,
    onLayersChange: layerSig.on,
    activeName: () => clouds.find((c) => c.id === active)?.name ?? null,
  };
  return {
    scans,
    add(id: string, name: string) { clouds = [...clouds, { id, name }]; layerSig.fire(); },
    remove(id: string) { clouds = clouds.filter((c) => c.id !== id); layerSig.fire(); },
    activate(id: string | null) { active = id; activeSig.fire(); },
  };
}

function texts(log: ReturnType<typeof createSessionLog>, kind?: string): string[] {
  return log.entries().filter((e) => !kind || e.kind === kind).map((e) => `${e.text}|${e.scan ?? ''}`);
}

describe('C1: annotations come from the store', () => {
  it('logs a create and a delete from the store and nothing for rows the panel filters out', () => {
    const log = createSessionLog();
    const panel = new SNode('aside');
    doc.body.append(panel);
    const rows = [new SNode('div'), new SNode('div')];
    rows.forEach((r, i) => { r.className = 'olv-ap-row'; r.dataset.id = `a${i}`; r.setAttribute('data-id', `a${i}`); panel.append(r); });
    let notes = [{ id: 'a0', title: 'First note' }, { id: 'a1', title: 'Second note' }];
    const deps = { log, doc, annotation: panel, annotations: () => notes } as unknown as SessionLogRecorderDeps;
    const rec: Rec = installSessionLogRecorder(deps);

    // The search box filters the list: a row leaves the DOM, the store keeps it.
    rows[1]!.remove();
    SMutationObserver.touch(panel);
    rec.sync();
    panel.append(rows[1]!);
    SMutationObserver.touch(panel);
    rec.sync();
    expect(texts(log, 'annotation')).toEqual([]);

    notes = [...notes, { id: 'a2', title: 'Third note' }];
    rec.sync();
    notes = notes.filter((n) => n.id !== 'a0');
    rec.sync();
    expect(texts(log, 'annotation')).toEqual(['Annotation created: Third note|', 'Annotation deleted: First note|']);
    rec.dispose();
  });
});

describe('C2: each line names the scan it applied to', () => {
  it('names a result by its source scan and logs a non-active layer when it closes', () => {
    const log = createSessionLog();
    const s = scansFixture();
    const resSig = emitter();
    let results: ResultEntry[] = [];
    const rec = installSessionLogRecorder({ log, doc: doc as unknown as Document, scans: s.scans, results: { entries: () => results, subscribe: resSig.on } });
    s.add('c1', 'alpha.laz');
    s.activate('c1');
    s.add('c2', 'bravo.laz');
    s.activate('c2');
    results = [entry({ id: 'terrain:c1', type: 'terrain', title: 'Terrain surface, alpha.laz', sourceIdentity: 'c1', route: { mode: 'analyse', page: 'terrain' } })];
    resSig.fire();
    results = [entry({ id: 'measurement:m1', type: 'measurement', title: 'Profile 1', sourceIdentity: 'c1' }), ...results];
    resSig.fire();
    s.remove('c1');
    results = [entry({ id: 'terrain:c1', type: 'terrain', title: 'Terrain surface, alpha.laz', sourceIdentity: 'c1', status: 'stale' })];
    resSig.fire();

    expect(texts(log)).toEqual([
      'Opened alpha.laz|alpha.laz',
      'Opened bravo.laz|bravo.laz',
      'Terrain result: Terrain surface, alpha.laz|alpha.laz',
      'Measurement created: Profile 1|alpha.laz',
      'Closed alpha.laz|alpha.laz',
      'Terrain out of date: Terrain surface, alpha.laz|alpha.laz',
      'Measurement deleted: Profile 1|alpha.laz',
    ]);
    rec.dispose();
  });

  it('finds a scan by the stable id an owner recorded', () => {
    const log = createSessionLog();
    const s = scansFixture();
    const resSig = emitter();
    let results: ResultEntry[] = [];
    const rec = installSessionLogRecorder({
      log, doc: doc as unknown as Document,
      scans: { ...s.scans, stableIdFor: (id: string) => `stable-${id}` },
      results: { entries: () => results, subscribe: resSig.on },
    });
    s.add('c1', 'alpha.laz');
    s.add('c2', 'bravo.laz');
    s.activate('c2');
    results = [entry({ id: 'measurement:m1', type: 'measurement', title: 'Distance 1', sourceIdentity: 'stable-c1' })];
    resSig.fire();
    expect(texts(log, 'measurement')).toEqual(['Measurement created: Distance 1|alpha.laz']);
    rec.dispose();
  });
});

describe('C3: file names keep # and ?', () => {
  it('logs the whole name of a scan and of an exported file', () => {
    const log = createSessionLog();
    const s = scansFixture();
    const rec = installSessionLogRecorder({ log, doc: doc as unknown as Document, scans: s.scans });
    s.add('c1', 'Block #3.laz');
    const a = new SNode('a');
    a.setAttribute('download', 'site-a#b-profile.csv');
    doc.fire('click', { target: a });
    expect(log.entries().map((e) => `${e.text}|${e.detail ?? ''}`)).toEqual([
      'Opened Block #3.laz|',
      'Exported site-a#b-profile.csv|type: CSV',
    ]);
    rec.dispose();
  });
});

describe('announcement regions', () => {
  function regions(): { status: SNode; alert: SNode } {
    const status = new SNode('span');
    status.className = 'olv-visually-hidden';
    status.setAttribute('role', 'status');
    const alert = new SNode('span');
    alert.className = 'olv-visually-hidden';
    alert.setAttribute('role', 'alert');
    doc.body.append(status, alert);
    return { status, alert };
  }

  it('observes the regions, never the whole document subtree', () => {
    regions();
    const rec = installSessionLogRecorder({ log: createSessionLog(), doc: doc as unknown as Document });
    const bodyWatchers = SMutationObserver.live.flatMap((o) => o.targets).filter((t) => t.target === doc.body);
    expect(bodyWatchers.every((t) => !t.opts.subtree)).toBe(true);
    rec.dispose();
    expect(SMutationObserver.live).toHaveLength(0);
  });

  it('logs announcements and errors, keeps an error whose link ends in ?…, and skips progress and location lines', () => {
    const { status, alert } = regions();
    const log = createSessionLog();
    let t = 0;
    const rec = installSessionLogRecorder({ log, doc: doc as unknown as Document, now: () => (t += 5000) } as SessionLogRecorderDeps);
    const say = (n: SNode, text: string): void => { n.textContent = text; SMutationObserver.touch(n); };
    say(status, 'Decoding points… 45%');
    say(status, 'Loading tiles…');
    say(status, 'Location: Data, Session log');
    say(status, 'Project ready: site.laz, 3.6K points.');
    say(alert, '3D Tiles tileset fetch failed for https://host.example/tiles/tileset.json?…');
    const toast = new SNode('div');
    toast.className = 'olv-lasso-toast';
    const msg = new SNode('span');
    msg.className = 'olv-lasso-toast-msg';
    toast.append(msg);
    doc.body.append(toast);
    SMutationObserver.touch(doc.body);
    say(msg, 'Back to navigation.');
    expect(log.entries().map((e) => `${e.kind}|${e.text}`)).toEqual([
      'message|Project ready: site.laz, 3.6K points.',
      'error|3D Tiles tileset fetch failed for https://host.example/…/tileset.json',
      'message|Back to navigation.',
    ]);
    rec.dispose();
  });
});

describe('progress steps', () => {
  it('skips steps that name a file or detect and optimize, and keeps the errors among them', () => {
    const alert = new SNode('span');
    alert.className = 'olv-visually-hidden';
    alert.setAttribute('role', 'alert');
    const status = new SNode('span');
    status.className = 'olv-visually-hidden';
    status.setAttribute('role', 'status');
    doc.body.append(status, alert);
    const log = createSessionLog();
    let t = 0;
    const rec = installSessionLogRecorder({ log, doc: doc as unknown as Document, now: () => (t += 5000) } as SessionLogRecorderDeps);
    const say = (n: SNode, text: string): void => { n.textContent = text; SMutationObserver.touch(n); };
    say(status, 'Opening alpha.ply…');
    say(status, 'Reading site.v2.copc.laz...');
    say(status, 'Detecting ground…');
    say(status, 'Optimizing point budget…');
    say(alert, 'Opening alpha.ply failed: bad header. Retrying…');
    say(alert, 'Detecting ground could not finish…');
    say(status, 'Loading stopped. Try again…');
    say(status, 'Reading tile! Wait…');
    expect(log.entries().map((e) => `${e.kind}|${e.text}`)).toEqual([
      'error|Opening alpha.ply failed: bad header. Retrying…',
      'error|Detecting ground could not finish…',
      'message|Loading stopped. Try again…',
      'message|Reading tile! Wait…',
    ]);
    rec.dispose();
  });
});

describe('scan names', () => {
  it('keeps a scan name with a slash whole, and a path to its file name', () => {
    const log = createSessionLog();
    const s = scansFixture();
    const rec = installSessionLogRecorder({ log, doc: doc as unknown as Document, scans: s.scans });
    s.add('c1', 'Area 1/2 (EPT)');
    s.add('c2', '/srv/alex/scans/site.laz');
    s.activate('c1');
    log.append({ kind: 'message', text: 'Hello' });
    expect(texts(log)).toEqual(['Opened Area 1/2 (EPT)|Area 1/2 (EPT)', 'Opened site.laz|site.laz', 'Hello|Area 1/2 (EPT)']);
    rec.dispose();
  });
});

describe('class filter', () => {
  it('writes one line per change of the hidden set and none when streaming finds a class', () => {
    const status = new SNode('span');
    status.className = 'olv-visually-hidden';
    status.setAttribute('role', 'status');
    const legend = new SNode('aside');
    const banner = new SNode('div');
    banner.className = 'olv-cl-banner olv-hidden';
    legend.append(banner);
    doc.body.append(status, legend);
    let hidden: number[] = [];
    let present = [1, 2, 6];
    const log = createSessionLog();
    let t = 0;
    const rec = installSessionLogRecorder({
      log, doc: doc as unknown as Document, now: () => (t += 5000), classLegend: legend as unknown as HTMLElement,
      classFilter: { hidden: () => hidden, present: () => present },
    } as SessionLogRecorderDeps);
    const show = (text: string): void => {
      banner.textContent = text;
      banner.classList.toggle('olv-hidden', text === '');
      SMutationObserver.touch(banner);
      if (text) { status.textContent = text; SMutationObserver.touch(status); }
    };
    hidden = [6];
    show('Filtered — showing 2 of 3 classes');
    present = [1, 2, 5, 6];
    show('Filtered — showing 3 of 4 classes');
    hidden = [];
    show('');
    expect(texts(log)).toEqual([
      'Class filter: 2 of 3 classes shown|',
      'Class filter cleared: every class shown|',
    ]);
    rec.dispose();
  });
});

describe('registry commands', () => {
  it('records a command with its outcome from the registry event', () => {
    const log = createSessionLog();
    const rec = installSessionLogRecorder({ log, doc: doc as unknown as Document });
    doc.dispatchEvent(new CustomEvent(SESSION_LOG_EVENT, { detail: { kind: 'command', text: 'Export LAS', detail: 'Export', status: 'failed' } }));
    expect(log.entries().map((e) => `${e.text}|${e.status}`)).toEqual(['Export LAS|failed']);
    rec.dispose();
  });
});

describe('owners that throw', () => {
  it('logs nothing and keeps running when the annotation store or the class filter throws', () => {
    const log = createSessionLog();
    const legend = new SNode('aside');
    doc.body.append(legend);
    const rec = installSessionLogRecorder({
      log, doc: doc as unknown as Document, classLegend: legend as unknown as HTMLElement,
      annotations: () => { throw new Error('gone'); },
      classFilter: { hidden: () => { throw new Error('gone'); }, present: () => [] },
    });
    rec.sync();
    SMutationObserver.touch(legend);
    expect(log.entries()).toHaveLength(0);
    rec.dispose();
  });
});
