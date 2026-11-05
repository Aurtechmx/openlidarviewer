import { describe, it, expect } from 'vitest';
import type { Measurement, Vec3, VolumeRecord } from '../src/render/measure/types';
import { measurementsToCsv, type MeasurementExportContext } from '../src/export/measurementExport';

/** A Y-up scan: heights are the Y coordinate; the ring lies in the X/Z plane. */
const Y: Vec3 = [0, 1, 0];
const RING: Vec3[] = [[0, 12.0, 0], [10, 12.5, 0], [10, 12.35, 10], [0, 13.0, 10]];
const RECORD = { referenceZ: 12.35, fill: 30, cut: 10, net: 20, footprintArea: 100, pointsInPolygon: 400, densityNative: 4, confidence: 'medium' } as unknown as VolumeRecord;
const m = { id: 'v1', kind: 'volume', name: 'Volume 1', closed: true, points: RING.map((p) => [...p] as Vec3), volume: { ...RECORD } } as Measurement;

function row(csv: string): Record<string, string> {
  const [head, line] = csv.trim().split('\n');
  const keys = head!.split(',');
  const cells = line!.split(',');
  return Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? '']));
}

describe('base_level on a Y-up frame', () => {
  it('reads the height along the frame up axis, not the third coordinate', () => {
    const ctx: MeasurementExportContext = { toOutput: (p) => [p[0], p[1] + 400, p[2]], up: Y, unitToMetres: 1 };
    expect(row(measurementsToCsv([m], ctx)).base_level).toBe('412.35');
  });

  it('keeps the Z-up reading', () => {
    const ringZ: Vec3[] = [[0, 0, 12.0], [10, 0, 12.5], [10, 10, 12.35], [0, 10, 13.0]];
    const ctx: MeasurementExportContext = { toOutput: (p) => [p[0], p[1], p[2] + 400], up: [0, 0, 1], unitToMetres: 1 };
    expect(row(measurementsToCsv([{ ...m, points: ringZ } as Measurement], ctx)).base_level).toBe('412.35');
  });
});
