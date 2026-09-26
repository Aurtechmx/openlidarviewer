/**
 * thirdPartyNotices.test.ts: the generated copyright and licence-text section.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { buildBlock, copyrightLines, spliceBlock, BEGIN, END } from '../scripts/gen-third-party-notices.mjs';

const MIT = 'MIT License\n\nCopyright (c) 2020 Someone\n\nPermission is hereby granted, free of charge.\nThe above copyright notice and this permission notice shall be included.';
const APACHE = 'Apache License\n                           Version 2.0, January 2004\n\n"Licensor" shall mean the copyright owner.\n(c) You must retain';

describe('gen-third-party-notices', () => {
  it('keeps copyright statements and drops licence boilerplate', () => {
    expect(copyrightLines(MIT)).toEqual(['Copyright (c) 2020 Someone']);
    expect(copyrightLines(APACHE)).toEqual([]);
  });

  it('reproduces each distinct text once and lists every package under it', () => {
    const { block, missing } = buildBlock(
      [
        { name: 'a', version: '1.0.0', licence: 'MIT' },
        { name: 'b', version: '2.0.0', licence: 'MIT' },
        { name: 'c', version: '3.0.0', licence: 'Apache-2.0' },
        { name: 'd', version: '4.0.0', licence: 'Apache-2.0' },
      ],
      (name: string) =>
        ({
          a: { licences: [{ file: 'LICENSE', text: MIT }], notices: [] },
          b: { licences: [{ file: 'LICENSE', text: MIT }], notices: [] },
          c: { licences: [{ file: 'LICENSE', text: APACHE }], notices: [{ file: 'NOTICE', text: 'Copyright 2024 C Org' }] },
          d: { licences: [], notices: [] },
        })[name] ?? null,
    );
    expect(missing).toEqual([]);
    expect(block.match(/Permission is hereby granted/g)).toHaveLength(1);
    expect(block).toContain('Applies to: a 1.0.0, b 2.0.0.');
    expect(block).toContain('#### NOTICE file of c 3.0.0 (NOTICE)');
    expect(block).toContain('- Copyright 2024 C Org');
    // A package with no licence file gets the standard text of its licence.
    expect(block).toMatch(/#### d 4\.0\.0\n\nLicence: Apache-2\.0\. Text: T2\. The published package ships no licence file/);
  });

  it('reports a package that is not installed', () => {
    const { missing } = buildBlock([{ name: 'gone', version: '1.0.0', licence: 'MIT' }], () => null);
    expect(missing).toEqual(['gone']);
  });

  it('replaces only the text between the markers', () => {
    const doc = `head\n\n${BEGIN}\nold\n${END}\ntail\n`;
    expect(spliceBlock(doc, `${BEGIN}\nnew\n${END}`)).toBe(`head\n\n${BEGIN}\nnew\n${END}\ntail\n`);
  });
});
