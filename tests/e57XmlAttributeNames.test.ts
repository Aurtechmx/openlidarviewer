import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/io/e57/xml';

describe('E57 XML attribute names', () => {
  it('keeps attribute names from the file as plain keys', () => {
    const node = parseXml('<e57Root __proto__="x" constructor="y" toString="z" type="Structure"/>');
    expect(Object.getPrototypeOf(node.attrs)).toBeNull();
    expect(Object.keys(node.attrs).sort()).toEqual(['__proto__', 'constructor', 'toString', 'type']);
    expect(node.attrs.type).toBe('Structure');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('does not inherit names the file did not declare', () => {
    const node = parseXml('<e57Root type="Structure"/>');
    expect(node.attrs.constructor).toBeUndefined();
    expect(node.attrs.toString).toBeUndefined();
  });
});

describe('E57 column maps', () => {
  it('builds the decoded and structured column maps without a prototype', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/io/e57/compressedVector.ts', 'utf8') + fs.readFileSync('src/io/e57/parseE57.ts', 'utf8'));
    expect(src).not.toMatch(/columns: DecodedColumns = \{\}/);
    expect(src).not.toMatch(/\{ columns: \{\}, contradiction/);
  });
});
