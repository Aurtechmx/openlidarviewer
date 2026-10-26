// What these tests would catch:
//
//  - The lasso staying armed, with its crosshair overlay over the canvas,
//    through Close or a replacing open: the scene retire did not disarm it.
//  - A lasso toggle path that moved the tool without the button following,
//    so the measure dock showed the lasso off while the overlay ate clicks.
//  - A lasso result waiting on the toast's Save outliving the scan it was
//    measured on.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { armLasso, disarmLasso, type LassoArmingDeps } from '../src/ui/LassoVolumeTool';

function deps(enabled: boolean, withViewer = true) {
  const tool = { enabled, enable: vi.fn(() => { tool.enabled = true; }), disable: vi.fn(() => { tool.enabled = false; }) };
  const viewer = { setLassoMode: vi.fn(), clearSelectionHighlight: vi.fn() };
  const d: LassoArmingDeps = {
    tool,
    viewer: () => (withViewer ? viewer : null),
    syncButton: vi.fn(),
    clearPending: vi.fn(),
  };
  return { d, tool, viewer };
}

describe('arming the lasso', () => {
  it('enables the tool, tells the viewer and syncs the button', () => {
    const t = deps(false);
    armLasso(t.d);
    expect(t.tool.enable).toHaveBeenCalledTimes(1);
    expect(t.viewer.setLassoMode).toHaveBeenCalledWith(true);
    expect(t.d.syncButton).toHaveBeenCalledTimes(1);
    expect(t.d.clearPending).not.toHaveBeenCalled();
  });

  it('works before the viewer chunk resolved', () => {
    const t = deps(false, false);
    expect(() => armLasso(t.d)).not.toThrow();
    expect(t.tool.enable).toHaveBeenCalledTimes(1);
  });
});

describe('disarming the lasso', () => {
  it('reports whether the tool was armed, and always leaves the button in sync', () => {
    const armed = deps(true);
    expect(disarmLasso(armed.d)).toBe(true);
    expect(armed.tool.disable).toHaveBeenCalledTimes(1);
    expect(armed.viewer.setLassoMode).toHaveBeenCalledWith(false);
    expect(armed.viewer.clearSelectionHighlight).not.toHaveBeenCalled();
    expect(armed.d.syncButton).toHaveBeenCalledTimes(1);

    const idle = deps(false);
    expect(disarmLasso(idle.d)).toBe(false);
    expect(idle.d.syncButton).toHaveBeenCalledTimes(1);
  });

  it('clears the highlight and the waiting result when asked', () => {
    const t = deps(true);
    disarmLasso(t.d, { clearHighlight: true, clearPending: true });
    expect(t.viewer.clearSelectionHighlight).toHaveBeenCalledTimes(1);
    expect(t.d.clearPending).toHaveBeenCalledTimes(1);
  });

  it('drops a waiting result even when the tool was not armed', () => {
    // A result can wait on the toast's Save after the tool auto-disarmed.
    const t = deps(false);
    disarmLasso(t.d, { clearPending: true });
    expect(t.d.clearPending).toHaveBeenCalledTimes(1);
  });
});

describe('the shell', () => {
  const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');

  it('disarms the lasso and drops its waiting result when the scene is retired', () => {
    const start = main.indexOf('function retireSceneState(): void {');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\n}\n', start));
    expect(body).toMatch(/disarmLasso\(lassoArming, \{[^}]*clearPending: true[^}]*\}\)/);
  });

  it('arms and disarms only through the helpers, so every path syncs the button', () => {
    expect(main.match(/lassoVolumeTool\.(enable|disable)\(\)/g)).toBeNull();
  });
});
