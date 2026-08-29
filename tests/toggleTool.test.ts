/**
 * toggleTool.test.ts — the toolbar, palette, and keyboard toggled interaction
 * tools by hand, and only the palette recorded the toggle to the workflow
 * recorder. toggleTool() centralises the flip and the capture so every path
 * records identically. These tests pin the flip, the returned state, and the
 * capture that the toolbar/keyboard paths used to miss.
 */

import { describe, it, expect, vi } from 'vitest';
import { toggleTool, type ToggleableTool, type ToolToggleViewer } from '../src/app/toggleTool';

function fakeViewer(over: Partial<Record<`${ToggleableTool}Mode`, boolean>> = {}) {
  const state = {
    measure: over.measureMode ?? false,
    inspect: over.inspectMode ?? false,
    annotate: over.annotateMode ?? false,
  };
  const v: ToolToggleViewer = {
    get measureMode() { return state.measure; },
    get inspectMode() { return state.inspect; },
    get annotateMode() { return state.annotate; },
    setMeasureMode(on) { state.measure = on; },
    setInspectMode(on) { state.inspect = on; },
    setAnnotateMode(on) { state.annotate = on; },
  };
  return { v, state };
}

describe('toggleTool', () => {
  for (const tool of ['measure', 'inspect', 'annotate'] as ToggleableTool[]) {
    it(`${tool}: flips off→on, sets the mode, and returns the new state`, () => {
      const { v, state } = fakeViewer();
      const capture = vi.fn();
      const next = toggleTool(v, { capture }, tool);
      expect(next).toBe(true);
      expect(state[tool]).toBe(true);
    });

    it(`${tool}: flips on→off from the current mode`, () => {
      const { v } = fakeViewer({ [`${tool}Mode`]: true } as never);
      const capture = vi.fn();
      expect(toggleTool(v, { capture }, tool)).toBe(false);
    });

    it(`${tool}: records the toggle every time (the bug the toolbar/keyboard had)`, () => {
      const { v } = fakeViewer();
      const capture = vi.fn();
      toggleTool(v, { capture }, tool);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith({ type: 'tool', tool, on: true });
      toggleTool(v, { capture }, tool);
      expect(capture).toHaveBeenLastCalledWith({ type: 'tool', tool, on: false });
    });
  }

  it('sets the mode before capturing, so a recorder reading the viewer sees the new state', () => {
    const { v, state } = fakeViewer();
    const order: string[] = [];
    const capture = vi.fn(() => { order.push(`capture:${state.measure}`); });
    const origSet = v.setMeasureMode.bind(v);
    v.setMeasureMode = (on: boolean) => { order.push(`set:${on}`); origSet(on); };
    toggleTool(v, { capture }, 'measure');
    expect(order).toEqual(['set:true', 'capture:true']);
  });
});
