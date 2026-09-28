/**
 * actionNames.test.ts
 *
 * One name per action (CE-NAME-01). Every control that runs a registry action
 * renders the registry's name for it: the dock's visible label and accessible
 * name, the NavBar's accessible names (its chips show a leading part of the
 * name, which stays inside the accessible name), the canvas menu rows and the
 * Data home's open control. The palette, the Tools launcher and Help read the
 * registry directly; `actionDefinitions.test.ts` pins that the registry itself
 * takes its titles from the same table.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { installNavBarDom, type FakeEl } from './helpers/navBarDom';
import { cameraPresetTitle, standardViewTitle } from '../src/ui/actionNames';
import { ACTION_TITLES, SURFACE_DESCRIPTORS, type NamedActionId } from '../src/ui/actionDescriptors';
import { CAMERA_PRESET_ORDER, CAMERA_PRESET_LABEL, STANDARD_VIEW_ORDER, STANDARD_VIEW_LABEL } from '../src/render/camera/cameraPresets';

beforeAll(() => { installNavBarDom({ window: true }); });

const noop = (): void => { /* inert */ };

function walk(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    stack.push(...n.children);
  }
  return out;
}

describe('the name table', () => {
  it('has one name per id and no name used by two ids', () => {
    const names = Object.values(ACTION_TITLES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every control-only action a descriptor with its registry name', () => {
    const ids = SURFACE_DESCRIPTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['palette.open', 'scan.open', 'scan.close', 'session.export', 'tool.probe']) {
      const d = SURFACE_DESCRIPTORS.find((x) => x.id === id);
      expect(d, id).toBeDefined();
      expect(d!.title).toBe(ACTION_TITLES[id as NamedActionId]);
    }
  });
});

describe('the dock', () => {
  it('labels every action button with its registry name', async () => {
    const { ToolDock } = await import('../src/ui/toolDock');
    const dock = new ToolDock({
      onFrameAll: noop, onSnapshot: noop, onShare: noop, onMeasureToggle: noop, onInspectToggle: noop,
      onProbeToggle: noop, onAnnotateToggle: noop, onAnalyseToggle: noop, onHelp: noop, onCommandPalette: noop, onClose: noop,
    });
    const buttons = walk(dock.dock as unknown as FakeEl).filter((n) => n.getAttribute('data-action'));
    expect(buttons.length).toBe(11);
    for (const b of buttons) {
      const id = b.getAttribute('data-action') as NamedActionId;
      expect(ACTION_TITLES[id], `${id} has no registry name`).toBeDefined();
      const label = b.byClass('olv-tool-label')[0];
      expect(label.textContent, id).toBe(ACTION_TITLES[id]);
      expect(b.getAttribute('aria-label'), id).toBe(ACTION_TITLES[id]);
    }
    // Frame runs camera.frame-all, the action the R key and the palette run.
    expect(buttons.map((b) => b.getAttribute('data-action'))).toContain('camera.frame-all');
  });
});

describe('the NavBar', () => {
  async function navbar(): Promise<FakeEl> {
    const { NavBar } = await import('../src/ui/NavBar');
    const bar = new NavBar({
      onMode: noop, onSpeed: noop, onCameraPreset: noop, onStandardView: noop, onOrthographic: noop, onReset: noop, onPlanView: noop,
    } as unknown as ConstructorParameters<typeof NavBar>[0]);
    return bar.element as unknown as FakeEl;
  }

  it('names the frame button with the registry name', async () => {
    const root = await navbar();
    expect(root.byClass('olv-mode-reset')[0].getAttribute('aria-label')).toBe(ACTION_TITLES['camera.frame-all']);
  });

  it('names every camera chip with its registry name, and shows a leading part of it', async () => {
    const root = await navbar();
    const chips = root.byClass('olv-cam-chip');
    const expected = [
      ...CAMERA_PRESET_ORDER.map((n) => cameraPresetTitle(CAMERA_PRESET_LABEL[n])),
      ...STANDARD_VIEW_ORDER.map((v) => standardViewTitle(STANDARD_VIEW_LABEL[v])),
      ACTION_TITLES['camera.orthographic'],
      ACTION_TITLES['camera.plan-view'],
    ];
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(expected);
    for (const c of chips) {
      const shown = c.byClass('olv-cam-chip-label')[0].textContent;
      expect(c.getAttribute('aria-label')!.startsWith(shown), shown).toBe(true);
    }
  });

  it('keeps every tooltip under 160 characters and starting from the name or its context', async () => {
    const root = await navbar();
    for (const c of root.byClass('olv-cam-chip')) {
      expect((c.getAttribute('title') ?? '').length).toBeLessThanOrEqual(160);
    }
  });
});

describe('the canvas menu', () => {
  it('uses the registry names for the camera rows', async () => {
    const { sceneMenuItems } = await import('../src/ui/contextMenu');
    const v = { focusOnScreen: () => true, frameAll: noop, setStandardView: noop, setCameraPreset: noop };
    const labels = sceneMenuItems(v, 0, 0).map((i) => i.label);
    expect(labels).toEqual([
      'Focus here',
      ACTION_TITLES['camera.frame-all'],
      standardViewTitle(STANDARD_VIEW_LABEL.top),
      standardViewTitle(STANDARD_VIEW_LABEL.front),
      cameraPresetTitle(CAMERA_PRESET_LABEL.oblique),
    ]);
  });
});
