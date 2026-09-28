/**
 * busyScan.test.ts: the shared busy indicator and its Analyse panel host.
 *
 * The indicator is decorative (aria-hidden), mounts when a run starts and is
 * gone once the run ends, whether it succeeded, failed or was cancelled. Under
 * reduced motion the stylesheet shows the finished profile with no sweep.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/57-busy-scan.css', import.meta.url)),
  'utf8',
);

async function freshPanel() {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const panel = new AnalysePanel({});
  const root = panel.element as unknown as FakeEl;
  const status = root.findByClass('olv-analyse-status')[0];
  const scans = () => root.findByClass('olv-busy-scan');
  return { panel, status, scans };
}

describe('busy scan indicator', () => {
  it('is an aria-hidden SVG: a trail, a centre and one point, no visible orbit, and no text', async () => {
    const { createBusyScan } = await import('../src/ui/busyScan');
    const node = createBusyScan() as unknown as FakeEl;
    expect(node.tagName).toBe('svg');
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.getAttribute('focusable')).toBe('false');
    expect(node.textContent).toBe('');
    expect(node.findByClass('olv-bs-orbit')).toHaveLength(0);
    const segs = node.findByClass('olv-bs-seg');
    expect(segs).toHaveLength(6);
    for (const seg of segs) expect(seg.getAttribute('pathLength')).toBe('100');
    expect(node.findByClass('olv-bs-core')).toHaveLength(1);
    expect(node.findByClass('olv-bs-point')).toHaveLength(1);
  });

  it('keeps the host text next to it and is removed when the text is reset', async () => {
    const { showBusyScan } = await import('../src/ui/busyScan');
    const host = new FakeEl('button');
    showBusyScan(host as unknown as HTMLElement, 'Exporting…');
    expect(host.findByClass('olv-busy-scan')).toHaveLength(1);
    expect(host.textContent).toBe('Exporting…');
    host.textContent = 'Export';
    expect(host.findByClass('olv-busy-scan')).toHaveLength(0);
  });
});

describe('Analyse panel run', () => {
  it('mounts the indicator when the run starts', async () => {
    const { panel, status, scans } = await freshPanel();
    expect(scans()).toHaveLength(0);
    panel.setBusy(true);
    // One in the status line, one in the readiness skeleton.
    expect(scans()).toHaveLength(2);
    expect(status.textContent).toBe('Analysing…');
  });

  it('removes it when the run succeeds and a result is shown', async () => {
    const { panel, scans } = await freshPanel();
    panel.setBusy(true);
    panel.setBusy(false);
    expect(scans()).toHaveLength(0);
  });

  it('removes it when the run fails and an error status replaces it', async () => {
    const { panel, scans } = await freshPanel();
    panel.setBusy(true);
    panel.setStatus('Analysis failed.');
    panel.setBusy(false);
    expect(scans()).toHaveLength(0);
  });

  it('removes it when the run is cancelled by clearing the scan', async () => {
    const { panel, scans } = await freshPanel();
    panel.setBusy(true);
    panel.update(null);
    expect(scans()).toHaveLength(0);
  });

  it('mounts only one indicator across repeated busy calls', async () => {
    const { panel, scans } = await freshPanel();
    panel.setBusy(true);
    panel.setBusy(true);
    expect(scans()).toHaveLength(2);
  });
});

describe('busy scan stylesheet', () => {
  const SINE_RE = String.raw`cubic-bezier\(0\.37, 0, 0\.63, 1\)`;

  it('holds everything still under reduced motion, with the point at the front', () => {
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.olv-busy-scan \{ transition: none; \}/);
    expect(block).toMatch(/\.olv-bs-point, \.olv-bs-seg \{ animation: none; \}/);
    expect(block).toMatch(/\.olv-bs-core \{ animation: none; opacity: 0\.85; \}/);
    expect(CSS).toMatch(/\.olv-bs-point\s*\{[^}]*offset-path: path\("M20 15A15 5 [^}]*offset-distance: 0%/);
  });

  it('runs the point and every trail dash on the same 2.4 s easing', () => {
    expect(CSS).toMatch(new RegExp(`\\.olv-bs-point \\{[^}]*animation: olv-bs-orbit 2\\.4s ${SINE_RE} infinite`));
    expect(CSS).toMatch(new RegExp(`\\.olv-bs-seg \\{[^}]*animation: olv-bs-trail 2\\.4s ${SINE_RE} infinite`));
    // Each dash moves one full path length per loop, as the point does.
    expect(CSS).toMatch(/100% \{ stroke-dashoffset: calc\(\(var\(--olv-bs-len\) \* var\(--olv-bs-k\) \/ 6 - 100\) \* 1px\); \}/);
  });

  it('lays the dashes end to end behind the point, fading toward the tail', () => {
    const seg = [0, 1, 2, 3, 4, 5].map((i) => CSS.match(new RegExp(`\\.olv-bs-seg-${i} \\{ --olv-bs-k: (\\d); opacity: ([\\d.]+)`))!);
    expect(seg.map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6]);
    const op = seg.map((m) => Number(m[2]));
    expect(op[0]).toBe(1);
    expect(op).toEqual([...op].sort((a, b) => b - a));
    expect(CSS).toMatch(/stroke-dasharray: calc\(var\(--olv-bs-len\) \/ 6 \* 1px\) calc\(\(100 - var\(--olv-bs-len\) \/ 6\) \* 1px\)/);
  });

  it('eases length changes and pulses the centre twice a loop', () => {
    expect(CSS).toMatch(/@property --olv-bs-len \{\s*syntax: '<number>';/);
    expect(CSS).toMatch(/transition: --olv-bs-len 300ms ease-out/);
    expect(CSS).toMatch(/\.olv-bs-core \{[^}]*animation: olv-bs-pulse 1\.2s ease-in-out infinite/);
    expect(CSS).toMatch(/0% \{ transform: scale\(0\.85\); opacity: 0\.55; \}\s*50% \{ transform: scale\(1\.15\); opacity: 0\.85; \}/);
  });

  it('settles: point paused, pulse at full size, trail faded', () => {
    expect(CSS).toMatch(/\.olv-busy-scan\.is-settled \.olv-bs-point,\s*\.olv-busy-scan\.is-settled \.olv-bs-seg \{ animation-play-state: paused; \}/);
    expect(CSS).toMatch(/\.olv-busy-scan\.is-settled \.olv-bs-trail \{ opacity: 0; \}/);
    expect(CSS).toMatch(/\.olv-busy-scan\.is-settled \.olv-bs-core \{ animation: none; opacity: 0\.85; \}/);
  });

  it('is monochrome apart from the point and its trail', () => {
    expect(CSS).toMatch(/\.olv-bs-core \{\s*fill: currentColor/);
    const trailCss = CSS.slice(0, CSS.indexOf('/* Emblem form'));
    const accentRules = trailCss.split('}').filter((r) => r.includes('var(--accent)'));
    expect(accentRules).toHaveLength(1);
    expect(accentRules[0]).toContain('--olv-bs-mark');
  });

  it('animates transform, opacity, motion-path distance and the trail dash offset only', () => {
    const frames = CSS.match(/@keyframes[^{]+\{([\s\S]*?\}\s*)\}/g) ?? [];
    expect(frames.length).toBe(7);
    const props = new Set(
      frames.join('\n').match(/([a-z-]+)\s*:/g)?.map((p) => p.replace(/\s*:$/, '')) ?? [],
    );
    expect([...props].sort()).toEqual(['offset-distance', 'opacity', 'stroke-dashoffset', 'transform']);
  });

  it('uses token colours only', () => {
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('pauses when its host is hidden', () => {
    expect(CSS).toMatch(/\[hidden\] \.olv-busy-scan \*[\s\S]*animation-play-state:\s*paused/);
  });
});
