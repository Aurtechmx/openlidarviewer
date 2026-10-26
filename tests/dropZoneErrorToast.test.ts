/**
 * dropZoneErrorToast.test.ts: an error toast stays long enough to be read,
 * holds while it is hovered or focused, and can be dismissed. A refusal that
 * explains itself in forty words no longer vanishes after six seconds.
 */

import { describe, it, expect, vi } from 'vitest';
import { Node0, useBusyScanDomWithFakeTimers } from './helpers/busyScanDom';
import { errorToastDuration } from '../src/ui/DropZone';

useBusyScanDomWithFakeTimers();

const WORDS = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

async function freshZone() {
  const { DropZone } = await import('../src/ui/DropZone');
  const body = new Node0('body');
  const zone = new DropZone(body as unknown as HTMLElement, () => {});
  const toast = zone.toast as unknown as Node0;
  const one = (c: string) => toast.find(c)[0];
  return {
    zone,
    toast,
    hidden: () => toast.cls.has('olv-hidden'),
    dismiss: () => one('olv-toast-dismiss'),
    log: () => one('olv-toast-log'),
  };
}

describe('errorToastDuration', () => {
  it('is six seconds for a short message and grows by 0.4 s per word, up to 30 s', () => {
    expect(errorToastDuration('Could not read the file.', false)).toBe(6_000);
    expect(errorToastDuration(WORDS(15), false)).toBe(6_000);
    expect(errorToastDuration(WORDS(40), false)).toBe(16_000);
    expect(errorToastDuration(WORDS(200), false)).toBe(30_000);
  });

  it('keeps at least the 20 s a copyable report always had', () => {
    expect(errorToastDuration('Short.', true)).toBe(20_000);
    expect(errorToastDuration(WORDS(60), true)).toBe(24_000);
  });
});

describe('the error toast', () => {
  it('stays for its word count, then hides', async () => {
    const z = await freshZone();
    z.zone.setError(WORDS(40));
    expect(z.hidden()).toBe(false);
    vi.advanceTimersByTime(6_000);
    expect(z.hidden()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(z.hidden()).toBe(true);
  });

  it('holds while hovered and lets the remaining time run after the pointer leaves', async () => {
    const z = await freshZone();
    z.zone.setError('Could not read the file.');
    vi.advanceTimersByTime(3_000);
    z.toast.fire('pointerenter');
    vi.advanceTimersByTime(60_000);
    expect(z.hidden()).toBe(false);
    z.toast.fire('pointerleave');
    vi.advanceTimersByTime(2_900);
    expect(z.hidden()).toBe(false);
    vi.advanceTimersByTime(200);
    expect(z.hidden()).toBe(true);
  });

  it('holds while focused, too', async () => {
    const z = await freshZone();
    z.zone.setError('Could not read the file.');
    z.toast.fire('focusin');
    vi.advanceTimersByTime(60_000);
    expect(z.hidden()).toBe(false);
    z.toast.fire('focusout');
    vi.advanceTimersByTime(6_100);
    expect(z.hidden()).toBe(true);
  });

  it('offers Dismiss and Show in Session log, and Dismiss hides it at once', async () => {
    const z = await freshZone();
    z.zone.setError('Could not read the file.');
    expect(z.dismiss().cls.has('olv-hidden')).toBe(false);
    expect(z.dismiss().attrs['aria-label']).toBe('Dismiss message');
    expect(z.log().cls.has('olv-hidden')).toBe(false);
    expect(z.log().textContent).toBe('Show in Session log');
    z.dismiss().fire('click');
    expect(z.hidden()).toBe(true);
    // The hide timer is gone with it: nothing fires later over a newer toast.
    z.zone.setProgress('Opening…');
    vi.advanceTimersByTime(60_000);
    expect(z.hidden()).toBe(false);
  });

  it('hides its error controls while progress shows', async () => {
    const z = await freshZone();
    z.zone.setError('Could not read the file.');
    z.zone.setProgress('Opening…');
    expect(z.dismiss().cls.has('olv-hidden')).toBe(true);
    expect(z.log().cls.has('olv-hidden')).toBe(true);
  });
});
