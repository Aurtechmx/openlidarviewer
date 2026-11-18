import { describe, it, expect } from 'vitest';
import { writeAsciiGrid } from '../src/terrain/export/demAsciiGrid';
import { writeAsc } from '../src/convert/writeAscii';
import { loadXyz } from '../src/io/loadXyz';

const buf = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

function grid(): string {
  const cols = 4;
  const rows = 3;
  const values = Float32Array.from({ length: cols * rows }, (_, i) => 100 + i);
  const coverage = new Uint8Array(cols * rows).fill(2);
  coverage[5] = 0;
  return writeAsciiGrid({ values, coverage, cols, rows, cellSize: 1, xllCorner: 600000, yllCorner: 4000000 });
}

describe('loadXyz refuses an ESRI ASCII raster grid', () => {
  it('rejects the exported DTM grid', async () => {
    await expect(loadXyz(buf(grid()), 'site-dtm.asc')).rejects.toThrow('ESRI ASCII raster grid');
  });

  it('rejects a grid that uses xllcenter and leading comments', async () => {
    const txt = '# note\nNCOLS 2\nNROWS 2\nXLLCENTER 0\nYLLCENTER 0\nCELLSIZE 1\n1 2\n3 4\n';
    await expect(loadXyz(buf(txt), 'a.asc')).rejects.toThrow('ESRI ASCII raster grid');
  });

  it('rejects a header with nrows first', async () => {
    const txt = 'nrows 2\nncols 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2\n3 4\n';
    await expect(loadXyz(buf(txt), 'a.asc')).rejects.toThrow('ESRI ASCII raster grid');
  });

  it('rejects a dx/dy header with non-square cells', async () => {
    const txt = 'ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ndx 1\ndy 2\n1 2\n3 4\n';
    await expect(loadXyz(buf(txt), 'a.asc')).rejects.toThrow('ESRI ASCII raster grid');
  });

  it('rejects upper-case keys in any order', async () => {
    const txt = 'YLLCORNER 0\nCELLSIZE 1\nNROWS 2\nXLLCORNER 0\nNCOLS 2\n1 2\n3 4\n';
    await expect(loadXyz(buf(txt), 'a.asc')).rejects.toThrow('ESRI ASCII raster grid');
  });

  it('rejects a GRASS ASCII raster header and names GRASS', async () => {
    const txt = 'north: 4000\nsouth: 3000\neast: 2000\nwest: 1000\nrows: 2\ncols: 2\n1 2\n3 4\n';
    await expect(loadXyz(buf(txt), 'a.asc')).rejects.toThrow('GRASS');
  });

  it('loads a point file whose first line starts with the word ncols', async () => {
    const pc = await loadXyz(buf('ncols 5\n1 2 3\n4 5 6\n'), 'pts.asc');
    expect(pc.pointCount).toBe(2);
  });

  it('still loads a three-column point .asc', async () => {
    const g = { count: 3, x: Float64Array.from([1, 2, 3]), y: Float64Array.from([4, 5, 6]), z: Float64Array.from([7, 8, 9]) };
    const pc = await loadXyz(buf(writeAsc(g)), 'pts.asc');
    expect(pc.pointCount).toBe(3);
  });
});
