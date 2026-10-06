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
