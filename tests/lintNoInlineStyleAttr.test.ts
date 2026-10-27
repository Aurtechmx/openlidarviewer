/**
 * lintNoInlineStyleAttr.test.ts: the forms scripts/lint-no-inline-style-attr.mjs
 * must catch, and the comment masking that must not hide them.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain .mjs script without types
import { findStyleAttrViolations, maskComments } from '../scripts/lint-no-inline-style-attr.mjs';

const hits = (src: string): number[] => findStyleAttrViolations(src).map((v: { line: number }) => v.line);

describe('lint-no-inline-style-attr', () => {
  it('catches quoted, unquoted and template-filled style attributes in markup', () => {
    expect(hits('el.innerHTML = `<div style="color:red">`;')).toEqual([1]);
    expect(hits('el.innerHTML = \'<div style=color:red>\';')).toEqual([1]);
    expect(hits('el.innerHTML = `<div style=${s}>`;')).toEqual([1]);
    expect(hits('el.innerHTML = `<div style = ${s}>`;')).toEqual([1]);
    expect(hits("el.setAttribute('style', s);")).toEqual([1]);
  });

  it('a // inside a string does not hide a violation later on the line', () => {
    expect(hits("const u = 'a//b'; el.innerHTML = '<p style=\"x\">';")).toEqual([1]);
    expect(hits('const u = "http://x"; el.setAttribute(\'style\', s);')).toEqual([1]);
    expect(hits('const u = `a//b`; el.innerHTML = `<p style=${s}>`;')).toEqual([1]);
  });

  it('still masks real comments and allows CSSOM writes', () => {
    expect(hits('// el.setAttribute(\'style\', s)\n/* <p style="x"> */')).toEqual([]);
    expect(hits("el.style.cssText = 'color:red'; el.style = 'x'; const style = makeStyle();")).toEqual([]);
    expect(maskComments('a // b\nc')).toBe('a     \nc');
  });
});
