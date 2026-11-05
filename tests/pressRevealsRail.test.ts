/**
 * pressRevealsRail.test.ts
 *
 * A press that asks for a page or an Inspector section must land on screen. The
 * reveal is one-off: it never writes the stored collapse, and only explicit
 * opens call it, so automatic routing and a reload leave a hidden rail hidden.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import { revealLeftRail, revealSection, toolPageReveal } from '../src/app/workspace/railReveal';
import { createPreflightActionRunner } from '../src/app/preflightActions';

beforeAll(installLiveFakeDom);
const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8');
const rail = (collapsed: boolean) => ({ isCollapsed: () => collapsed, setCollapsed: vi.fn() });
const contains = (t: object) => ({ contains: (n: object) => n === t });

describe('revealLeftRail', () => {
  it('exits Focus first, then expands without persisting', () => {
    const order: string[] = [];
    const left = { isCollapsed: () => true, setCollapsed: vi.fn(() => { order.push('expand'); }) };
    revealLeftRail({ mobile: () => false, focus: () => ({ exit: () => order.push('exit') }), left });
    expect(order).toEqual(['exit', 'expand']);
    expect(left.setCollapsed).toHaveBeenCalledWith(false, { persist: false });
  });
  it('does nothing on a phone', () => {
    const left = rail(true);
    revealLeftRail({ mobile: () => true, focus: () => null, left });
    expect(left.setCollapsed).not.toHaveBeenCalled();
  });
});

describe('toolPageReveal', () => {
  it('reveals for a page the user asked to read and for Clip, whose controls are on the page', () => {
    expect(toolPageReveal('measure', { reveal: true }, true)).toBe('reveal');
    expect(toolPageReveal('clip', undefined, true)).toBe('reveal');
  });
  it('leaves a hidden rail alone for canvas-first tools and says where the page is', () => {
    expect(toolPageReveal('measure', undefined, true)).toBe('note');
    expect(toolPageReveal('annotate', undefined, true)).toBe('note');
  });
  it('has nothing to do with the rail open', () => {
    expect(toolPageReveal('measure', undefined, false)).toBe(null);
  });
});

describe('createWorkspaceRouter onReveal', () => {
  async function make() {
    const { DesktopWorkspace } = await import('../src/ui/workspace/DesktopWorkspace');
    const { createWorkspaceRouter } = await import('../src/app/workspace/workspaceRouter');
    const ws = new DesktopWorkspace({ storage: null as never, onModeChange: () => {} });
    const panel = new FakeEl('section');
    const onReveal = vi.fn();
    const router = createWorkspaceRouter(ws as never, { data: { classes: { title: 'Classes', element: () => panel as never } } }, null, undefined, onReveal);
    return { router, onReveal };
  }
  it('fires for a navigate that asks for focus', async () => {
    const { router, onReveal } = await make();
    router.navigate({ mode: 'data', page: 'classes' }, true);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
  it('stays quiet for automatic routing and a sync', async () => {
    const { router, onReveal } = await make();
    router.navigate({ mode: 'data', page: 'classes' });
    router.sync();
    expect(onReveal).not.toHaveBeenCalled();
  });
});

describe('revealSection', () => {
  function deps(over: Record<string, unknown> = {}) {
    const target = { closest: () => null };
    const base = {
      mobile: () => false, focus: () => null, left: rail(false), right: rail(true),
      rightRail: contains(target), modeHost: () => contains({}),
      route: () => ({ mode: 'analyse', page: null }), navigate: vi.fn(), selectTab: vi.fn(),
      ...over,
    };
    return { target, d: base as never as Parameters<typeof revealSection>[0], base };
  }
  it('opens a hidden right rail without persisting', () => {
    const { target, d, base } = deps();
    revealSection(d, target as never);
    expect(base.right.setCollapsed).toHaveBeenCalledWith(false, { persist: false });
  });
  it('goes to the mode that hosts a section, at its home, and opens the left rail', () => {
    const target = { closest: () => null };
    const left = rail(true);
    const { d, base } = deps({ left, rightRail: contains({}), modeHost: (m: string) => contains(m === 'data' ? target : {}) });
    revealSection(d, target as never);
    expect(base.navigate).toHaveBeenCalledWith({ mode: 'data', page: null });
    expect(left.setCollapsed).toHaveBeenCalledWith(false, { persist: false });
  });
  it('on a phone selects the sheet tab that holds the section and leaves the rails alone', () => {
    const target = { closest: () => ({ dataset: { tab: 'view' } }) };
    const right = rail(true);
    const { d, base } = deps({ mobile: () => true, right, rightRail: contains(target) });
    revealSection(d, target as never);
    expect(base.selectTab).toHaveBeenCalledWith('view');
    expect(right.setCollapsed).not.toHaveBeenCalled();
  });
});

describe('solo remedy', () => {
  it('is not offered with one visible layer', () => {
    const host = { soloActiveLayer: vi.fn(), soloAvailable: () => false };
    expect(createPreflightActionRunner(host).canRun('solo-active-layer', 'height' as never)).toBe(false);
  });
  it('is offered with more than one', () => {
    const host = { soloActiveLayer: vi.fn(), soloAvailable: () => true };
    expect(createPreflightActionRunner(host).canRun('solo-active-layer', 'height' as never)).toBe(true);
  });
});

describe('wiring', () => {
  const shell = read('src/app/workspace/workspaceShell.ts');
  it('no longer clicks the right rail tab, which wrote the stored preference', () => {
    expect(shell).not.toContain(".olv-right-rail-tab')?.click()");
  });
  it('registers the section reveal with the Inspector', () => {
    expect(shell).toContain('setRevealHost');
    expect(read('src/ui/Inspector.ts')).toContain('this._revealHost?.(target)');
  });
  it('dock Analyse and the analysis entries reveal the rail', () => {
    expect(read('src/main.ts')).toMatch(/showWorkspaceMode = [^\n]*revealRail\(\)/);
  });
});

describe('reference plane from B or the palette', () => {
  async function section(over: { elevation?: number | null; hasScan?: boolean } = {}) {
    vi.resetModules();
    vi.doMock('../src/lazyChunks', async (orig) => ({
      ...(await orig<object>()),
      loadWorkplane: async () => ({
        mountWorkplane: () => ({
          controller: {
            setEnabled: vi.fn(), reset: vi.fn(), reframe: vi.fn(),
            view: () => ({ settings: { enabled: true, orientation: 'horizontal' }, elevation: over.elevation === undefined ? null : over.elevation }),
          },
          dispose: vi.fn(),
        }),
      }),
    }));
    const { createReferencePlaneSection } = await import('../src/ui/referencePlaneSection');
    const toast = vi.fn();
    const reveal = vi.fn();
    const s = createReferencePlaneSection({ toast, reveal, hasScan: () => over.hasScan ?? true, crs: { subscribe: () => () => {} } } as never);
    return { s, toast, reveal };
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  it('with no elevation says the next step and reveals the section', async () => {
    const { s, toast, reveal } = await section();
    s.toggle();
    await settle();
    expect(toast).toHaveBeenCalledWith('Reference plane on. Set an elevation to place it.');
    expect(reveal).toHaveBeenCalledTimes(1);
  });
  it('with an elevation keeps the short message and no reveal', async () => {
    const { s, toast, reveal } = await section({ elevation: 12 });
    s.toggle();
    await settle();
    expect(toast).toHaveBeenCalledWith('Reference plane on.');
    expect(reveal).not.toHaveBeenCalled();
  });
  it('with no scan refuses and stays off', async () => {
    const { s, toast } = await section({ hasScan: false });
    s.toggle();
    await settle();
    expect(toast).toHaveBeenCalledWith('Open a scan first to use the reference plane.');
    expect(s.isEnabled()).toBe(false);
  });
});
