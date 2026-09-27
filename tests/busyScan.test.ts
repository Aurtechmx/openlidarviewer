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
  it('is an aria-hidden SVG with a beam and ground returns, and no text', async () => {
    const { createBusyScan } = await import('../src/ui/busyScan');
    const node = createBusyScan() as unknown as FakeEl;
    expect(node.tagName).toBe('svg');
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.getAttribute('focusable')).toBe('false');
    expect(node.findByClass('olv-busy-scan-beam')).toHaveLength(1);
    expect(node.findByClass('olv-busy-scan-pt').length).toBeGreaterThan(5);
    expect(node.textContent).toBe('');
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
    expect(scans()).toHaveLength(1);
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
    expect(scans()).toHaveLength(1);
  });
});

describe('busy scan stylesheet', () => {
  it('shows the static profile under reduced motion', () => {
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.olv-busy-scan-beam\s*\{[^}]*animation:\s*none[^}]*opacity:\s*0/);
    expect(block).toMatch(/\.olv-busy-scan-pt\s*\{[^}]*animation:\s*none[^}]*opacity:\s*1/);
  });

  it('animates transform and opacity only', () => {
    const frames = CSS.match(/@keyframes[^{]+\{([\s\S]*?\}\s*)\}/g) ?? [];
    expect(frames.length).toBe(2);
    const props = new Set(
      frames.join('\n').match(/([a-z-]+)\s*:/g)?.map((p) => p.replace(/\s*:$/, '')) ?? [],
    );
    expect([...props].sort()).toEqual(['opacity', 'transform']);
  });

  it('uses token colours only', () => {
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('pauses when its host is hidden', () => {
    expect(CSS).toMatch(/\[hidden\] \.olv-busy-scan \*[\s\S]*animation-play-state:\s*paused/);
  });
});
