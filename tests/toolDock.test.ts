/**
 * tests/toolDock.test.ts
 *
 * Pins the tool dock's rendered contract, which is user-visible and mirrored by
 * the mobile stylesheets: the exact button order, each tool's initial disabled
 * state, its per-tool CSS class, the aria-pressed toggles, the cluster-gap
 * markers, and the enable/active patching behaviour. The manifest refactor must
 * reproduce all of this byte-for-byte, including the old name-stable shims
 * (setMeasureEnabled etc.) that main.ts / openScan.ts still call.
 *
 * Runs in the node environment through a recording DOM stub (mirrors
 * annotationIssuePanel.test.ts). Note the stub deliberately does NOT define
 * HTMLButtonElement — the dock code must not rely on `instanceof` for it.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { FakeEl } from './support/measurePanelDom';

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    querySelector: () => null,
  };
  // Deliberately no HTMLButtonElement, matching the historical UI-test stubs.
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.window = {
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout: (fn: () => void, _ms?: number) => {
      void fn;
      return 1 as unknown as number;
    },
    clearTimeout: () => {},
  };
});

// eslint-disable-next-line import/first
import { ToolDock } from '../src/ui/toolDock';

function noop(): void {}

function makeDock(): ToolDock {
  return new ToolDock({
    onFrameAll: noop,
    onSnapshot: noop,
    onShare: noop,
    onMeasureToggle: noop,
    onInspectToggle: noop,
    onProbeToggle: noop,
    onAnnotateToggle: noop,
    onAnalyseToggle: noop,
    onHelp: noop,
    onCommandPalette: noop,
    onClose: noop,
  });
}

/** The visible dock buttons in render order. */
function buttons(dock: ToolDock): FakeEl[] {
  return (dock.dock as unknown as FakeEl).children;
}

describe('ToolDock manifest', () => {
  it('renders all 12 buttons in the exact contract order', () => {
    const b = buttons(makeDock());
    expect(b.map((x) => x.querySelector('.olv-tool-label')?.textContent ?? x.textContent)).toEqual([
      'Frame',
      'Snapshot',
      'Measure',
      'Inspect',
      'Probe',
      'Annotate',
      'Analyse',
      'Copy view link',
      'Commands',
      'Help',
      '•••',
      'Close',
    ]);
  });

  it('sets the initial disabled state per the contract table', () => {
    const b = buttons(makeDock());
    // Frame, Snapshot, Copy-link, Commands, Help, More are always enabled.
    // Measure, Inspect, Probe, Annotate, Analyse, Close start disabled.
    expect(b.map((x) => x.disabled)).toEqual([
      false, // Frame
      false, // Snapshot
      true, // Measure
      true, // Inspect
      true, // Probe
      true, // Annotate
      true, // Analyse
      false, // Copy view link
      false, // Commands
      false, // Help
      false, // More
      true, // Close
    ]);
  });

  it('carries every per-tool CSS class the mobile stylesheets key off', () => {
    const b = buttons(makeDock());
    expect(b[0].classList.contains('olv-tool-frame')).toBe(true);
    expect(b[1].classList.contains('olv-tool-snapshot')).toBe(true);
    expect(b[2].classList.contains('olv-dock-measure')).toBe(true);
    expect(b[4].classList.contains('olv-tool-probe')).toBe(true);
    expect(b[6].classList.contains('olv-tool-analyse')).toBe(true);
    expect(b[7].classList.contains('olv-tool-share')).toBe(true);
    expect(b[8].classList.contains('olv-tool-command')).toBe(true);
    expect(b[9].classList.contains('olv-tool-help')).toBe(true);
    expect(b[10].classList.contains('olv-tool-more')).toBe(true);
    expect(b[11].classList.contains('olv-tool-close')).toBe(true);
  });

  it('opens the two cluster gaps on Copy-link and Close', () => {
    const b = buttons(makeDock());
    expect(b[7].classList.contains('olv-dock-gap')).toBe(true); // Copy view link
    expect(b[11].classList.contains('olv-dock-gap')).toBe(true); // Close
    // No other button carries a gap.
    const gapped = b.filter((x) => x.classList.contains('olv-dock-gap')).length;
    expect(gapped).toBe(2);
  });

  it('announces the dock as one named toolbar group', () => {
    const dock = makeDock().dock as unknown as FakeEl;
    expect(dock.getAttribute('role')).toBe('toolbar');
    expect(dock.getAttribute('aria-label')).toBe('Tools');
  });

  it('gives the five toggles aria-pressed="false" at creation', () => {
    const b = buttons(makeDock());
    for (const i of [2, 3, 4, 5, 6]) {
      expect(b[i].getAttribute('aria-pressed')).toBe('false');
    }
    // Non-toggles (incl. Close) never get aria-pressed.
    for (const i of [0, 1, 7, 8, 9, 10, 11]) {
      expect(b[i].hasAttribute('aria-pressed')).toBe(false);
    }
  });

  it('setEnabled flips disabled and swaps in the enabled tooltip', () => {
    const dock = makeDock();
    const measure = buttons(dock)[2];
    expect(measure.disabled).toBe(true);
    expect(measure.title).toBe('Load a scan to enable measurement');
    dock.setEnabled('tool.measure', true);
    expect(measure.disabled).toBe(false);
    expect(measure.title).toBe(
      'Measure distance, area, height, angle and slope on the scan — also the M key',
    );
  });

  it('setEnabled(false) clears the active state', () => {
    const dock = makeDock();
    const measure = buttons(dock)[2];
    dock.setEnabled('tool.measure', true);
    dock.setActive('tool.measure', true);
    expect(measure.classList.contains('olv-tool-active')).toBe(true);
    dock.setEnabled('tool.measure', false);
    expect(measure.classList.contains('olv-tool-active')).toBe(false);
    expect(measure.getAttribute('aria-pressed')).toBe('false');
  });

  it('setActive toggles the class and aria-pressed together', () => {
    const dock = makeDock();
    const inspect = buttons(dock)[3];
    dock.setActive('tool.inspect', true);
    expect(inspect.classList.contains('olv-tool-active')).toBe(true);
    expect(inspect.getAttribute('aria-pressed')).toBe('true');
    dock.setActive('tool.inspect', false);
    expect(inspect.classList.contains('olv-tool-active')).toBe(false);
    expect(inspect.getAttribute('aria-pressed')).toBe('false');
  });

  it('Close has an enable but no active variant', () => {
    const dock = makeDock();
    const close = buttons(dock)[11];
    dock.setEnabled('tool.close', true);
    expect(close.disabled).toBe(false);
    expect(close.title).toBe('Close the scan and return to the start');
    // setActive is a silent no-op for Close.
    dock.setActive('tool.close', true);
    expect(close.classList.contains('olv-tool-active')).toBe(false);
    expect(close.hasAttribute('aria-pressed')).toBe(false);
  });

  it('keeps the old name-stable shims working identically', () => {
    const dock = makeDock();
    const b = buttons(dock);
    const [measure, inspect, probe, annotate, analyse] = [b[2], b[3], b[4], b[5], b[6]];
    const close = b[11];

    dock.setMeasureEnabled(true);
    expect(measure.disabled).toBe(false);
    dock.setMeasureActive(true);
    expect(measure.getAttribute('aria-pressed')).toBe('true');

    dock.setInspectEnabled(true);
    expect(inspect.title).toBe(
      'Click any point to read its coordinates and attributes — also the I key',
    );
    dock.setInspectActive(true);
    expect(inspect.classList.contains('olv-tool-active')).toBe(true);

    dock.setProbeEnabled(true);
    expect(probe.title).toBe('Hover the scan to read each point live, with no click');
    dock.setProbeActive(true);
    expect(probe.getAttribute('aria-pressed')).toBe('true');

    dock.setAnnotateEnabled(true);
    expect(annotate.title).toBe(
      'Mark points of interest with notes and findings — also the A key',
    );
    dock.setAnnotateActive(true);
    expect(annotate.classList.contains('olv-tool-active')).toBe(true);

    dock.setAnalyseEnabled(true);
    expect(analyse.title).toBe('Show or hide the terrain analysis panel');
    dock.setAnalyseActive(true);
    expect(analyse.getAttribute('aria-pressed')).toBe('true');

    dock.setCloseEnabled(true);
    expect(close.disabled).toBe(false);
    expect(close.title).toBe('Close the scan and return to the start');
  });
});

