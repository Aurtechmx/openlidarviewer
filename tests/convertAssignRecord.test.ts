/**
 * Assign writes a chosen EPSG into the output without moving points. The
 * written file must say the CRS was assigned at export; otherwise its WKT
 * reads like the source's own declaration, while its CRS-source line names
 * whatever the source declared (often nothing).
 */
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';

function cloud(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
    origin: [500000, 4100000, 0],
    sourceFormat: 'las',
    name: 'scan.las',
  });
}

const text = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('assigned CRS on export', () => {
  for (const format of ['las14', 'las'] as const) {
    it(`${format}: the file records that the CRS was assigned`, () => {
      const { file, report } = convertCloud(cloud(), { format, crsMode: 'assign', targetEpsg: 32633 });
      expect(report.ok).toBe(true);
      expect(text(file!.bytes as Uint8Array)).toContain('Conversion event crs-assigned: EPSG:32633 assigned at export; coordinates not moved.');
    });
  }

  it('keep mode records no assignment', () => {
    const { file } = convertCloud(cloud(), { format: 'las14', crsMode: 'keep' });
    expect(text(file!.bytes as Uint8Array)).not.toContain('crs-assigned');
  });
});
