/**
 * inspectCopyAnnounce.test.ts
 *
 * CRITIC-GAP-2: the Inspect tool's "Copy" button confirmed a successful
 * clipboard write with a purely visual fade-in note (no role/aria-live) and a
 * button label that never changed from "Copy" — so a screen-reader user had
 * no way to know whether the copy succeeded, silently failed, or did
 * anything at all.
 *
 * The fix announces both outcomes through the app's shared polite live
 * region (politeAnnounce.ts) and reflects success in the button's own text.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as THREE from 'three/webgpu';
import { InspectTool } from '../src/render/InspectTool';
import { makePointInfo } from '../src/render/pointInfo';
import { FakeEl, installFakeDom } from './support/measurePanelDom';
import { withLiveRegion } from './helpers/politeLiveRegion';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as Record<string, unknown>;
  (g.document as Record<string, unknown>).createElementNS = (_ns: string, tag: string): FakeEl =>
    new FakeEl(tag);
  // `_copy()`'s confirmation-hide timer runs on `window`.
  g.window = { setTimeout, clearTimeout };
});

/** Node defines a read-only global `navigator`; only `defineProperty` can replace it. */
function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
}

afterEach(() => {
  setNavigator(undefined);
  const g = globalThis as unknown as { document: Record<string, unknown> };
  delete g.document.querySelector;
  delete g.document.body;
});

function makeToolWithSelection(): InstanceType<typeof InspectTool> {
  const camera = {} as unknown as THREE.PerspectiveCamera;
  const canvas = new FakeEl('canvas') as unknown as HTMLCanvasElement;
  const tool = new InspectTool(camera, canvas, { onExit: vi.fn() });
  const info = makePointInfo({
    layer: 'survey.laz',
    index: 1,
    local: [1, 2, 3],
    origin: [0, 0, 0],
    distance: 0,
    geographicHorizontal: false,
    intensity: null,
    classification: null,
    rgb: null,
  });
  (tool as unknown as { _selected: unknown })._selected = {
    info,
    world: new THREE.Vector3(1, 2, 3),
  };
  return tool;
}

/** Invoke the private copy handler the "Copy" button's click wires to. */
async function pressCopy(tool: InstanceType<typeof InspectTool>): Promise<void> {
  await (tool as unknown as { _copy: () => Promise<void> })._copy();
}

describe('InspectTool — copy confirmation announcement', () => {
  it('announces success and reflects it in the button text when the clipboard write succeeds', async () => {
    const { textOf } = withLiveRegion();
    setNavigator({ clipboard: { writeText: async () => undefined } });
    const tool = makeToolWithSelection();

    await pressCopy(tool);

    expect(textOf()).toBe('Point info copied');
    const btn = tool.card.querySelector('.olv-inspect-copy') as unknown as FakeEl | null;
    expect(btn?.textContent).toBe('Copied');
    const note = tool.card.querySelector('.olv-inspect-copied') as unknown as FakeEl | null;
    expect(note?.classList.contains('olv-hidden')).toBe(false);
    expect(note?.textContent).toBe('Point info copied');
  });

  it('announces failure and leaves the button reading "Copy" when the clipboard write fails', async () => {
    const { textOf } = withLiveRegion();
    // No navigator/clipboard and no document.body in this DOM stub, so both
    // the Clipboard API and the execCommand fallback fail — the natural
    // failure path, not a forced mock.
    const tool = makeToolWithSelection();

    await pressCopy(tool);

    expect(textOf()).toBe('Copy failed — try again');
    const btn = tool.card.querySelector('.olv-inspect-copy') as unknown as FakeEl | null;
    expect(btn?.textContent).toBe('Copy');
    const note = tool.card.querySelector('.olv-inspect-copied') as unknown as FakeEl | null;
    expect(note?.classList.contains('olv-hidden')).toBe(false);
    expect(note?.textContent).toBe('Copy failed — try again');
  });

  it('does not throw where the DOM stub has no queryable document', async () => {
    // document.querySelector is absent here, matching every other
    // InspectTool unit test's stub.
    const tool = makeToolWithSelection();
    await expect(pressCopy(tool)).resolves.not.toThrow();
  });
});
