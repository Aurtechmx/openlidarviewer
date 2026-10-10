/**
 * measurePhoneHint.test.ts
 *
 * The measurement instruction on a phone: the stylesheet shows a compact
 * status line instead of hiding it, and the hint elements are polite live
 * regions that change text only when the state text changes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { installFakeDom } from './support/measurePanelDom';

const css = (n: string): string => readFileSync(`src/styles/${n}`, 'utf8');

describe('phone stylesheet', () => {
  const audit = css('83-mobile-audit.css');
  it('adds the compact phone status line next to the rail', () => {
    expect(audit).toMatch(/\.olv-measure-phone-hint \{[^}]*display: -webkit-box/);
    expect(audit).toMatch(/\.olv-measure-phone-hint \{[^}]*-webkit-line-clamp: 2/);
    expect(audit).toMatch(/\.olv-measure-phone-hint \{[^}]*left: calc\(88px/);
    expect(audit).toMatch(/\.olv-measure-phone-hint \{[^}]*top: calc\(var\(--olv-lane-top\) \+ 30px\)/);
    expect(audit).toMatch(/\.olv-phone-hint-wide \{[^}]*top: calc\(var\(--olv-lane-top\) \+ 2 \* var\(--space-lg\) \+ 44px/);
    expect(audit).toMatch(/\.olv-measure-phone-hint\.olv-hidden \{ display: none; \}/);
  });
  it('keeps the in-rail row hidden so the text is not announced twice', () => {
    expect(audit).toMatch(/\.olv-measure-hint-row \{ display: none; \}/);
  });
  it('hides the phone line outside the phone block', () => {
    expect(css('60-measure-inspect.css')).toMatch(/^\.olv-measure-phone-hint \{ display: none; \}$/m);
    expect(audit.split('.olv-measure-phone-hint {').length - 1).toBe(1);
  });
  it('uses existing type tokens only', () => {
    const rule = /\.olv-measure-phone-hint \{[^}]*\}/.exec(audit)![0];
    expect(rule).toContain('var(--text-xs)');
    expect(rule).not.toMatch(/font-size: \d/);
  });
});

describe('live hint elements', () => {
  beforeAll(() => {
    installFakeDom({ ns: true });
    (globalThis as { window?: unknown }).window ??= { addEventListener: () => {}, removeEventListener: () => {} };
  });

  it('MeasureController hint text and phone line are polite status regions', async () => {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const m = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    const inner = m as unknown as { _hintEl: HTMLElement; _phoneHintEl: HTMLElement };
    for (const node of [inner._hintEl, inner._phoneHintEl]) {
      expect(node.getAttribute('role')).toBe('status');
      expect(node.getAttribute('aria-live')).toBe('polite');
      expect(node.getAttribute('aria-atomic')).toBe('true');
    }
  });

  it('every measure kind writes a non-empty instruction to both lines', async () => {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const m = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    const inner = m as unknown as {
      _hintEl: HTMLElement; _phoneHintEl: HTMLElement; _kind: string; _updateHint(): void;
    };
    m.setActive(true);
    for (const kind of ['distance', 'polyline', 'area', 'height', 'angle', 'slope', 'profile', 'box', 'volume']) {
      inner._kind = kind;
      inner._updateHint();
      expect(inner._hintEl.textContent, kind).toBeTruthy();
      expect(inner._phoneHintEl.textContent, kind).toBe(inner._hintEl.textContent);
    }
  });

  it('the phone line hides with the bar and shows with it', async () => {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const m = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    const inner = m as unknown as { _phoneHintEl: HTMLElement };
    const host = document.createElement('div');
    host.append(m.hint);
    m.setActive(true);
    expect(inner._phoneHintEl.classList.contains('olv-hidden')).toBe(false);
    expect(m.hint.classList.contains('olv-hidden')).toBe(false);
    m.setActive(false);
    expect(inner._phoneHintEl.classList.contains('olv-hidden')).toBe(true);
  });

  it('a refusal notice shows the line, then the timer hides it with the bar', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const { MeasureController } = await import('../src/render/measure/MeasureController');
      const m = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
      const inner = m as unknown as { _phoneHintEl: HTMLElement };
      const host = document.createElement('div');
      host.append(m.hint);
      m.setActive(true);
      (m as unknown as { _draft: unknown })._draft = { kind: 'area', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] };
      m.setActive(false);
      expect(inner._phoneHintEl.classList.contains('olv-hidden')).toBe(false);
      expect(inner._phoneHintEl.textContent).toMatch(/^Area polygon not saved/);
      vi.advanceTimersByTime(6001);
      expect(m.hint.classList.contains('olv-hidden')).toBe(true);
      expect(inner._phoneHintEl.classList.contains('olv-hidden')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writing the same text twice leaves the text node untouched', async () => {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const m = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    const inner = m as unknown as { _hintEl: HTMLElement; _phoneHintEl: HTMLElement; _setHintText(t: string): void };
    inner._setHintText('Pick the first point');
    const hintNode = inner._hintEl.firstChild;
    const phoneNode = inner._phoneHintEl.firstChild;
    inner._setHintText('Pick the first point');
    expect(inner._hintEl.firstChild).toBe(hintNode);
    expect(inner._phoneHintEl.firstChild).toBe(phoneNode);
    inner._setHintText('Pick the second point');
    expect(inner._hintEl.textContent).toBe('Pick the second point');
  });

  it('InspectTool hint is a polite status with a phone line', async () => {
    const src = readFileSync('src/render/InspectTool.ts', 'utf8');
    expect(src).toMatch(/_hintText = politeStatus\(/);
    expect(src).toMatch(/_phoneHint = politeStatus\(/);
    expect(src).toMatch(/if \(this\._hintText\.textContent !== text\)/);
  });
});
