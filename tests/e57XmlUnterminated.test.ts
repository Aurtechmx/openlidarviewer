/**
 * e57XmlUnterminated.test.ts — the E57 XML parser must TERMINATE on a
 * truncated document, not spin.
 *
 * `parseXml` advanced past each `<![CDATA[`, `<!--` and `<?…?>` by jumping to
 * the index AFTER its closing delimiter. When the delimiter was missing,
 * `String.indexOf` returned -1 and the cursor jumped to a tiny fixed index
 * (2, or 1) instead of end-of-input, so the parser re-read the same bytes
 * forever. In production this runs in the shared, gated parse worker: an
 * unterminated section hung the worker at 100% CPU, the load promise never
 * settled, and — because the gate is released in a `finally` that never ran —
 * every subsequent file load in the session hung too. Only a reload recovered.
 *
 * Each case must throw a structured error quickly. A 2 s per-test timeout
 * turns a regression back into a fast failure rather than a hung suite.
 */

import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/io/e57/xml';

const TIMEOUT = 2000;

describe('e57 parseXml terminates on truncated input', () => {
  it('throws on an unterminated CDATA section', () => {
    expect(() => parseXml('<e57Root><data><![CDATA[oops never closed')).toThrow(/Invalid XML/i);
  }, TIMEOUT);

  it('throws on an unterminated comment', () => {
    expect(() => parseXml('<e57Root><!-- never closed')).toThrow(/Invalid XML/i);
  }, TIMEOUT);

  it('throws on an unterminated processing instruction in content', () => {
    expect(() => parseXml('<e57Root><?pi never closed')).toThrow(/Invalid XML/i);
  }, TIMEOUT);

  it('throws on an unterminated processing instruction in the prolog', () => {
    expect(() => parseXml('<?xml version="1.0" never closed')).toThrow(/Invalid XML/i);
  }, TIMEOUT);

  it('throws on an unterminated comment in the prolog', () => {
    expect(() => parseXml('<!-- never closed')).toThrow(/Invalid XML/i);
  }, TIMEOUT);

  it('throws on an unterminated end tag', () => {
    expect(() => parseXml('<e57Root></e57Root never closed')).toThrow(/Invalid XML/i);
  }, TIMEOUT);

  it('still parses a well-formed document with a CDATA, comment and PI', () => {
    const doc = parseXml('<?xml version="1.0"?><!-- ok --><e57Root><data><![CDATA[hello]]></data></e57Root>');
    expect(doc.name).toBe('e57Root');
    expect(doc.children[0]?.name).toBe('data');
    expect(doc.children[0]?.text).toBe('hello');
  }, TIMEOUT);
});
