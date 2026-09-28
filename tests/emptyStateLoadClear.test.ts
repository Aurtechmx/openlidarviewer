/**
 * emptyStateLoadClear.test.ts: the empty state clears while a scan opens.
 *
 * The stylesheet keys the clear on the load toast being busy and shown
 * (`.olv-toast.is-busy:not(.olv-hidden)`), so the splash and the toast never
 * share the top-centre lane. These tests walk the toast through every load
 * outcome and check the state the stylesheet reads, then check the rules.
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
  // What the stylesheet's :has() reads: the splash clears while this is true.
  const clearing = (): boolean => toast.cls.has('is-busy') && !toast.cls.has('olv-hidden');
  return { zone, toast, clearing };
}

describe('empty state clear follows the load', () => {
  afterEach(() => vi.useRealTimers());

  it('is not clearing before any load', async () => {
    const { clearing } = await freshZone();
    expect(clearing()).toBe(false);
  });

  it('clears from the first "Opening" and stays cleared through every stage', async () => {
    const { zone, clearing } = await freshZone();
    zone.setOpening('Opening scan.laz…');
    expect(clearing()).toBe(true);
    zone.setPreload(['LAS 1.4, 12 M points']);
    expect(clearing()).toBe(true);
    zone.setProgress('Decoding…', 0.4);
    expect(clearing()).toBe(true);
    zone.setProgress('Rendering…');
    expect(clearing()).toBe(true);
  });

  it('brings the splash back when the load fails', async () => {
    const { zone, clearing } = await freshZone();
    zone.setOpening('Opening scan.laz…');
    zone.setError('Could not read this file.');
    expect(clearing()).toBe(false);
  });

  it('brings the splash back when the load is cancelled', async () => {
    const { zone, clearing } = await freshZone();
    zone.setOpening('Opening scan.laz…');
    zone.setProgress(null);
    expect(clearing()).toBe(false);
  });

  it('stays cleared through the success settle, then releases once the toast hides', async () => {
    vi.useFakeTimers();
    const { zone, toast, clearing } = await freshZone();
    zone.setProgress('Rendering…', 1);
    const left = zone.finish();
    expect(clearing()).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    toast.find('olv-bs-point')[0].fire('animationiteration');
    await vi.advanceTimersByTimeAsync(300);
    await expect(left).resolves.toBe(true);
    expect(clearing()).toBe(false);
  });

  it('clears again for a new load started after a failure', async () => {
    const { zone, clearing } = await freshZone();
    zone.setOpening('Opening a.laz…');
    zone.setError('Could not read this file.');
    zone.setOpening('Opening b.laz…');
    expect(clearing()).toBe(true);
  });
});

describe('empty state clear stylesheet', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/styles/30-empty-state.css', import.meta.url)), 'utf8');
  const BUSY = String.raw`\.olv-empty:has\(~ \.olv-toast\.is-busy:not\(\.olv-hidden\)\)`;
  const block = css.slice(css.indexOf('/* Opening a scan from the empty state.')).replace(/\/\*[\s\S]*?\*\//g, '');

  it('fades the splash content out and takes it out of reach', () => {
    expect(block).toMatch(new RegExp(`${BUSY} > \\*\\s*\\{[^}]*opacity:\\s*0[^}]*visibility:\\s*hidden`));
    expect(block).toMatch(new RegExp(`${BUSY}\\s*\\{\\s*pointer-events:\\s*none`));
  });

  it('shows the toast only after the splash has gone', () => {
    expect(block).toMatch(/\.olv-empty:not\(\.olv-hidden\) ~ \.olv-toast\.is-busy\s*\{[^}]*animation:[^;]*var\(--dur-base\) backwards/);
  });

  it('uses motion tokens only and drops all motion under reduced motion', () => {
    const motion = block.slice(block.indexOf('@media (prefers-reduced-motion: no-preference)'));
    const still = block.slice(0, block.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(motion).toMatch(/transition:/);
    expect(motion).toMatch(/animation: olv-toast-after-clear/);
    expect(still).not.toMatch(/transition:/);
    expect(still).not.toMatch(/animation: olv-/);
    expect(block).not.toMatch(/\d+ms/);
  });
});
