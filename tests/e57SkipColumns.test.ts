import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57 } from '../src/io/e57/parseE57';

/**
 * `parseE57`'s `keepField` predicate decodes only the columns a caller will
 * consume. `loadE57` uses it to skip a structured scan's rowIndex/columnIndex
 * and other unread prototype fields — on a tens-of-millions-of-points scan that
 * is hundreds of MB of Float64 allocation and per-value conversion avoided
 * (measured 17% off decode time on a real 37 M-point file). This pins two
 * contract points: the default decodes every column, and the predicate is
 * honoured. The synthetic-normals fixture carries `nor:normalX/Y/Z` alongside
 * the core Cartesian fields, so a predicate can keep one group and drop the
 * other.
 */
const bytes = readFileSync(fileURLToPath(new URL('./fixtures/synthetic-normals.e57', import.meta.url)));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

describe('parseE57 keepField', () => {
  it('decodes every column by default', () => {
    const cols = Object.keys(parseE57(buffer).scans[0].columns);
    expect(cols).toContain('cartesianX');
    expect(cols).toContain('nor:normalX');
    expect(cols).toContain('nor:normalZ');
  });

  it('decodes only the columns the predicate accepts', () => {
    const parsed = parseE57(buffer, { keepField: (n) => n.startsWith('cartesian') });
    const cols = Object.keys(parsed.scans[0].columns);
    expect(cols).toContain('cartesianX');
    expect(cols).toContain('cartesianInvalidState');
    // The namespaced normal columns were declared and their bytestreams walked,
    // but the predicate rejected them, so they were never expanded.
    expect(cols).not.toContain('nor:normalX');
    expect(cols).not.toContain('nor:normalY');
    expect(cols).not.toContain('nor:normalZ');
  });
});
