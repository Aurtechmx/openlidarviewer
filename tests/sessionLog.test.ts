/**
 * sessionLog.test.ts
 *
 * The Session log store, its recorder and its palette entry. Entries arrive
 * from each source in order, the store keeps the newest 2,000 and says how
 * many it dropped, file locations shrink to base names, and typing "actions"
 * or "/actions" in the palette finds the entry.
 */

import { describe, it, expect, vi } from 'vitest';
import { baseName, createSessionLog, redactPaths, SESSION_LOG_CAP, SESSION_LOG_EVENT } from '../src/app/sessionLog/sessionLog';
import { droppedNote, sessionLogCsv, sessionLogJson, sessionLogText } from '../src/app/sessionLog/sessionLogFormat';
import { crsText, installSessionLogRecorder, type SessionLogScans } from '../src/app/sessionLog/sessionLogRecorder';
import type { ResultEntry } from '../src/app/results/resultsIndex';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { contributeHelpActions } from '../src/app/actions/helpActions';
import { rankActions } from '../src/ui/actionRegistry';

function clock(start = Date.UTC(2026, 8, 30, 12, 0, 0)): () => number {
  let t = start;
  return () => (t += 1000);
}

function emitter(): { fire(): void; on(fn: () => void): () => void } {
  const subs = new Set<() => void>();
  return {
    fire: () => { for (const fn of subs) fn(); },
    on: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}

function crs(over: Partial<ResolvedCrs> = {}): ResolvedCrs {
  return {
    kind: 'projected', name: 'CH1903+ / LV95', epsg: 2056, linearUnit: 'metre', linearUnitToMetres: 1,
    source: 'las-vlr', confidence: 'high', userConfirmed: false, ...over,
  } as ResolvedCrs;
}

function entry(over: Partial<ResultEntry> & Pick<ResultEntry, 'id' | 'type' | 'title'>): ResultEntry {
  return { createdAt: 0, sourceIdentity: null, status: 'ready', route: { mode: 'work', page: 'measure' }, anchor: null, fit: null, ...over };
}

describe('session log store', () => {
  it('keeps entries in the order they were appended, with time and scan', () => {
    const log = createSessionLog({ now: clock() });
    log.append({ kind: 'scan', text: 'Opened a.laz', scan: 'a.laz' });
    log.append({ kind: 'measurement', text: 'Measurement created: Distance 1', scan: 'a.laz' });
    log.append({ kind: 'export', text: 'Exported a.csv', detail: 'type: CSV', scan: null });
    const e = log.entries();
    expect(e.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(e.map((x) => x.kind)).toEqual(['scan', 'measurement', 'export']);
    expect(e[1]!.time).toBeGreaterThan(e[0]!.time);
    expect(e[0]!.scan).toBe('a.laz');
    expect(e[2]!.scan).toBeNull();
  });

  it('reads the active scan from its source when an entry names none', () => {
    const log = createSessionLog();
    log.setScanSource(() => '/srv/survey/scans/site.laz');
    expect(log.append({ kind: 'command', text: 'Frame all' })?.scan).toBe('site.laz');
    expect(log.append({ kind: 'command', text: 'Frame all', scan: null })?.scan).toBeNull();
  });

  it('keeps the newest 2,000 entries and counts the dropped ones', () => {
    expect(SESSION_LOG_CAP).toBe(2000);
    const log = createSessionLog();
    for (let i = 1; i <= 2005; i++) log.append({ kind: 'command', text: `Action ${i}` });
    expect(log.entries()).toHaveLength(2000);
    expect(log.dropped()).toBe(5);
    expect(log.entries()[0]!.text).toBe('Action 6');
    expect(log.entries()[0]!.seq).toBe(6);
    expect(sessionLogText(log).split('\n')[0]).toBe(`(${droppedNote(5)})`);
    expect(sessionLogCsv(log).split('\r\n')[1]).toContain('5 older entries dropped');
    expect(JSON.parse(sessionLogJson(log, '0.7.0')).droppedOlderEntries).toBe(5);
  });

  it('notifies subscribers and ignores empty text', () => {
    const log = createSessionLog();
    const fn = vi.fn();
    const off = log.subscribe(fn);
    expect(log.append({ kind: 'message', text: '   ' })).toBeNull();
    log.append({ kind: 'message', text: 'Done.' });
    off();
    log.append({ kind: 'message', text: 'Again.' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('names files by their base name, never by a folder or a link', () => {
    expect(baseName('C:\\data\\north.laz')).toBe('north.laz');
    expect(baseName('https://example.org/tiles/site%201.copc.laz?sig=abc')).toBe('site 1.copc.laz');
    expect(redactPaths('Could not read /srv/a/scans/x.laz: bad header')).toBe('Could not read x.laz: bad header');
    expect(redactPaths('Opened https://bucket.example.org/a/b/c.copc.laz')).toBe('Opened c.copc.laz');
    expect(redactPaths('Saved to C:\\data\\a\\out.csv')).toBe('Saved to out.csv');
    expect(redactPaths('Grade 1/20 and 3/4')).toBe('Grade 1/20 and 3/4');
    const log = createSessionLog();
    log.append({ kind: 'error', text: 'Load failed for file:///srv/a/private/scan.e57', scan: '/srv/a/private/scan.e57' });
    const out = sessionLogText(log) + sessionLogCsv(log) + sessionLogJson(log, 'x');
    expect(out).not.toContain('/srv/a');
    expect(out).toContain('scan.e57');
  });

  it('neutralises formula characters in CSV cells', () => {
    const log = createSessionLog();
    log.append({ kind: 'annotation', text: '=HYPERLINK("x")' });
    expect(sessionLogCsv(log)).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('session log recorder', () => {
  function setup() {
    const log = createSessionLog({ now: clock() });
    const doc = new EventTarget() as unknown as Document;
    const active = emitter();
    const crsSig = emitter();
    const resSig = emitter();
    let clouds: Array<{ id: string; name: string; sourceFormat?: string }> = [];
    let current: ResolvedCrs | null = null;
    let results: ResultEntry[] = [];
    const scans: SessionLogScans = {
      clouds: () => clouds.map((c) => c.id),
      getCloud: (id) => clouds.find((c) => c.id === id),
      streamingCloud: null,
      onActiveChange: active.on,
      activeName: () => clouds[clouds.length - 1]?.name ?? null,
    };
    const dispose = installSessionLogRecorder({
      log,
      doc,
      scans,
      crs: { current: () => current, subscribe: crsSig.on },
      results: { entries: () => results, subscribe: resSig.on },
    });
    return {
      log, doc, dispose,
      open(id: string, name: string, sourceFormat?: string) { clouds = [...clouds, { id, name, sourceFormat }]; active.fire(); },
      close(id: string) { clouds = clouds.filter((c) => c.id !== id); active.fire(); },
      setCrs(c: ResolvedCrs | null) { current = c; crsSig.fire(); },
      setResults(r: ResultEntry[]) { results = r; resSig.fire(); },
    };
  }

  it('appends one entry per source, in the order things happened', () => {
    const s = setup();
    s.open('c1', '/data/site.laz', 'laz');
    s.setCrs(crs());
    s.setResults([entry({ id: 'measurement:m1', type: 'measurement', title: 'Profile 1' })]);
    s.setResults([
      entry({ id: 'terrain:c1', type: 'terrain', title: 'Terrain surface, site.laz', route: { mode: 'analyse', page: 'terrain' } }),
      entry({ id: 'measurement:m1', type: 'measurement', title: 'Profile 1' }),
    ]);
    s.doc.dispatchEvent(new CustomEvent(SESSION_LOG_EVENT, { detail: { kind: 'command', text: 'Frame all', detail: 'Camera' } }));
    s.setResults([entry({ id: 'terrain:c1', type: 'terrain', title: 'Terrain surface, site.laz', status: 'stale' })]);
    s.close('c1');

    const lines = s.log.entries().map((e) => `${e.kind}|${e.text}|${e.scan ?? ''}|${e.detail ?? ''}|${e.status}`);
    expect(lines).toEqual([
      'scan|Opened site.laz|site.laz|source: laz|done',
      'crs|CRS: CH1903+ / LV95 (EPSG:2056), from the LAS header|site.laz||done',
      'measurement|Measurement created: Profile 1|site.laz||done',
      'analysis|Terrain result: Terrain surface, site.laz|site.laz|method: terrain|done',
      'command|Frame all|site.laz|Camera|done',
      'analysis|Terrain out of date: Terrain surface, site.laz|site.laz|method: terrain|info',
      'measurement|Measurement deleted: Profile 1|site.laz||removed',
      'scan|Closed site.laz|site.laz||removed',
    ]);
  });

  it('records a CRS only when it changes', () => {
    const s = setup();
    s.setCrs(crs());
    s.setCrs(crs());
    s.setCrs(crs({ source: 'user-override', userConfirmed: true }));
    expect(s.log.entries().map((e) => e.text)).toEqual([
      'CRS: CH1903+ / LV95 (EPSG:2056), from the LAS header',
      'CRS: CH1903+ / LV95 (EPSG:2056), set by you',
    ]);
  });

  it('names an asserted CRS by who asserted it', () => {
    expect(crsText(crs({ source: 'catalog-tile', assertedBy: 'swisstopo LV95' }))).toBe('CH1903+ / LV95 (EPSG:2056), asserted by swisstopo LV95');
  });

  it('ignores events that are not log entries, and stops after dispose', () => {
    const s = setup();
    s.doc.dispatchEvent(new CustomEvent(SESSION_LOG_EVENT, { detail: { kind: 'bogus', text: 'x' } }));
    s.doc.dispatchEvent(new CustomEvent(SESSION_LOG_EVENT, { detail: { kind: 'command' } }));
    expect(s.log.entries()).toHaveLength(0);
    s.dispose();
    s.open('c2', 'b.ply');
    s.doc.dispatchEvent(new CustomEvent(SESSION_LOG_EVENT, { detail: { kind: 'command', text: 'Frame all' } }));
    expect(s.log.entries()).toHaveLength(0);
  });
});

describe('session log in the palette', () => {
  const actions = contributeHelpActions({
    getTour: () => null,
    ensureShortcutSheet: () => Promise.reject(new Error('unused')),
  });

  it('is a registry action titled "Session log"', () => {
    const a = actions.find((x) => x.id === 'help.session-log');
    expect(a?.title).toBe('Session log');
  });

  it.each(['actions', '/actions', 'session log', 'history'])('is found by "%s"', (q) => {
    expect(rankActions(q, actions)[0]?.action.id).toBe('help.session-log');
  });

  it('asks the workspace shell to open the page, and says so when it cannot', async () => {
    const notify = vi.fn();
    const doc = new EventTarget();
    vi.stubGlobal('document', doc);
    try {
      const a = contributeHelpActions({ getTour: () => null, ensureShortcutSheet: () => Promise.reject(new Error('unused')), notify })
        .find((x) => x.id === 'help.session-log')!;
      const open = vi.fn(() => Promise.resolve(true));
      const on = (e: Event): void => (e as CustomEvent<{ respond(p: Promise<boolean>): void }>).detail.respond(open());
      doc.addEventListener('olv-session-log-open', on);
      a.run();
      await Promise.resolve();
      await Promise.resolve();
      expect(open).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
      doc.removeEventListener('olv-session-log-open', on);
      a.run();
      await new Promise((r) => setTimeout(r, 0));
      expect(notify).toHaveBeenCalledWith('Open a scan first. The session log opens under Data.');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
