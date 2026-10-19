import { describe, expect, it } from 'vitest';
import { escapeXml } from '../src/terrain/space/floorplan/floorPlanSvg';

describe('floor plan escapeXml', () => {
  it('escapes the five XML specials', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('strips characters XML 1.0 cannot carry and keeps tab, newline and CR', () => {
    expect(escapeXml('R\u0000o\u0008o\u000Bm\u000C \u001F1\uFFFE\uFFFF\t\n\r')).toBe('Room 1\t\n\r');
  });
});
