/**
 * sceneToolEntryPoints.test.ts
 *
 * Measure, Annotate, Clip and Inspect are reachable from four places: the tool
 * dock, a single-key shortcut, the command palette and the Tools launcher.
 * They used to diverge (only the dock revealed the Tools tab). Every entry now
 * runs the one command, `runSceneTool`, that the registry action runs: flip
 * the tool, record it, and when it turned on, open its page in Tools.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSceneTool, type SceneTool, type SceneToolDeps } from '../src/app/toggleTool';
import { contributeToolActions } from '../src/app/actions/toolActions';
import { buildViewerKeyBindings, type KeyBindingDeps } from '../src/ui/keyBindings';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(installLiveFakeDom);

function fakeViewer() {
  const v = {
    measureMode: false, inspectMode: false, annotateMode: false,
    setMeasureMode: (on: boolean) => { v.measureMode = on; },
    setInspectMode: (on: boolean) => { v.inspectMode = on; },
    setAnnotateMode: (on: boolean) => { v.annotateMode = on; },
  };
  return v;
}

function deps() {
  const viewer = fakeViewer();
  let clipOn = false;
  const d = {
    viewer: () => viewer,
    workflow: { capture: vi.fn() },
    toggleClip: vi.fn(() => (clipOn = !clipOn)),
    openPage: vi.fn(),
  } satisfies SceneToolDeps;
  return { d, viewer };
}

describe('runSceneTool', () => {
  it.each(['measure', 'annotate'] as const)('%s turns on, records it and opens its Tools page', (tool) => {
    const { d, viewer } = deps();
    expect(runSceneTool(d, tool)).toBe(true);
    expect(viewer[`${tool}Mode`]).toBe(true);
    expect(d.workflow.capture).toHaveBeenCalledWith({ type: 'tool', tool, on: true });
    expect(d.openPage).toHaveBeenCalledWith(tool);
  });

  it('turning a tool off leaves the route where it is', () => {
    const { d } = deps();
    runSceneTool(d, 'measure');
    d.openPage.mockClear();
    expect(runSceneTool(d, 'measure')).toBe(false);
    expect(d.openPage).not.toHaveBeenCalled();
  });

  it('clip flips through the Clip panel write path and opens its page when on', () => {
    const { d } = deps();
    expect(runSceneTool(d, 'clip')).toBe(true);
    expect(d.toggleClip).toHaveBeenCalledTimes(1);
    expect(d.openPage).toHaveBeenCalledWith('clip');
    expect(d.workflow.capture).not.toHaveBeenCalled();
  });

  it('inspect has no panel, so it only toggles', () => {
    const { d, viewer } = deps();
    runSceneTool(d, 'inspect');
    expect(viewer.inspectMode).toBe(true);
    expect(d.openPage).not.toHaveBeenCalled();
  });
});

describe('every entry point converges on the one command', () => {
  const TOOLS: readonly SceneTool[] = ['measure', 'annotate', 'clip', 'inspect'];

  it('palette and launcher: the registry action body is runTool(tool)', () => {
    const runTool = vi.fn();
    const actions = contributeToolActions({
      getViewer: () => ({}) as never, workflowController: {} as never, lassoVolumeTool: {} as never,
      syncLassoButton: vi.fn(), runDeriveClassification: vi.fn(), runFillUnclassified: vi.fn(),
      showLassoToast: vi.fn(), runTool,
    });
    for (const tool of TOOLS) {
      runTool.mockClear();
      actions.find((a) => a.id === `tool.${tool}`)!.run();
      expect(runTool).toHaveBeenCalledExactlyOnceWith(tool);
    }
  });

  it('launcher: a row click runs the same registry action', async () => {
    const { createToolLauncher } = await import('../src/ui/toolLauncher');
    const run = vi.fn();
    const launcher = createToolLauncher({
      getActions: () => [{ id: 'tool.measure', title: 'Measure', section: 'Tools', run }],
      counts: () => ({ measurements: 0, annotations: 0 }),
      isToolPanelActive: () => false,
    });
    (launcher.element as unknown as FakeEl).find((e) => e.hasClass('olv-tl-row'))!.fire('click');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keyboard: the M / A / I bindings name the registry action and call the global handler', () => {
    const h = { onMeasure: vi.fn(), onAnnotate: vi.fn(), onInspect: vi.fn() };
    const table = buildViewerKeyBindings({ globalActions: () => h } as unknown as KeyBindingDeps);
    for (const [id, action, fn] of [
      ['tool-measure', 'tool.measure', h.onMeasure],
      ['tool-annotate', 'tool.annotate', h.onAnnotate],
      ['tool-inspect', 'tool.inspect', h.onInspect],
    ] as const) {
      const b = table.find((x) => x.id === id)!;
      expect(b.actionIds).toEqual([action]);
      b.run({} as never, {} as never);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('dock and keyboard handlers in main.ts call runTool, never a private toggle', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain("onMeasureToggle: () => { runTool('measure'); }");
    expect(main).toContain("onAnnotateToggle: () => { runTool('annotate'); }");
    expect(main).toContain("onInspectToggle: () => { runTool('inspect'); }");
    expect(main).toContain("onMeasure: () => { if (toolsReady()) runTool('measure'); }");
    expect(main).toContain("onAnnotate: () => { if (toolsReady()) runTool('annotate'); }");
    expect(main).toContain("onInspect: () => { if (toolsReady()) runTool('inspect'); }");
    // The registry gets the same function, and nothing else toggles a tool.
    expect(main).toMatch(/^\s+runTool,$/m);
    expect(main).not.toMatch(/\btoggleTool\(/);
    expect(main).toMatch(/function runTool\(tool: SceneTool\): void \{\s+runSceneTool\(/);
  });
});
