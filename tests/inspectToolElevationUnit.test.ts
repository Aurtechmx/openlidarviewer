/**
 * Inspector elevation-row unit honesty.
 *
 * The Geographic and UTM groups printed their Elevation value with a hardcoded
 * " m" suffix, while the value itself is the source Z carried through
 * unconverted — so a scan whose vertical unit is feet (metre horizontal, foot
 * height) showed the World Z row in feet and these Elevation rows in metres on
 * the same card. The suffix must be the CRS-aware `worldCoordLabels(crs).zUnit`,
 * the same one the World / Local Z rows already use.
 *
 * A recording DOM stub rather than jsdom (which this repo does not install),
 * matching the panel suites — what matters is the string the row renders.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { InspectTool } from '../src/render/InspectTool';
import { makePointInfo, worldCoordLabels } from '../src/render/pointInfo';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ ns: true });
});

/** Geographic horizontal frame with a DECLARED foot height. */
const geoFootHeight: ResolvedCrs = {
  kind: 'geographic',
  name: 'WGS 84 + foot height',
  epsg: 4326,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  verticalUnitToMetres: 0.3048, // international foot
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

function elevationRowValues(card: FakeEl): string[] {
  const out: string[] = [];
  for (const row of card.querySelectorAll('.olv-inspect-row')) {
    const label = row.querySelector('.olv-inspect-row-label')?.textContent ?? '';
    const value = row.querySelector('.olv-inspect-row-value')?.textContent ?? '';
    if (label === 'Elevation') out.push(value);
  }
  return out;
}

describe('InspectTool elevation-row unit', () => {
  it('renders the Elevation suffix from worldLabels.zUnit, never a hardcoded metre', () => {
    const camera = {} as unknown as THREE.PerspectiveCamera;
    const canvas = new FakeEl('canvas') as unknown as HTMLCanvasElement;
    const tool = new InspectTool(camera, canvas, { onExit: vi.fn() });

    // A geographic pick: world X = lon, Y = lat (inside the UTM latitude band),
    // Z = a foot height. No origin shift, so world == the local values.
    const info = makePointInfo({
      layer: 'survey.laz',
      index: 3,
      local: [-100, 40, 123.456],
      origin: [0, 0, 0],
      distance: 0,
      geographicHorizontal: true,
      intensity: null,
      classification: null,
      rgb: null,
    });
    (tool as unknown as { _selected: unknown })._selected = {
      info,
      world: new THREE.Vector3(-100, 40, 123.456),
    };

    // Triggers a card repaint with the new context.
    tool.setCoordinateContext({ crs: geoFootHeight });

    const zUnit = worldCoordLabels(geoFootHeight).zUnit;
    expect(zUnit).toBe(' ft');

    const elevValues = elevationRowValues(tool.card as unknown as FakeEl);
    // The UTM group's Elevation row exists and carries the CRS-aware unit.
    expect(elevValues.length).toBeGreaterThan(0);
    for (const v of elevValues) {
      expect(v.endsWith(zUnit)).toBe(true);
      expect(v.endsWith(' m')).toBe(false);
    }
  });
});
