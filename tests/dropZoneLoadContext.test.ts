/**
 * dropZoneLoadContext.test.ts: the open status keeps the file's name, format
 * and loading scope on screen through every stage of one open, keeps a
 * preflight warning under the progress line, paces repeated updates, and
 * announces stages and coarse milestones rather than every update. Nothing
 * from one open can draw over the next.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Node0, installBusyScanDom } from './helpers/busyScanDom';
import { createDisplayThrottle } from '../src/ui/displayThrottle';

beforeAll(() => {
  installBusyScanDom();
});

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as Record<string, unknown>).window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

async function freshZone() {
  const { DropZone } = await import('../src/ui/DropZone');
  const body = new Node0('body');
  const zone = new DropZone(body as unknown as HTMLElement, () => {});
  const toast = zone.toast as unknown as Node0;
  const one = (c: string) => toast.find(c)[0];
  const status = body.children.find((n) => n.attrs.role === 'status')!;
  // Every value written to the polite region, in order, empty writes excluded.
  const spoken: string[] = [];
  const proto = Object.getPrototypeOf(status) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'textContent')!;
  Object.defineProperty(status, 'textContent', {
    get() { return desc.get!.call(status); },
    set(v: string) { if (v) spoken.push(v); desc.set!.call(status, v); },
  });
  return {
    zone,
    toast,
    body,
    status,
    spoken,
    text: () => one('olv-toast-text').textContent,
    file: () => one('olv-toast-file'),
    facts: () => one('olv-toast-facts').textContent,
    note: () => one('olv-toast-note'),
    context: () => one('olv-toast-context'),
    mark: () => one('olv-toast-mark'),
    bar: () => one('olv-toast-bar'),
    fill: () => one('olv-toast-bar-fill'),
  };
}

const READ = { stage: 'reading-file', announce: 'Reading file', trail: false } as const;

describe('file context across one open', () => {
  it('shows the name with "Checking file…" until preflight says what the file is', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening survey.e57…', 'survey.e57');
    expect(z.context().cls.has('olv-hidden')).toBe(false);
    expect(z.file().textContent).toBe('survey.e57');
    expect(z.facts()).toBe('Checking file…');
    expect(z.text()).toBe('Opening…');
  });

  it('keeps the name, format and scope through every stage', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening survey.e57…', 'survey.e57');
    const op = z.zone.operation;
    z.zone.setStageProgress('Detecting format…', undefined, { op, stage: 'detecting-format' });
    z.zone.setFileContext({ facts: ['E57', 'Sampled load'] }, op);
    const check = () => {
      expect(z.file().textContent).toBe('survey.e57');
      expect(z.facts()).toBe('E57 · Sampled load');
      expect(z.context().cls.has('olv-hidden')).toBe(false);
    };
    check();
    z.zone.setStageProgress('Reading file — 0 B of 600.0 MiB', 0, { op, ...READ });
    check();
    vi.advanceTimersByTime(200);
    z.zone.setStageProgress('Reading file — 300.0 MiB of 600.0 MiB', 0.5, { op, ...READ });
    check();
    z.zone.setStageProgress('Decoding points…', undefined, { op, stage: 'decoding' });
    check();
    z.zone.setProgress('Preparing display…');
    check();
    z.zone.setProgress('Rendering…');
    check();
  });

  it('keeps a preflight warning visible through routine byte updates', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening big.e57…', 'big.e57');
    const op = z.zone.operation;
    const warning = 'Large E57 scan: it will be read as a SAMPLE of one record per 4.';
    z.zone.setFileContext({ facts: ['E57', 'Sampled load'], note: warning }, op);
    for (let k = 0; k <= 20; k++) {
      z.zone.setStageProgress(`Reading file — ${k} of 20`, k / 20, { op, ...READ });
      vi.advanceTimersByTime(40);
      expect(z.note().textContent).toBe(warning);
      expect(z.note().cls.has('olv-hidden')).toBe(false);
    }
    vi.advanceTimersByTime(500);
    expect(z.note().textContent).toBe(warning);
  });
});

describe('stale context is cleared', () => {
  async function opened() {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    z.zone.setFileContext({ facts: ['LAS', 'Standard load'], note: 'Large LAS scan.' }, z.zone.operation);
    return z;
  }
  const cleared = (z: Awaited<ReturnType<typeof freshZone>>) => {
    expect(z.context().cls.has('olv-hidden')).toBe(true);
    expect(z.file().textContent).toBe('');
    expect(z.facts()).toBe('');
    expect(z.note().textContent).toBe('');
    expect(z.note().cls.has('olv-hidden')).toBe(true);
  };

  it('on failure', async () => {
    const z = await opened();
    z.zone.setError('Could not read a.las.');
    cleared(z);
    expect(z.text()).toBe('Could not read a.las.');
  });

  it('on cancel, and says so politely', async () => {
    const z = await opened();
    z.zone.setCancelled();
    cleared(z);
    expect(z.toast.cls.has('olv-hidden')).toBe(true);
    expect(z.status.textContent).toBe('Cancelled opening a.las.');
  });

  it('on success, once the toast leaves', async () => {
    const z = await opened();
    z.zone.setStageProgress('Decoding…', 0.5, { op: z.zone.operation, stage: 'decoding' });
    const left = z.zone.finish();
    expect(z.status.textContent).toBe('Opened a.las.');
    await vi.advanceTimersByTimeAsync(300);
    z.toast.find('olv-bs-point')[0].fire('animationiteration');
    await vi.advanceTimersByTimeAsync(400);
    await expect(left).resolves.toBe(true);
    cleared(z);
    // The completion stays for the screen reader after the toast hides.
    expect(z.status.textContent).toBe('Opened a.las.');
  });

  it('on the next open', async () => {
    const z = await opened();
    z.zone.setOpening('Opening b.ply…', 'b.ply');
    expect(z.file().textContent).toBe('b.ply');
    expect(z.facts()).toBe('Checking file…');
    expect(z.note().textContent).toBe('');
    expect(z.note().cls.has('olv-hidden')).toBe(true);
  });

  it('on a plain hide', async () => {
    const z = await opened();
    z.zone.setProgress(null);
    cleared(z);
  });
});

describe('one open cannot draw over the next', () => {
  it('drops a held update from open A once open B starts', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const a = z.zone.operation;
    z.zone.setStageProgress('Reading file — 1 of 4', 0.25, { op: a, ...READ });
    // Inside the pacing window: held, not drawn.
    z.zone.setStageProgress('Reading file — 2 of 4', 0.5, { op: a, ...READ });
    z.zone.setOpening('Opening b.las…', 'b.las');
    await vi.advanceTimersByTimeAsync(1000);
    expect(z.text()).toBe('Opening…');
    expect(z.file().textContent).toBe('b.las');
  });

  it('ignores late updates and context from open A after B starts', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const a = z.zone.operation;
    z.zone.setOpening('Opening b.las…', 'b.las');
    const b = z.zone.operation;
    expect(b).not.toBe(a);
    z.zone.setStageProgress('Decoding points…', 0.9, { op: a, stage: 'decoding' });
    z.zone.setFileContext({ facts: ['LAS', 'Sampled load'], note: 'from A' }, a);
    expect(z.text()).toBe('Opening…');
    expect(z.facts()).toBe('Checking file…');
    expect(z.note().textContent).toBe('');
    z.zone.setFileContext({ facts: ['LAS', 'Standard load'] }, b);
    expect(z.facts()).toBe('LAS · Standard load');
  });

  it('ignores updates that arrive after the open failed or finished', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const a = z.zone.operation;
    z.zone.setError('Failed.');
    z.zone.setStageProgress('Decoding points…', 0.5, { op: a, stage: 'decoding' });
    expect(z.text()).toBe('Failed.');
    expect(z.toast.cls.has('olv-toast-error')).toBe(true);
  });
});

describe('pacing and announcements', () => {
  it('draws a stage change at once and paces repeats within it', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const op = z.zone.operation;
    z.zone.setStageProgress('Reading file — 0%', 0, { op, ...READ });
    expect(z.text()).toBe('Reading file — 0%');
    z.zone.setStageProgress('Reading file — 10%', 0.1, { op, ...READ });
    z.zone.setStageProgress('Reading file — 20%', 0.2, { op, ...READ });
    expect(z.text()).toBe('Reading file — 0%');
    vi.advanceTimersByTime(150);
    expect(z.text()).toBe('Reading file — 20%');
    // A new stage is not held behind the pacing window.
    z.zone.setStageProgress('Decoding points…', undefined, { op, stage: 'decoding' });
    expect(z.text()).toBe('Decoding points…');
  });

  it('announces the file once, each stage once and reading at each quarter, not every update', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const op = z.zone.operation;
    z.zone.setStageProgress('Detecting format…', undefined, { op, stage: 'detecting-format', announce: 'Detecting format' });
    for (let k = 0; k <= 100; k++) {
      z.zone.setStageProgress(`Reading file — ${k}%`, k / 100, { op, ...READ });
      vi.advanceTimersByTime(20);
    }
    z.zone.setStageProgress('Decoding points…', undefined, { op, stage: 'decoding', announce: 'Decoding points' });
    expect(z.spoken).toEqual([
      'Opening a.las…',
      'Detecting format',
      'Reading file',
      'Reading file, 25%',
      'Reading file, 50%',
      'Reading file, 75%',
      'Reading file, 100%',
      'Decoding points',
    ]);
    expect(z.spoken.filter((s) => s.includes('a.las'))).toHaveLength(1);
  });

  it('a held update never skips the end of a stage', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const op = z.zone.operation;
    z.zone.setStageProgress('Reading file — 0%', 0, { op, ...READ });
    z.zone.setStageProgress('Reading file — 100%', 1, { op, ...READ });
    expect(z.text()).toBe('Reading file — 100%');
    expect(z.spoken).toContain('Reading file, 100%');
  });
});

describe('progressbar semantics', () => {
  it('carries a value only while the stage is determinate, and drops it for an indeterminate stage', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const op = z.zone.operation;
    expect(z.mark().getAttribute('role')).toBe('progressbar');
    expect(z.mark().getAttribute('aria-valuenow')).toBeNull();
    z.zone.setStageProgress('Reading file — 60%', 0.6, { op, ...READ });
    expect(z.mark().getAttribute('aria-valuenow')).toBe('60');
    expect(z.bar().cls.has('olv-hidden')).toBe(false);
    expect(z.fill().style.width).toBe('60%');
    z.zone.setStageProgress('Decoding points…', undefined, { op, stage: 'decoding' });
    expect(z.mark().getAttribute('aria-valuenow')).toBeNull();
    expect(z.mark().getAttribute('aria-valuetext')).toBe('Decoding points…');
    expect(z.bar().cls.has('olv-hidden')).toBe(true);
    expect(z.fill().style.width).toBe('0%');
  });

  it('drops the role once nothing is loading', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    z.zone.setError('Failed.');
    expect(z.mark().getAttribute('role')).toBeNull();
    z.zone.setOpening('Opening b.las…', 'b.las');
    z.zone.setProgress(null);
    expect(z.mark().getAttribute('role')).toBeNull();
  });

  it('keeps the busy trail out of the read and on the decode', async () => {
    const z = await freshZone();
    z.zone.setOpening('Opening a.las…', 'a.las');
    const op = z.zone.operation;
    const len = () => Number(z.toast.find('olv-busy-scan')[0].style['--olv-bs-len']);
    const start = len();
    z.zone.setStageProgress('Reading file — 100%', 1, { op, ...READ });
    expect(len()).toBe(start);
    z.zone.setStageProgress('Decoding points…', 0.5, { op, stage: 'decoding' });
    expect(len()).toBeGreaterThan(start);
  });

  it('keeps the Cancel control named', async () => {
    const z = await freshZone();
    const cancel = z.toast.find('olv-toast-cancel')[0];
    expect(cancel.getAttribute('aria-label')).toBe('Cancel loading');
  });
});

describe('file names and warnings render as text', () => {
  const names = [
    `${'very-long-survey-name-'.repeat(12)}final.e57`,
    '測量データ_北側_🌲.las',
    '<img src=x onerror=alert(1)>.ply',
    'a&amp;b<script>x</script>.laz',
  ];
  it.each(names)('%s', async (name) => {
    const z = await freshZone();
    z.zone.setOpening(`Opening ${name}…`, name);
    z.zone.setFileContext({ facts: ['PLY'], note: '<b>not bold</b> & not markup' }, z.zone.operation);
    expect(z.file().textContent).toBe(name);
    expect(z.file().title).toBe(name);
    expect(z.file().children).toHaveLength(0);
    expect(z.note().textContent).toBe('<b>not bold</b> & not markup');
    expect(z.note().children).toHaveLength(0);
    const all = (n: Node0): Node0[] => [n, ...n.children.flatMap(all)];
    for (const n of all(z.toast)) expect(Object.prototype.hasOwnProperty.call(n, 'innerHTML')).toBe(false);
  });
});

describe('createDisplayThrottle', () => {
  function clock() {
    let t = 0;
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    return {
      advance(ms: number) {
        t += ms;
        for (const timer of timers) if (timer.live && timer.at <= t) { timer.live = false; timer.fn(); }
      },
      c: {
        now: () => t,
        setTimeout: (fn: () => void, ms: number) => { const timer = { at: t + ms, fn, live: true }; timers.push(timer); return timer; },
        clearTimeout: (h: unknown) => { (h as { live: boolean }).live = false; },
      },
    };
  }

  it('runs the first update, holds the latest repeat and runs it at the interval', () => {
    const k = clock();
    const th = createDisplayThrottle(150, k.c);
    const ran: number[] = [];
    th.push(() => ran.push(1), false);
    th.push(() => ran.push(2), false);
    th.push(() => ran.push(3), false);
    expect(ran).toEqual([1]);
    expect(th.pending).toBe(true);
    k.advance(150);
    expect(ran).toEqual([1, 3]);
  });

  it('an immediate update runs the held one first; cancel drops it', () => {
    const k = clock();
    const th = createDisplayThrottle(150, k.c);
    const ran: string[] = [];
    th.push(() => ran.push('a'), false);
    th.push(() => ran.push('held'), false);
    th.push(() => ran.push('now'), true);
    k.advance(500);
    expect(ran).toEqual(['a', 'held', 'now']);
    th.push(() => ran.push('b'), false);
    th.push(() => ran.push('held2'), false);
    th.cancel();
    k.advance(500);
    expect(ran).toEqual(['a', 'held', 'now', 'b']);
    expect(th.pending).toBe(false);
  });
});
