/**
 * helpOverlayLazyFailure.test.ts — the Help overlay's chunk-load failure path
 * (LAZY-1: OVERLAYS-LAZY-1). Companion to the happy-path coverage in
 * `tests/e2e/helpOverlay.spec.ts`; this pins the DOM-free contract that a
 * failed `loadHelpOverlay()` reports through the bound toast, with a "Try
 * again" action, instead of an unhandled rejection — and that "Try again"
 * actually finishes the job on a later success.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const HelpOverlay = vi.fn(function (this: { isOpen: boolean; element: {}; open: () => void; toggle: () => void; openTopic: () => void; openForAction: () => void }) {
  this.isOpen = false;
  this.element = {};
  this.open = vi.fn(() => { this.isOpen = true; });
  this.toggle = vi.fn();
  this.openTopic = vi.fn();
  this.openForAction = vi.fn();
});
const shortcutDescriptors = vi.fn(() => []);
let loadResult: 'success' | 'reject' | 'undefined' = 'success';
const loadHelpOverlay = vi.fn(() => {
  if (loadResult === 'reject') return Promise.reject(new Error('chunk failed to fetch'));
  if (loadResult === 'undefined') return Promise.resolve(undefined as unknown as { HelpOverlay: typeof HelpOverlay; shortcutDescriptors: typeof shortcutDescriptors });
  return Promise.resolve({ HelpOverlay, shortcutDescriptors });
});

vi.mock('../src/lazyChunks', () => ({
  loadHelpOverlay: () => loadHelpOverlay(),
}));

import { createHelpOverlayLazy } from '../src/app/helpOverlayLazy';

function fakeToast() {
  const calls: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  return { show: (message: string, action?: { label: string; onClick: () => void }) => { calls.push({ message, action }); }, calls };
}

const host = { append: vi.fn() } as unknown as HTMLElement;

beforeEach(() => {
  loadResult = 'success';
  HelpOverlay.mockClear();
  loadHelpOverlay.mockClear();
});

describe('createHelpOverlayLazy — failure path', () => {
  it('reports a rejected chunk through the toast instead of throwing', async () => {
    loadResult = 'reject';
    const toast = fakeToast();
    const overlay = createHelpOverlayLazy(host, { getActions: () => Promise.resolve([]), toast });
    expect(() => overlay.open()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.calls).toHaveLength(1);
    expect(toast.calls[0].message).toBe('chunk failed to fetch');
    expect(toast.calls[0].action?.label).toBe('Try again');
    expect(overlay.isOpen()).toBe(false);
  });

  it('reports the stale-chunk "resolves to undefined" case the same way', async () => {
    loadResult = 'undefined';
    const toast = fakeToast();
    const overlay = createHelpOverlayLazy(host, { getActions: () => Promise.resolve([]), toast });
    overlay.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.calls).toHaveLength(1);
    expect(overlay.isOpen()).toBe(false);
  });

  it('a "Try again" action that succeeds actually opens the overlay', async () => {
    loadResult = 'reject';
    const toast = fakeToast();
    const overlay = createHelpOverlayLazy(host, { getActions: () => Promise.resolve([]), toast });
    overlay.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.calls).toHaveLength(1);

    loadResult = 'success';
    toast.calls[0].action?.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(overlay.isOpen()).toBe(true);
    expect(loadHelpOverlay).toHaveBeenCalledTimes(2);
  });

  it('openTopic / openForAction / toggle each survive a failed load without throwing', async () => {
    loadResult = 'reject';
    const toast = fakeToast();
    const overlay = createHelpOverlayLazy(host, { getActions: () => Promise.resolve([]), toast });
    expect(() => overlay.openTopic('x')).not.toThrow();
    expect(() => overlay.openForAction('y')).not.toThrow();
    expect(() => overlay.toggle()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.calls.length).toBeGreaterThan(0);
  });
});