/**
 * The laptop tier. Eleven permanent buttons fit a full desktop and a phone
 * (which files five of them under More), but between the two the dock ran the
 * width of the canvas. A middle tier folds Snapshot, Copy view link and Probe,
 * each reachable another way, and keeps Analyse and Help out, where a user
 * mid-task and a user stuck respectively look first.
 *
 * The disclosure is one button with one handler for both tiers, so the test
 * that matters most here is that the handler is width-blind: a phone-only gate
 * in it would leave the laptop button rendered and inert.
 */
describe('the More disclosure across viewport tiers', () => {
  const dockCss = (): string => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(new URL('../src/styles/45-dock-and-panels.css', import.meta.url), 'utf8');
  };
  /** The body of the laptop-tier media block. */
  const laptopTier = (): string => {
    const css = dockCss();
    const at = css.indexOf('@media (max-width: 1100px) and (min-width: 768px)');
    expect(at, 'the laptop tier media block is missing').toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };

  it('toggles the dock class on click at any width', () => {
    const dock = makeDock();
    const more = buttons(dock).find((b) => b.classList.contains('olv-tool-more'))!;
    // The stub window reports a 1280px desktop; the handler must not care.
    more.dispatchEvent({ type: 'click' });
    expect(dock.dock.classList.contains('olv-dock-more-open')).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    more.dispatchEvent({ type: 'click' });
    expect(dock.dock.classList.contains('olv-dock-more-open')).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the button and folds three tools on the laptop tier', () => {
    const tier = laptopTier();
    expect(tier).toMatch(/\.olv-dock \.olv-tool-more \{[^}]*display: inline-flex/);
    for (const tool of ['olv-tool-snapshot', 'olv-tool-share', 'olv-tool-probe']) {
      expect(tier, `${tool} does not fold on the laptop tier`).toContain(`.olv-dock .${tool}`);
      expect(tier).toContain(`.olv-dock.olv-dock-more-open .${tool}`);
    }
  });

  it('keeps Analyse and Help permanent on the laptop tier', () => {
    const tier = laptopTier();
    expect(tier).not.toContain('olv-tool-analyse');
    expect(tier).not.toContain('olv-tool-help');
  });

  it('leaves the full-desktop dock alone', () => {
    // Nothing outside the two media blocks hides a tool, so above 1100px every
    // button is present, which is what the e2e specs click.
    const css = dockCss();
    const base = css.slice(0, css.indexOf('@media (max-width: 1100px)'));
    expect(base).toMatch(/\.olv-tool-more \{ display: none; \}/);
    expect(base).not.toContain('olv-tool-snapshot');
    expect(base).not.toContain('olv-tool-probe');
  });
});
