/**
 * analysePanelPrimaryMetrics.test.ts — the primary terrain metrics are visible
 * at rest. DTM quality, Scan scope and the worst-rated remaining chip must not
 * sit inside a closed disclosure.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { hillScene } from './helpers/hillSceneFixture';

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

describe('AnalysePanel primary metrics', () => {
  it('shows DTM quality, Scan scope and the worst chip outside any disclosure', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    panel.update(
      analyseContours(hillScene(), { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' }),
    );
    const root = panel.element as unknown as FakeEl;

    const primary = root.findByClass('is-primary').find((n) =>
      n.className.split(/\s+/).includes('olv-analyse-assess-metrics'));
    expect(primary).toBeDefined();

    const pills = primary!.findByClass('olv-analyse-assess-metric');
    expect(pills).toHaveLength(3);
    const labels = pills.map((p) => p.findByClass('olv-analyse-assess-metric-label')[0].textContent);
    expect(labels[0]).toBe('DTM quality');
    expect(labels[1]).toBe('Scan scope');

    // No ancestor is a disclosure.
    for (let n: FakeEl | null = primary!.parent; n; n = n.parent) {
      expect(n.tagName).not.toBe('details');
      expect(n.className).not.toContain('olv-analyse-assess-metricwrap');
    }

    // The full set stays reachable behind its own disclosure.
    expect(root.findByClass('olv-analyse-assess-metricwrap')).toHaveLength(1);
    expect(root.findByClass('olv-analyse-assess-metrics-all')).toHaveLength(1);
  });
});
