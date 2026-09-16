/**
 * desktopWorkspace.test.ts
 *
 * The desktop left-rail workspace shell: a four-way Data · Work · Analyse ·
 * Output tablist over four mode-host slots the host re-parents panels into.
 * Runs in the node environment through the same recording DOM stub the other
 * UI tests use, asserting on state, ARIA, node identity and persistence rather
 * than pixels.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(installLiveFakeDom);

/** A recording in-memory storage stub. */
class MemStore {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
}

async function make(opts: Record<string, unknown> = {}) {
  const { DesktopWorkspace } = await import('../src/ui/workspace/DesktopWorkspace');
  const ws = new DesktopWorkspace(opts);
  const root = ws.element as unknown as FakeEl;
  const tab = (id: string): FakeEl =>
    root.find((e) => e.attrs['role'] === 'tab' && e.dataset.mode === id)!;
  return { ws, root, tab };
}

describe('DesktopWorkspace', () => {
  it('preserves the .olv-left-panels#olv-left-panels host contract', async () => {
    const { root } = await make();
    expect(root.hasClass('olv-left-panels')).toBe(true);
    expect(root.id).toBe('olv-left-panels');
  });

  it('renders a three-tab tablist over three mode panels wired by aria-controls', async () => {
    const { root } = await make();
    const tabs = root.findAll((e) => e.attrs['role'] === 'tab');
    expect(tabs.map((t) => t.dataset.mode)).toEqual(['data', 'work', 'analyse', 'output']);
    const panels = root.findAll((e) => e.attrs['role'] === 'tabpanel');
    expect(panels.map((p) => p.dataset.mode)).toEqual(['data', 'work', 'analyse', 'output']);
    for (const t of tabs) {
      expect(t.attrs['aria-controls']).toBe(`olv-ws-mode-${t.dataset.mode}`);
    }
  });

  it('defaults to Data mode with roving tabindex and non-colour active state', async () => {
    const { ws, tab } = await make();
    expect(ws.getMode()).toBe('data');
    expect(tab('data').attrs['aria-selected']).toBe('true');
    expect(tab('analyse').attrs['aria-selected']).toBe('false');
    expect(tab('data').attrs['tabindex']).toBe('0');
    expect(tab('analyse').attrs['tabindex']).toBe('-1');
    expect(tab('data').hasClass('is-active')).toBe(true);
  });

  it('honours an explicit initial mode', async () => {
    const { ws } = await make({ initialMode: 'analyse' });
    expect(ws.getMode()).toBe('analyse');
  });

  it('mode(m) returns a stable, distinct host per mode', async () => {
    const { ws } = await make();
    expect(ws.mode('analyse')).toBe(ws.mode('analyse'));
    expect(ws.mode('analyse')).not.toBe(ws.mode('data'));
  });

  it('switching modes never recreates a host — a mounted node keeps its identity', async () => {
    const { ws } = await make();
    const panel = new FakeEl('div') as unknown as HTMLElement;
    ws.mountInMode('analyse', panel);
    const workHost = ws.mode('analyse');
    expect((workHost as unknown as FakeEl).children).toContain(panel as unknown as FakeEl);
    ws.setMode('data');
    ws.setMode('analyse');
    // Same host object, same child node — no recreation on a mode round-trip.
    expect(ws.mode('analyse')).toBe(workHost);
    expect((ws.mode('analyse') as unknown as FakeEl).children).toContain(panel as unknown as FakeEl);
  });

  it('mountInMode positions before an existing sibling when asked', async () => {
    const { ws } = await make();
    const a = new FakeEl('div') as unknown as HTMLElement;
    const b = new FakeEl('div') as unknown as HTMLElement;
    ws.mountInMode('data', a);
    ws.mountInMode('data', b, a); // b before a
    const kids = (ws.mode('data') as unknown as FakeEl).children;
    expect(kids.indexOf(b as unknown as FakeEl)).toBeLessThan(kids.indexOf(a as unknown as FakeEl));
  });

  it('fires onModeChange only on a real change and toggles the active host', async () => {
    const seen: string[] = [];
    const { ws } = await make({ onModeChange: (m: string) => seen.push(m) });
    ws.setMode('data'); // no-op — already active
    ws.setMode('output');
    ws.setMode('output'); // idempotent
    expect(seen).toEqual(['output']);
    expect((ws.mode('output') as unknown as FakeEl).hasClass('is-active')).toBe(true);
    expect((ws.mode('data') as unknown as FakeEl).hasClass('is-active')).toBe(false);
  });

  it('persists the active mode and restores it on a fresh instance', async () => {
    const storage = new MemStore();
    const { ws } = await make({ storage });
    ws.setMode('analyse');
    expect(storage.getItem('olv.workspace.left.mode')).toBe('analyse');
    const { ws: ws2 } = await make({ storage });
    expect(ws2.getMode()).toBe('analyse');
  });

  it('ignores a corrupt persisted value and falls back', async () => {
    const storage = new MemStore();
    storage.setItem('olv.workspace.left.mode', 'bogus');
    const { ws } = await make({ storage, initialMode: 'analyse' });
    expect(ws.getMode()).toBe('analyse');
  });

  it('ArrowRight moves the active mode and focuses the next tab', async () => {
    const { ws, tab } = await make();
    tab('data').fire('keydown', { key: 'ArrowRight', preventDefault: () => {} });
    expect(ws.getMode()).toBe('work');
    expect(tab('work').focused).toBe(true);
  });

  it('leads the work mode with the tools launcher, ahead of measure, annotation and clip', async () => {
    const { ws } = await make();
    const node = (): FakeEl => new FakeEl('section');
    const launcher = node(); const measure = node(); const annotation = node(); const clip = node();
    ws.layoutDesktop({
      dataLayers: node(), dataLayerHealth: node(), classLegend: node(), processStudio: node(), export: node(),
      toolLauncher: launcher, measure, annotation, clip,
    } as never);
    expect((ws.mode('work') as unknown as FakeEl).children).toEqual([launcher, measure, annotation, clip]);
  });

  it('exposes a callable dispose()', async () => {
    const { ws } = await make();
    expect(() => ws.dispose()).not.toThrow();
  });
});
