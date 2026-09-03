import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Tab to the Measurements rail's resize grip and press ArrowLeft: the rail
 * resized AND the camera orbited. The grip called `preventDefault` but let the
 * event bubble, and NavController's window listener only recognised a typing
 * surface by tag name — INPUT, TEXTAREA, SELECT — so a focused
 * `div role="separator"` was not treated as holding focus.
 *
 * Source-level, because the panel needs a live viewer to render. Comments are
 * stripped first: this repo has already had a source assertion kept green by
 * prose that merely mentioned the property it was checking for.
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const PANEL = stripComments(readFileSync(resolve(__dirname, '../src/ui/MeasurePanel.ts'), 'utf8'));
const NAV = stripComments(readFileSync(resolve(__dirname, '../src/render/NavController.ts'), 'utf8'));

describe('resize grip does not also drive the camera', () => {
  it('stops the grip’s arrow keys from bubbling', () => {
    // The handler body, from the keydown registration to the end of its block.
    const start = PANEL.indexOf("handle.addEventListener('keydown'");
    expect(start).toBeGreaterThan(-1);
    const body = PANEL.slice(start, start + 900);
    for (const arrow of ['ArrowLeft', 'ArrowRight']) {
      const at = body.indexOf(arrow);
      expect(at, arrow).toBeGreaterThan(-1);
      // Each arrow branch must consume the event for itself AND stop it.
      expect(body.slice(at, at + 260), arrow).toMatch(/stopPropagation\(\)/);
    }
  });

  it('makes NavController ignore a key another control already handled', () => {
    // Anchor on the METHOD, not the earlier registration that references it.
    const at = NAV.indexOf('private _handleKeyDown(');
    expect(at).toBeGreaterThan(-1);
    const body = NAV.slice(at, at + 700);
    expect(body).toMatch(/if\s*\(\s*e\.defaultPrevented\s*\)\s*return;/);
    // The bare tag-name test must not be the ONLY focus guard any more.
    expect(body).toMatch(/isContentEditable/);
  });
});
