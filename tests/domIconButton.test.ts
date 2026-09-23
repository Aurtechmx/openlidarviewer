/**
 * domIconButton.test.ts
 *
 * INSPECT-INSP-8: Inspector.ts, LayerGroupsPanel.ts and ClassLegendPanel.ts
 * each hand-rolled the same small icon-action-button shape — glyph, title,
 * ariaLabel, type="button", a click listener — independently, roughly ten
 * times across the three files. `iconButton()` is the one constructor that
 * shape now goes through, so an a11y fix to it (like INSP-4's aria-label
 * flip) lives in one place.
 *
 * These tests pin the helper's own contract; the call-site conversions are
 * covered by each component's existing suites (inspectorLayerLock,
 * layerGroupsPanel, classLegendLiveAnnounce, …), which still pass unchanged.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { iconButton } from '../src/ui/dom';
import { installFakeDom, FakeEl } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
});

describe('iconButton', () => {
  it('wires className, text, title, ariaLabel and the click handler', () => {
    const onClick = vi.fn();
    const btn = iconButton({
      className: 'olv-thing',
      text: '×',
      title: 'Remove thing',
      ariaLabel: 'Remove thing',
      onClick,
    }) as unknown as FakeEl;

    expect(btn.className).toBe('olv-thing');
    expect(btn.textContent).toBe('×');
    expect(btn.title).toBe('Remove thing');
    expect(btn.getAttribute('aria-label')).toBe('Remove thing');
    expect(onClick).not.toHaveBeenCalled();
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('accepts unsafeHtml in place of text, for a glyph + label span', () => {
    const btn = iconButton({
      className: 'olv-thing',
      unsafeHtml: '<svg></svg><span>Solo</span>',
      ariaLabel: 'Solo',
      onClick: () => {},
    }) as unknown as FakeEl;
    expect(btn.innerHTML).toBe('<svg></svg><span>Solo</span>');
  });

  it('title is optional — omitting it leaves no title attribute', () => {
    const btn = iconButton({
      className: 'olv-thing',
      text: '▾',
      ariaLabel: 'Expand or collapse',
      onClick: () => {},
    }) as unknown as FakeEl;
    expect(btn.title).toBe('');
  });

  it('sets aria-pressed only when given, mirroring the value passed', () => {
    const noToggle = iconButton({
      className: 'olv-thing',
      text: '×',
      ariaLabel: 'Remove',
      onClick: () => {},
    }) as unknown as FakeEl;
    expect(noToggle.getAttribute('aria-pressed')).toBeNull();

    const toggleOff = iconButton({
      className: 'olv-thing',
      text: '○',
      ariaLabel: 'Lock',
      ariaPressed: false,
      onClick: () => {},
    }) as unknown as FakeEl;
    expect(toggleOff.getAttribute('aria-pressed')).toBe('false');

    const toggleOn = iconButton({
      className: 'olv-thing',
      text: '●',
      ariaLabel: 'Locked',
      ariaPressed: true,
      onClick: () => {},
    }) as unknown as FakeEl;
    expect(toggleOn.getAttribute('aria-pressed')).toBe('true');
  });

  it('starts disabled when asked, and enabled otherwise', () => {
    const disabled = iconButton({
      className: 'olv-thing',
      text: 'Solo',
      ariaLabel: 'Solo',
      disabled: true,
      onClick: () => {},
    }) as unknown as FakeEl;
    expect(disabled.disabled).toBe(true);

    const enabled = iconButton({
      className: 'olv-thing',
      text: 'Solo',
      ariaLabel: 'Solo',
      onClick: () => {},
    }) as unknown as FakeEl;
    expect(enabled.disabled).toBe(false);
  });
});
