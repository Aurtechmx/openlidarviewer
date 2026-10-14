/**
 * dropZoneQueueCancel.test.ts: a multi-file drop opens files in turn. Cancel
 * this file stops only the current file; Cancel remaining files also empties
 * the queue; one file keeps the single Cancel; a failure does not stop the rest.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Node0, installBusyScanDom } from './helpers/busyScanDom';

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

type Zone = import('../src/ui/DropZone').DropZone;
type Step = (zone: Zone, name: string, done: () => void) => Promise<void> | void;

/** A zone whose loader runs `step` per file and lets the test finish each one. */
async function setup(step: Step) {
  const { DropZone } = await import('../src/ui/DropZone');
  const body = new Node0('body');
  const opened: string[] = [];
  const holder: { zone?: Zone } = {};
  const zone = new DropZone(body as unknown as HTMLElement, (file) => {
    opened.push(file.name);
    return new Promise<void>((resolve, reject) => {
      Promise.resolve(step(holder.zone!, file.name, resolve)).catch(reject);
    });
  });
  holder.zone = zone;
  const toast = zone.toast as unknown as Node0;
  const [cancel, cancelRest] = toast.find('olv-toast-cancel') as [Node0, Node0];
  const status = body.children.find((n) => n.attrs.role === 'status')!;
  const drop = (...names: string[]) => {
    const files = names.map((name) => ({ name }));
    for (const fn of body.listeners.drop ?? []) {
      (fn as unknown as (e: unknown) => void)({ preventDefault() {}, dataTransfer: { files } });
    }
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { zone, toast, cancel, cancelRest, status, drop, opened, flush };
}

/** A loader that opens the file and wires Cancel to end it as a cancel. */
const cancellable: Step = (zone, name, done) => {
  zone.setOpening(`Opening ${name}…`, name);
  zone.setCancelHandler(() => {
    zone.setCancelHandler(null);
    zone.setCancelled();
    done();
  });
};

describe('multi-file drop cancel scope', () => {
  it('shows the position and both Cancel controls with files left', async () => {
    const t = await setup(cancellable);
    t.drop('a.las', 'b.las', 'c.las');
    await t.flush();
    expect(t.toast.find('olv-toast-queue')[0].textContent).toBe('Opening 1 of 3 —');
    expect(t.cancel.cls.has('olv-hidden')).toBe(false);
    expect(t.cancel.textContent).toBe('Cancel this file');
    expect(t.cancel.attrs['aria-label']).toBe('Cancel loading this file');
    expect(t.cancelRest.cls.has('olv-hidden')).toBe(false);
    expect(t.cancelRest.textContent).toBe('Cancel remaining files');
    expect(t.cancelRest.attrs['aria-label']).toBe('Cancel this file and the 2 remaining files');
    expect(t.zone.remainingFiles).toBe(2);
  });

  it('Cancel this file stops the current file and opens the next', async () => {
    const t = await setup(cancellable);
    t.drop('a.las', 'b.las', 'c.las');
    await t.flush();
    t.cancel.fire('click');
    await t.flush();
    expect(t.opened).toEqual(['a.las', 'b.las']);
    expect(t.toast.find('olv-toast-queue')[0].textContent).toBe('Opening 2 of 3 —');
  });

  it('Cancel remaining files stops the current file and starts no other', async () => {
    const t = await setup(cancellable);
    t.drop('a.las', 'b.las', 'c.las');
    await t.flush();
    t.cancelRest.fire('click');
    await t.flush();
    expect(t.opened).toEqual(['a.las']);
    expect(t.toast.cls.has('olv-hidden')).toBe(true);
    expect(t.cancel.cls.has('olv-hidden')).toBe(true);
    expect(t.cancelRest.cls.has('olv-hidden')).toBe(true);
    expect(t.zone.remainingFiles).toBe(0);
    expect(t.status.textContent).toBe('Skipped 2 remaining files.');
  });

  it('keeps a single Cancel for one file and for the last file of a drop', async () => {
    const one = await setup(cancellable);
    one.drop('a.las');
    await one.flush();
    expect(one.cancel.textContent).toBe('Cancel');
    expect(one.cancel.attrs['aria-label']).toBe('Cancel loading');
    expect(one.cancelRest.cls.has('olv-hidden')).toBe(true);
    expect(one.toast.find('olv-toast-queue')[0].cls.has('olv-hidden')).toBe(true);

    const two = await setup(cancellable);
    two.drop('a.las', 'b.las');
    await two.flush();
    two.cancel.fire('click');
    await two.flush();
    expect(two.opened).toEqual(['a.las', 'b.las']);
    expect(two.cancel.textContent).toBe('Cancel');
    expect(two.cancelRest.cls.has('olv-hidden')).toBe(true);
  });

  it('a failing file reports its error and the rest continue', async () => {
    const t = await setup((zone, name, done) => {
      zone.setOpening(`Opening ${name}…`, name);
      if (name === 'bad.las') {
        zone.setError('bad.las could not be read.');
        done();
      }
    });
    t.drop('bad.las', 'ok.las');
    await t.flush();
    expect(t.opened).toEqual(['bad.las', 'ok.las']);
  });

  it('a thrown failure does not stop the rest', async () => {
    const t = await setup((_z, name) => {
      if (name === 'bad.las') throw new Error('boom');
    });
    t.drop('bad.las', 'ok.las');
    await t.flush();
    expect(t.opened).toEqual(['bad.las', 'ok.las']);
  });

  it('the queue ends with the drop: no label or second control remains', async () => {
    const t = await setup(cancellable);
    t.drop('a.las', 'b.las');
    await t.flush();
    t.cancel.fire('click');
    await t.flush();
    t.cancel.fire('click');
    await t.flush();
    expect(t.zone.remainingFiles).toBe(0);
    expect(t.cancel.cls.has('olv-hidden')).toBe(true);
    expect(t.cancelRest.cls.has('olv-hidden')).toBe(true);
  });
});
