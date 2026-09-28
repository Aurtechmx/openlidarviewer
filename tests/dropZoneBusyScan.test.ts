/**
 * dropZoneBusyScan.test.ts: the busy scan in the load toast.
 *
 * The toast carries one fixed slot holding the status dot and the busy scan.
 * `is-busy` on the toast shows the scan (the stylesheet hides the dot); the
 * class is set for every loading state and dropped on success (hide), failure
 * (error) and cancel (hide). The scan is aria-hidden; the status text and the
 * separate role=status node are unchanged.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Node0, installBusyScanDom } from './helpers/busyScanDom';

beforeAll(() => {
  installBusyScanDom();
  (globalThis as unknown as Record<string, unknown>).window = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
});

async function freshZone() {
  const { DropZone } = await import('../src/ui/DropZone');
  const zone = new DropZone(new Node0('body') as unknown as HTMLElement, () => {});
  const toast = zone.toast as unknown as Node0;
  return { zone, toast, busy: () => toast.cls.has('is-busy') };
}

describe('load toast busy scan', () => {
  it('holds one aria-hidden scan next to the dot, in a fixed slot', async () => {
    const { toast } = await freshZone();
    const slot = toast.find('olv-toast-mark');
    expect(slot).toHaveLength(1);
    const scan = slot[0].find('olv-busy-scan');
    expect(scan).toHaveLength(1);
    expect(scan[0].getAttribute('aria-hidden')).toBe('true');
    expect(slot[0].find('olv-toast-dot')).toHaveLength(1);
  });

  it('is off before any load', async () => {
    const { busy } = await freshZone();
    expect(busy()).toBe(false);
  });

  it('turns on for opening, preload and every progress stage, keeping the text', async () => {
    const { zone, busy, toast } = await freshZone();
    zone.setOpening('Opening scan.laz…');
    expect(busy()).toBe(true);
    zone.setPreload(['LAS 1.4, 12 M points']);
    expect(busy()).toBe(true);
    zone.setProgress('Decoding…', 0.4);
    expect(busy()).toBe(true);
    expect(toast.find('olv-toast-text')[0].textContent).toBe('Decoding…');
    zone.setProgress('Indexing for streaming…');
    expect(busy()).toBe(true);
  });

  it('turns off when the load succeeds and the toast hides', async () => {
    const { zone, busy } = await freshZone();
    zone.setProgress('Decoding…');
    zone.setProgress(null);
    expect(busy()).toBe(false);
  });

  it('turns off when the load fails', async () => {
    const { zone, busy } = await freshZone();
    zone.setProgress('Decoding…');
    zone.setError('Could not read this file.');
    expect(busy()).toBe(false);
  });

  it('turns off when the load is cancelled', async () => {
    const { zone, busy } = await freshZone();
    let cancelled = false;
    zone.setCancelHandler(() => { cancelled = true; zone.setCancelHandler(null); zone.setProgress(null); });
    zone.setProgress('Reading…');
    (zone as unknown as { _onCancel: () => void })._onCancel();
    expect(cancelled).toBe(true);
    expect(busy()).toBe(false);
  });
});

describe('load toast progress and finish', () => {
  afterEach(() => vi.useRealTimers());

  const len = (toast: Node0) => Number(toast.find('olv-busy-scan')[0].style['--olv-bs-len']);

  it('grows the trail with the load fraction, and never shrinks it within a load', async () => {
    const { zone, toast } = await freshZone();
    zone.setOpening('Opening scan.laz…');
    const start = len(toast);
    zone.setProgress('Decoding…', 0.25);
    const a = len(toast);
    zone.setProgress('Decoding…', 0.75);
    const b = len(toast);
    zone.setProgress('Rendering…');
    zone.setProgress('Decoding…', 0.5);
    expect(a).toBeGreaterThan(start);
    expect(b).toBeGreaterThan(a);
    expect(len(toast)).toBe(b);
  });

  it('settles and then hides on finish', async () => {
    vi.useFakeTimers();
    const { zone, toast, busy } = await freshZone();
    zone.setProgress('Decoding…', 0.5);
    const left = zone.finish();
    expect(toast.cls.has('olv-hidden')).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    toast.find('olv-bs-point')[0].fire('animationiteration');
    await vi.advanceTimersByTimeAsync(0);
    expect(toast.find('olv-busy-scan')[0].cls.has('is-settled')).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(toast.cls.has('olv-hidden')).toBe(true);
    expect(busy()).toBe(false);
    await expect(left).resolves.toBe(true);
  });

  it('drops the late hide when a new load starts during the settle', async () => {
    vi.useFakeTimers();
    const { zone, toast } = await freshZone();
    zone.setProgress('Decoding…', 0.5);
    const left = zone.finish();
    zone.setOpening('Opening next.laz…');
    await vi.advanceTimersByTimeAsync(2000);
    expect(toast.cls.has('olv-hidden')).toBe(false);
    await expect(left).resolves.toBe(false);
  });
});

describe('load toast stylesheet', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/styles/57-busy-scan.css', import.meta.url)), 'utf8');
  it('shows the scan only while busy and gives the slot a fixed width', () => {
    expect(css).toMatch(/\.olv-toast-mark\s*\{[^}]*flex:\s*none[^}]*width:\s*2em/);
    expect(css).toMatch(/\.olv-toast\.is-busy \.olv-toast-mark \.olv-toast-dot/);
    expect(css).toMatch(/\.olv-toast:not\(\.is-busy\) \.olv-toast-mark \.olv-busy-scan\s*\{\s*display:\s*none/);
  });
});
