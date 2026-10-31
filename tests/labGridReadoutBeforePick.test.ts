/**
 * labGridReadoutBeforePick.test.ts
 *
 * The Flow Pulse and Terrain Access map readouts describe the cell the user
 * picked or moved to. Before any pick they read "Column 0, row 0, no
 * elevation." for a cell nobody chose; they stay empty until one is chosen.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';

beforeAll(() => {
  installRecordingDom();
});

const flow = await import('../src/ui/fieldSimulation/flowResultGrid');
const access = await import('../src/ui/fieldSimulation/terrainAccessResultGrid');
const rec = (n: unknown): RecordingEl => n as RecordingEl;

/** The readout under the grid (the second child of the grid element). */
const readout = (g: { element: HTMLElement }): string => rec(g.element).children[1]!.textContent;

describe('map readout before a pick', () => {
  it('Flow Pulse says nothing about cell (0, 0) on load', () => {
    const moves: unknown[] = [];
    const g = new flow.FlowResultGrid({ ariaLabel: 'g', onActivate: () => {}, onMove: (c) => moves.push(c) });
    const fg = { z: new Float32Array(4), valid: new Uint8Array(4), cols: 2, rows: 2, cellMetresX: 1, cellMetresY: 1 };
    const routed = { receiver: new Int32Array(4).fill(-1), direction: new Int8Array(4).fill(-1), status: new Uint8Array(4), sinkCount: 0, flatCount: 0, outletCount: 0 };
    g.load(fg as never, routed as never, { upstreamCells: new Uint32Array(4).fill(1), drainedCells: 4, unresolvedCells: 0 }, null);
    expect(readout(g)).not.toContain('Column 0, row 0');
    expect(moves).toHaveLength(0);
  });

  it('Terrain Access says nothing about cell (0, 0) on load', () => {
    const g = new access.TerrainAccessResultGrid({ ariaLabel: 'g', onActivate: () => {}, onMove: () => {} });
    const grid = { cols: 2, rows: 2, z: new Float32Array(4), valid: new Uint8Array(4), cellMetresX: 1, cellMetresY: 1 };
    g.load(grid as never, []);
    expect(readout(g)).not.toContain('Column 0, row 0');
  });
});
