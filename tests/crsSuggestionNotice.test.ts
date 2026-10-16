/**
 * A remembered CRS that could not be verified for the open file is offered in
 * two places: an 8 s toast, and a notice in the Inspector's Coordinate system
 * section that stays while the suggestion is pending. Apply goes through the
 * coordinator's override path; Dismiss drops the suggestion. Either clears the
 * notice, as does closing the scan or opening a file with no suggestion.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Inspector } from '../src/ui/Inspector';
import { FakeEl, byClass, findContaining } from './support/measurePanelDom';
import { installInspectorFakeDom, fakeCallbacks } from './helpers/inspectorLazyHarness';
import { CrsService, datasetIdentity, type CrsOverridePort, type OverrideSuggestion } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { createCrsCoordinator, type CrsSuggestionActions } from '../src/app/crsCoordinator';
import type { Viewer } from '../src/render/Viewer';

vi.mock('../src/lazyChunks', () => ({
  loadLayerHealthCard: vi.fn(),
  loadLayerGroupsPanel: vi.fn(),
  loadRenderProvenance: vi.fn(),
  loadRenderReport: vi.fn(),
  loadRenderCrs: vi.fn(() => new Promise(() => {})),
}));

beforeAll(() => {
  installInspectorFakeDom();
});

function memoryPort(): CrsOverridePort & { entries: Map<string, CrsOverride> } {
  const entries = new Map<string, CrsOverride>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: Date.now() }); },
    clear: (key) => { entries.delete(key); },
  };
}

const SUGGESTION: OverrideSuggestion = { datasetKey: 'points.las', epsg: 32612, kind: 'projected', reason: 'legacy' };

function notice(inspector: Inspector): FakeEl {
  const root = (inspector as unknown as { element: FakeEl }).element;
  const n = byClass(root, 'olv-crs-suggestion');
  if (!n) throw new Error('no CRS suggestion notice');
  return n;
}

function button(root: FakeEl, label: string): FakeEl {
  const found = root.querySelectorAll('button').find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('Inspector CRS suggestion notice', () => {
  it('is hidden until a suggestion is set, and announces politely', () => {
    const inspector = new Inspector(fakeCallbacks());
    const n = notice(inspector);
    expect(n.classList.contains('olv-hidden')).toBe(true);
    expect(n.getAttribute('aria-live')).toBe('polite');
    // Lives in the Coordinate system section, outside the body renderCrs replaces.
    const crsBody = byClass((inspector as unknown as { element: FakeEl }).element, 'olv-crs')!;
    expect(crsBody.contains(n)).toBe(false);
  });

  it('shows the remembered EPSG with Apply and Dismiss buttons', () => {
    const inspector = new Inspector(fakeCallbacks());
    const apply = vi.fn();
    const dismiss = vi.fn();
    inspector.setCrsSuggestion(SUGGESTION, { apply, dismiss });
    const n = notice(inspector);
    expect(n.classList.contains('olv-hidden')).toBe(false);
    expect(findContaining(n, 'A CRS (EPSG:32612) was remembered for a file with this name.')).toBeTruthy();
    button(n, 'Apply').click();
    expect(apply).toHaveBeenCalledTimes(1);
    button(n, 'Dismiss').click();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(n.classList.contains('olv-hidden')).toBe(true);
  });

  it('names local coordinates when the remembered choice has no EPSG', () => {
    const inspector = new Inspector(fakeCallbacks());
    inspector.setCrsSuggestion({ ...SUGGESTION, epsg: null }, { apply: vi.fn(), dismiss: vi.fn() });
    expect(findContaining(notice(inspector), 'A CRS (Local coordinates) was remembered')).toBeTruthy();
  });

  it('hides when the suggestion is cleared', () => {
    const inspector = new Inspector(fakeCallbacks());
    inspector.setCrsSuggestion(SUGGESTION, { apply: vi.fn(), dismiss: vi.fn() });
    inspector.setCrsSuggestion(null);
    expect(notice(inspector).classList.contains('olv-hidden')).toBe(true);
  });
});

describe('crsCoordinator publishes the suggestion to the persistent surface', () => {
  function setup() {
    const port = memoryPort();
    port.entries.set('points.las', { epsg: 32612, kind: 'projected', updatedAt: 1 });
    const service = new CrsService(port);
    const origin: [number, number, number] = [500_000, 4_000_000, 50];
    const cloud = { name: 'points.las', pointCount: 1_000_000, sourceOrigin: origin, origin, bounds: () => ({ min: [0, 0, 0], max: [500, 500, 50] }) };
    const viewer = { streamingCloud: undefined, getCloud: vi.fn(() => cloud), setInspectCoordinateContext: vi.fn() };
    const showSuggestion = vi.fn<(s: OverrideSuggestion | null, actions: CrsSuggestionActions) => void>();
    const coordinator = createCrsCoordinator({
      crsService: service,
      getViewer: () => viewer as unknown as Viewer,
      isViewerReady: () => true,
      getActiveId: () => 'a',
      debug: false,
      notify: vi.fn(),
      showSuggestion,
    });
    return { port, service, cloud, coordinator, showSuggestion };
  }

  it('shows the pending suggestion after a resolve', () => {
    const { cloud, coordinator, showSuggestion } = setup();
    coordinator.refreshCrsForStaticCloud(cloud);
    expect(showSuggestion).toHaveBeenLastCalledWith(expect.objectContaining({ epsg: 32612 }), expect.anything());
  });

  it('Apply goes through the override path and clears the notice', () => {
    const { port, service, cloud, coordinator, showSuggestion } = setup();
    coordinator.refreshCrsForStaticCloud(cloud);
    const actions = showSuggestion.mock.lastCall![1];
    actions.apply();
    expect(service.current()?.epsg).toBe(32612);
    expect(service.current()?.userConfirmed).toBe(true);
    expect(port.entries.get('points.las')?.identity).toEqual(datasetIdentity(cloud));
    expect(showSuggestion.mock.lastCall![0]).toBeNull();
  });

  it('Dismiss drops the suggestion without applying it', () => {
    const { service, cloud, coordinator, showSuggestion } = setup();
    coordinator.refreshCrsForStaticCloud(cloud);
    showSuggestion.mock.lastCall![1].dismiss();
    expect(service.overrideSuggestion()).toBeNull();
    expect(service.current()?.epsg).toBeUndefined();
    expect(showSuggestion.mock.lastCall![0]).toBeNull();
  });

  it('a stale Apply after another scan resolved does nothing', () => {
    const { service, cloud, coordinator, showSuggestion } = setup();
    coordinator.refreshCrsForStaticCloud(cloud);
    const stale = showSuggestion.mock.lastCall![1];
    coordinator.refreshCrsForStaticCloud({ ...cloud, name: 'other.las' });
    stale.apply();
    expect(service.current()?.epsg).toBeUndefined();
  });

  it('closing the scan clears the notice', () => {
    const { cloud, coordinator, showSuggestion } = setup();
    coordinator.refreshCrsForStaticCloud(cloud);
    coordinator.clearDatasetKey();
    expect(showSuggestion.mock.lastCall![0]).toBeNull();
  });
});
