/**
 * busyScanEmblem.test.ts: the emblem form of the busy indicator and the
 * analysis waits that use it.
 *
 * The emblem is decorative (aria-hidden, no text): a sphere, a flare, two
 * dotted rings turning opposite ways and a mirrored, tapering axis of dots.
 * Analysis runs (the Analyse status line and readiness skeleton, Observatory)
 * wait on it; file loads, streaming and exports keep the progress trail.
 * Under reduced motion the stylesheet shows the emblem at rest.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CSS = read('../src/styles/57-busy-scan.css');
const EMBLEM_CSS = CSS.slice(CSS.indexOf('/* Emblem form'));

describe('emblem form', () => {
  it('is an aria-hidden SVG of the emblem, with no text and no trail', async () => {
    const { createBusyScan, BUSY_EMBLEM_CLASS } = await import('../src/ui/busyScan');
    const node = createBusyScan({ variant: 'emblem' }) as unknown as FakeEl;
    expect(node.tagName).toBe('svg');
    expect(node.getAttribute('class')).toBe(`olv-busy-scan ${BUSY_EMBLEM_CLASS}`);
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.getAttribute('focusable')).toBe('false');
    expect(node.getAttribute('viewBox')).toBe('0 0 40 20');
    expect(node.textContent).toBe('');
    expect(node.findByClass('olv-bs-seg')).toHaveLength(0);
    expect(node.findByClass('olv-bse-core')).toHaveLength(1);
    expect(node.findByClass('olv-bse-streak')).toHaveLength(1);
    expect(node.findByClass('olv-bse-halo')).toHaveLength(1);
    const rings = node.findByClass('olv-bse-ring');
    expect(rings).toHaveLength(2);
    for (const r of rings) expect(r.children).toHaveLength(26);
  });

  it('mirrors the axis about the centre and tapers it outward', async () => {
    const { createBusyScan } = await import('../src/ui/busyScan');
    const axis = (createBusyScan({ variant: 'emblem' }) as unknown as FakeEl).findByClass('olv-bse-axis')[0];
    expect(axis.children).toHaveLength(8);
    const r = (i: number) => Number(axis.children[i].getAttribute('r'));
    for (let i = 0; i < 8; i += 2) {
      const up = axis.children[i];
      const down = axis.children[i + 1];
      expect(up.getAttribute('cx')).toBe('20');
      expect(r(i)).toBe(r(i + 1));
      expect(10 - Number(up.getAttribute('cy'))).toBeCloseTo(Number(down.getAttribute('cy')) - 10, 5);
      if (i > 0) expect(r(i)).toBeLessThan(r(i - 2));
    }
  });

  it('keeps the trail by default', async () => {
    const { createBusyScan } = await import('../src/ui/busyScan');
    const node = createBusyScan() as unknown as FakeEl;
    expect(node.getAttribute('class')).toBe('olv-busy-scan');
    expect(node.findByClass('olv-bs-seg')).toHaveLength(6);
  });

  it('shows in front of the host text and goes when the text is reset', async () => {
    const { showBusyScan } = await import('../src/ui/busyScan');
    const host = new FakeEl('p');
    showBusyScan(host as unknown as HTMLElement, 'Running…', 'emblem');
    expect(host.findByClass('olv-busy-scan--emblem')).toHaveLength(1);
    expect(host.textContent).toBe('Running…');
    host.textContent = 'Done';
    expect(host.findByClass('olv-busy-scan')).toHaveLength(0);
  });
});

describe('Analyse panel waiting state', () => {
  async function freshPanel() {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const root = panel.element as unknown as FakeEl;
    const status = root.findByClass('olv-analyse-status')[0];
    const readiness = root.findByClass('olv-analyse-readiness')[0];
    return { panel, root, status, readiness };
  }

  it('waits on the emblem in the status line and the middle skeleton card', async () => {
    const { panel, status, readiness } = await freshPanel();
    panel.setBusy(true);
    expect(status.findByClass('olv-busy-scan--emblem')).toHaveLength(1);
    expect(status.findByClass('olv-bs-seg')).toHaveLength(0);
    expect(status.textContent).toBe('Analysing…');
    const cards = readiness.findByClass('is-skeleton');
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.findByClass('olv-busy-scan--emblem').length)).toEqual([0, 1, 0]);
  });

  it('removes every emblem when the run ends', async () => {
    const { panel, root } = await freshPanel();
    panel.setBusy(true);
    panel.setBusy(false);
    expect(root.findByClass('olv-busy-scan')).toHaveLength(0);
  });
});

describe('analysis runs use the emblem; loads, streaming and exports keep the trail', () => {
  const calls = (rel: string) => [...read(rel).matchAll(/showBusyScan\([^;]*\);/g)].map((m) => m[0]);

  it('Observatory, Flow Pulse and Terrain Access runs wait on the emblem', () => {
    expect(calls('../src/ui/observatory/observatoryPanel.ts')).toEqual(["showBusyScan(status, 'Running…', 'emblem');"]);
    expect(calls('../src/ui/fieldSimulation/flowPulseLab.ts')).toContain("showBusyScan(busyLine, 'Running Flow Pulse…', 'emblem');");
    expect(calls('../src/ui/fieldSimulation/terrainAccessLab.ts')).toContain("showBusyScan(busyLine, 'Finding a route…', 'emblem');");
  });

  it('exports keep the trail', () => {
    for (const rel of ['../src/ui/ExportPanel.ts', '../src/ui/fieldSimulation/flowPulseLab.ts', '../src/ui/fieldSimulation/terrainAccessLab.ts']) {
      for (const c of calls(rel).filter((x) => /Export|Building|Re-decoding/.test(x))) expect(c).not.toContain('emblem');
    }
  });
});

describe('emblem stylesheet', () => {
  it('holds the emblem at rest under reduced motion', () => {
    const block = EMBLEM_CSS.slice(EMBLEM_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.olv-bse-ring circle, \.olv-bse-axis circle, \.olv-bse-core \{ animation: none; \}/);
    expect(block).toMatch(/\.olv-bse-ring circle\.is-front \{ animation: none; opacity: 0\.95; \}/);
    expect(block).toMatch(/\.olv-bse-core \{ opacity: 1; \}/);
  });

  it('turns the two rings opposite ways', () => {
    const delay = (ring: number, i: number) =>
      Number(EMBLEM_CSS.match(new RegExp(`\\.olv-bse-ring-${ring} circle:nth-child\\(${i}\\) \\{ animation-delay: (-?[\\d.]+)s`))![1]);
    expect(delay(1, 3)).toBeGreaterThan(delay(1, 2));
    expect(delay(2, 3)).toBeLessThan(delay(2, 2));
  });

  it('animates opacity and transform only, on one 2.8 s loop', () => {
    const frames = EMBLEM_CSS.match(/@keyframes[^{]+\{([\s\S]*?\}\s*)\}/g) ?? [];
    expect(frames).toHaveLength(4);
    const props = new Set(frames.join('\n').match(/([a-z-]+)\s*:/g)?.map((p) => p.replace(/\s*:$/, '')) ?? []);
    expect([...props].sort()).toEqual(['opacity', 'transform']);
    for (const m of EMBLEM_CSS.matchAll(/animation: olv-bse-\w+ ([\d.]+)s/g)) expect(m[1]).toBe('2.8');
  });

  it('uses brand tokens only, with a forced-colours fallback', () => {
    expect(EMBLEM_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(EMBLEM_CSS).toMatch(/--olv-bse-dot: var\(--cyan\)/);
    expect(EMBLEM_CSS).toMatch(/--olv-bse-hi: var\(--ice\)/);
    expect(EMBLEM_CSS).toMatch(/@media \(forced-colors: active\) \{[\s\S]*CanvasText/);
  });

  it('shares the hidden-host pause with the trail', () => {
    expect(CSS).toMatch(/\[hidden\] \.olv-busy-scan \*,\s*\.olv-hidden \.olv-busy-scan \* \{\s*animation-play-state: paused;/);
  });
});
