/**
 * controlExplanationTip.test.ts — the `tip` wiring in `el()` (src/ui/dom.ts)
 * and its Escape-dismiss listener (`installControlTipDismissal`).
 *
 * Every hover/focus explanation shown by the `[data-tip]` CSS also needs an
 * accessible counterpart: a hidden description node referenced via
 * `aria-describedby`, and — for a control with no other visible label — the
 * tip doubling as the accessible name. This pins both, plus the Escape
 * dismissal behaviour, against the shared `liveFakeDom` stub (no jsdom in
 * this repo).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { installLiveFakeDom, FakeEl } from './helpers/liveFakeDom';

beforeAll(() => installLiveFakeDom());

describe('el({ tip })', () => {
  beforeEach(() => vi.useRealTimers());

  it('wires data-tip plus an aria-describedby text node', async () => {
    const { el } = await import('../src/ui/dom');
    const btn = el('button', { text: 'Export', tip: 'Download the flow rasters as a ZIP.' }) as unknown as FakeEl;
    expect(btn.dataset.tip).toBe('Download the flow rasters as a ZIP.');
    const descId = btn.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    const desc = btn.find((n) => n.id === descId);
    expect(desc?.ownText).toBe('Download the flow rasters as a ZIP.');
    expect(desc?.hasClass('olv-visually-hidden')).toBe(true);
  });

  it('gives an icon-only control (no visible text) the tip as its accessible name', async () => {
    const { el } = await import('../src/ui/dom');
    const btn = el('button', { className: 'olv-icon-btn', tip: 'Remove this layer.' }) as unknown as FakeEl;
    expect(btn.getAttribute('aria-label')).toBe('Remove this layer.');
  });

  it('does not overwrite an explicit ariaLabel with the tip', async () => {
    const { el } = await import('../src/ui/dom');
    const btn = el('button', { ariaLabel: 'Close', tip: 'Close this dialog without saving.' }) as unknown as FakeEl;
    expect(btn.getAttribute('aria-label')).toBe('Close');
  });

  it('leaves a labelled control (visible text) without a duplicate aria-label', async () => {
    const { el } = await import('../src/ui/dom');
    const btn = el('button', { text: 'Export PDF', tip: 'Generate the report.' }) as unknown as FakeEl;
    expect(btn.getAttribute('aria-label')).toBeNull();
  });
});

describe('installControlTipDismissal', () => {
  it('blurs the focused tip control and briefly suppresses hover tooltips on Escape', async () => {
    vi.useFakeTimers();
    const { installControlTipDismissal } = await import('../src/ui/dom');
    const active = new FakeEl('button');
    active.dataset.tip = 'Some explanation';
    active.focus();
    const body = new FakeEl('body');
    let handler: ((ev: { key: string }) => void) | undefined;
    const fakeDoc = {
      addEventListener: (type: string, fn: (ev: { key: string }) => void) => { if (type === 'keydown') handler = fn; },
      activeElement: active,
      body,
    } as unknown as Document;

    installControlTipDismissal(fakeDoc);
    expect(handler).toBeTypeOf('function');

    handler?.({ key: 'Escape' });
    expect(active.focused).toBe(false); // Escape blurred the focused tip control
    expect(body.hasClass('olv-tip-escaped')).toBe(true);

    vi.advanceTimersByTime(600);
    expect(body.hasClass('olv-tip-escaped')).toBe(false);
    vi.useRealTimers();
  });

  it('ignores keys other than Escape', async () => {
    const { installControlTipDismissal } = await import('../src/ui/dom');
    const body = new FakeEl('body');
    let handler: ((ev: { key: string }) => void) | undefined;
    const fakeDoc = {
      addEventListener: (type: string, fn: (ev: { key: string }) => void) => { if (type === 'keydown') handler = fn; },
      activeElement: null,
      body,
    } as unknown as Document;
    installControlTipDismissal(fakeDoc);
    handler?.({ key: 'a' });
    expect(body.hasClass('olv-tip-escaped')).toBe(false);
  });
});
