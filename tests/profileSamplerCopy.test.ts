/**
 * profileSamplerCopy.test.ts
 *
 * Pins what the profile sampler controls claim about the percentile estimator.
 *
 * WHAT THE SAMPLER ACTUALLY DOES (`src/render/measure/profileSampler.ts`):
 * it reduces each corridor bin to a percentile of the return elevations that
 * survived a class gate. The gate is active only when an index-aligned
 * classification channel exists, and it drops NON_GROUND_CLASSES
 * ([3, 4, 5, 6, 7, 18] in `src/terrain/ground/classificationFilter.ts`). Class
 * 0 created/never-classified, 1 unclassified, 2 ground, 9 water and 255 all
 * reach the percentile. 255 is the sentinel `assembleProfileBuffers` fills the
 * combined class array with, so in a mixed-layer scene one classified source
 * turns the gate on while every unclassified source keeps contributing
 * unfiltered. A classification present may also be the viewer's own derived
 * one rather than the producer's.
 *
 * The controls therefore name the percentile and the class gate, and do not
 * call p25 a bare-earth surface.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { installFakeDom, type FakeEl } from './support/measurePanelDom';

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';

beforeAll(installFakeDom);

function profileRow(): MeasurementSummary {
  const profileChart: ProfileChartSample[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    distance: i * 10,
    height: 100 + i,
    count: 12,
  }));
  return {
    id: 'p1',
    kind: 'profile',
    name: 'Section A',
    value: '50.00 m',
    profileChart,
    profileCorridorWidthM: 2.5,
    profileGroundPercentile: 25,
  };
}

/** Mount a panel with the resample callback wired so the controls are built. */
function mount(): FakeEl {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
    onProfileResample: () => {},
  });
  panel.update([profileRow()]);
  return panel.element as unknown as FakeEl;
}

/** Every string the controls put in front of a reader or a screen reader. */
function copyOf(root: FakeEl): string {
  const parts: string[] = [];
  const walk = (n: FakeEl): void => {
    parts.push(n.textContent, n.title, n.getAttribute('aria-label') ?? '');
    for (const c of n.children) walk(c);
  };
  walk(root);
  return parts.join('\n');
}

describe('profile sampler controls — the percentile is not called bare earth', () => {
  it('captions the chart with the percentile of the corridor', () => {
    const summary = mount().querySelector('summary.olv-mp-sampler-summary');
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain('p25 of corridor');
    expect(summary!.textContent).not.toContain('ground p25');
  });

  it('labels the input as an elevation percentile', () => {
    const copy = copyOf(mount());
    expect(copy).toContain('Elevation percentile');
    expect(copy).toContain('Elevation percentile (0–100)');
    expect(copy).not.toContain('Ground percentile');
  });

  it('states that the class gate needs a source classification', () => {
    const copy = copyOf(mount());
    expect(copy).toContain('Per-bin elevation percentile over the corridor returns');
    expect(copy).toContain('only where a source supplies a classification');
    expect(copy).toContain('unclassified returns');
  });

  it('never claims the percentile estimates bare earth', () => {
    const copy = copyOf(mount()).toLowerCase();
    expect(copy).not.toContain('bare earth');
    expect(copy).not.toContain('bare-earth');
    expect(copy).not.toContain('estimates bare');
  });
});
