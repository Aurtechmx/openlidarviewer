/**
 * clipPageOnNewScan.test.ts
 *
 * The Tools tab remembers its open page across scans and reloads. A Clip page
 * left open from the last scan reopened with the next one, so a public COPC
 * opened straight onto Tools → Clip box with its box drawn. A scan opened with
 * no clip held now leaves the Clip page for the Tools home.
 */
import { describe, it, expect, vi } from 'vitest';
import { leaveClipPage } from '../src/app/clipMount';
import type { WorkspaceRoute } from '../src/app/workspace/workspaceRouter';

const routerAt = (route: WorkspaceRoute) => ({ route: () => route, navigate: vi.fn() });

describe('Clip page on a new scan', () => {
  it('goes back to the Tools home from a Clip page left open', () => {
    const r = routerAt({ mode: 'work', page: 'clip' });
    leaveClipPage(r);
    expect(r.navigate).toHaveBeenCalledWith({ mode: 'work', page: null });
  });

  it('leaves every other page alone', () => {
    for (const route of [{ mode: 'work', page: 'measure' }, { mode: 'work', page: null }, { mode: 'data', page: null }] as WorkspaceRoute[]) {
      const r = routerAt(route);
      leaveClipPage(r);
      expect(r.navigate).not.toHaveBeenCalled();
    }
  });

  it('does nothing without a workspace (bare mode)', () => {
    expect(() => leaveClipPage(null)).not.toThrow();
  });
});
