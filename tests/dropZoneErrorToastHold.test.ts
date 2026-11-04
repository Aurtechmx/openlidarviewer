import { describe, it, expect, vi } from 'vitest';
import { Node0, useBusyScanDomWithFakeTimers } from './helpers/busyScanDom';

useBusyScanDomWithFakeTimers();

async function freshZone() {
  const { DropZone } = await import('../src/ui/DropZone');
  const body = new Node0('body');
  const zone = new DropZone(body as unknown as HTMLElement, () => {});
  const toast = zone.toast as unknown as Node0;
  return { zone, toast, hidden: () => toast.cls.has('olv-hidden') };
}

describe('an error toast holds while it is hovered or focused', () => {
  it('stays while focused after the pointer passes over it and leaves', async () => {
    const z = await freshZone();
    z.zone.setError('Could not read the file.');
    z.toast.fire('focusin');
    vi.advanceTimersByTime(10_000);
    expect(z.hidden()).toBe(false);
    z.toast.fire('pointerenter');
    z.toast.fire('pointerleave');
    vi.advanceTimersByTime(6_100);
    expect(z.hidden()).toBe(false);
    z.toast.fire('focusout');
    vi.advanceTimersByTime(6_100);
    expect(z.hidden()).toBe(true);
  });

  it('stays while hovered after a control inside it takes and loses focus', async () => {
    const z = await freshZone();
    z.zone.setError('Could not read the file.');
    z.toast.fire('pointerenter');
    vi.advanceTimersByTime(10_000);
    z.toast.fire('focusin');
    z.toast.fire('focusout');
    vi.advanceTimersByTime(6_100);
    expect(z.hidden()).toBe(false);
    z.toast.fire('pointerleave');
    vi.advanceTimersByTime(6_100);
    expect(z.hidden()).toBe(true);
  });
});
