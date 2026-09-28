/**
 * The location bar's crumbs are a pure function of the route and the registry
 * (spec CE-1, CE-LOC-02): the same inputs give the same crumbs, the inputs are
 * never changed, and nothing else is read.
 */
import { describe, expect, it } from 'vitest';
import {
  backTarget,
  locationCrumbs,
  locationText,
  WORKSPACES,
  type LocationRegistry,
} from '../src/app/workspace/locationModel';
import { workspaceModeLabel } from '../src/ui/workspace/DesktopWorkspace';

const registry: LocationRegistry = {
  modeLabel: workspaceModeLabel,
  pages: {
    data: { classes: { title: 'Classes' } },
    work: { measure: { title: 'Measure' }, annotate: { title: 'Annotate' }, clip: { title: 'Clip box' } },
    analyse: {
      terrain: { title: 'Terrain' },
      contours: { title: 'Contours', parent: 'terrain' },
      objects: { title: 'Objects & Space' },
      features: { title: 'Feature candidates' },
      range: { title: 'Range frames' },
    },
  },
  workspaces: WORKSPACES,
};

describe('locationCrumbs', () => {
  it('reads a mode home as one crumb', () => {
    const c = locationCrumbs({ mode: 'data', page: null }, registry);
    expect(c).toEqual([{ label: 'Data', path: 'Data', to: null }]);
  });

  it('puts a child page under its parent, and only the last crumb has no target', () => {
    const c = locationCrumbs({ mode: 'analyse', page: 'contours' }, registry);
    expect(c.map((x) => x.label)).toEqual(['Analyse', 'Terrain', 'Contours']);
    expect(c.map((x) => x.path)).toEqual(['Analyse', 'Analyse › Terrain', 'Analyse › Terrain › Contours']);
    expect(c[0].to).toEqual({ mode: 'analyse', page: null });
    expect(c[1].to).toEqual({ mode: 'analyse', page: 'terrain' });
    expect(c[2].to).toBeNull();
    expect(locationText(c)).toBe('Analyse › Terrain › Contours');
  });

  it('appends an open workspace only on its own page', () => {
    const on = locationCrumbs({ mode: 'analyse', page: 'contours' }, registry, 'contour-studio');
    expect(locationText(on)).toBe('Analyse › Terrain › Contours › Contour Studio');
    const elsewhere = locationCrumbs({ mode: 'work', page: 'measure' }, registry, 'contour-studio');
    expect(locationText(elsewhere)).toBe('Tools › Measure');
    const unknown = locationCrumbs({ mode: 'work', page: 'measure' }, registry, 'no-such-workspace');
    expect(locationText(unknown)).toBe('Tools › Measure');
  });

  it('ignores a page the registry does not know', () => {
    expect(locationText(locationCrumbs({ mode: 'work', page: 'nope' }, registry))).toBe('Tools');
  });

  it('is pure: same inputs, same output, inputs untouched', () => {
    const snapshot = JSON.stringify(registry.pages);
    const route = Object.freeze({ mode: 'analyse' as const, page: 'contours' });
    const a = locationCrumbs(route, registry, 'contour-studio');
    const b = locationCrumbs(route, registry, 'contour-studio');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(JSON.stringify(registry.pages)).toBe(snapshot);
  });

  it('covers every registered page and workspace', () => {
    for (const [mode, list] of Object.entries(registry.pages)) {
      for (const id of Object.keys(list ?? {})) {
        const c = locationCrumbs({ mode: mode as 'data', page: id }, registry);
        expect(c[c.length - 1].label).toBe(list?.[id].title);
      }
    }
    for (const [id, ws] of Object.entries(WORKSPACES)) {
      const c = locationCrumbs({ mode: ws.mode, page: ws.page }, registry, id);
      expect(c[c.length - 1].label).toBe(ws.name);
    }
  });
});

describe('backTarget', () => {
  it('is empty at a mode home', () => {
    expect(backTarget({ mode: 'work', page: null }, registry)).toBeNull();
  });

  it('names the parent it returns to', () => {
    expect(backTarget({ mode: 'analyse', page: 'contours' }, registry)).toEqual({
      kind: 'route',
      to: { mode: 'analyse', page: 'terrain' },
      label: '← Terrain',
      name: 'Back to Terrain',
    });
    expect(backTarget({ mode: 'work', page: 'measure' }, registry)?.name).toBe('Back to Tools');
  });

  it('closes an open workspace by name', () => {
    expect(backTarget({ mode: 'analyse', page: 'contours' }, registry, 'contour-studio')).toEqual({
      kind: 'workspace',
      id: 'contour-studio',
      label: 'Close Contour Studio',
      name: 'Close Contour Studio',
    });
  });
});
