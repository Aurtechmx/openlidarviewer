import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LENS_CLOSED, lensCoverage, type Lens } from '../src/render/continuity/evidenceLens';
import { applyLensIntent } from '../src/render/continuity/lensPlacement';
import {
  lensOpacity,
  mayReconstructAt,
  shownSupport,
  shownSupportAt,
} from '../src/render/continuity/lensPresentation';
import type { SupportKind } from '../src/render/continuity/microGap';

const OPEN: Lens = {
  centreXPx: 100,
  centreYPx: 100,
  radiusPx: 20,
  featherPx: 10,
  enabled: true,
};

const KINDS: readonly SupportKind[] = ['none', 'direct', 'accumulated', 'reconstructed'];

describe('what the lens refuses', () => {
  it('refuses a substitution at its centre', () => {
    expect(mayReconstructAt(100, 100, OPEN)).toBe(false);
  });

  it('refuses one part way through the feather', () => {
    // A pixel at four-tenths of the fade is still one the viewer is looking
    // through the lens at. Filling it four-tenths of the way would be a
    // reconstruction the lens was supposed to have refused.
    const x = 100 + OPEN.radiusPx + OPEN.featherPx * 0.4;
    expect(lensOpacity(x, 100, OPEN)).toBeGreaterThan(0);
    expect(lensOpacity(x, 100, OPEN)).toBeLessThan(1);
    expect(mayReconstructAt(x, 100, OPEN)).toBe(false);
  });

  it('stops refusing at the outer edge of the feather, not at the radius', () => {
    const justOutside = 100 + OPEN.radiusPx + OPEN.featherPx + 1;
    expect(mayReconstructAt(justOutside, 100, OPEN)).toBe(true);
  });

  it('refuses nothing when no lens is open', () => {
    expect(mayReconstructAt(100, 100, LENS_CLOSED)).toBe(true);
  });
});

describe('the feather is opacity and nothing else', () => {
  it('fades across the feather while the refusal stays absolute', () => {
    const fractions: number[] = [];
    const admissions: boolean[] = [];
    for (let t = 0; t <= 1; t += 0.25) {
      const x = 100 + OPEN.radiusPx + OPEN.featherPx * t;
      fractions.push(lensOpacity(x, 100, OPEN));
      admissions.push(mayReconstructAt(x, 100, OPEN));
    }
    // The blend takes several values; the decision takes one.
    expect(new Set(fractions).size).toBeGreaterThan(1);
    expect(new Set(admissions)).toEqual(new Set([false]));
  });

  it('is the same fade the lens module already defines', () => {
    for (const [x, y] of [[100, 100], [115, 100], [128, 100], [200, 200]]) {
      expect(lensOpacity(x, y, OPEN)).toBe(lensCoverage(x, y, OPEN));
    }
  });

  it('never lets the fraction reach a decision', () => {
    // Structural rather than trusted: the admission path does not mention the
    // blend at all.
    const source = readFileSync(
      new URL('../src/render/continuity/lensPresentation.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const admission = code.slice(code.indexOf('export function mayReconstructAt'));
    const body = admission.slice(0, admission.indexOf('}') + 1);
    expect(body).not.toMatch(/lensCoverage|lensOpacity/);
    expect(body).toMatch(/admitsReconstruction/);
  });
});

describe('what an already-filled pixel shows as', () => {
  it('shows a reconstructed pixel as nothing under the lens', () => {
    // It does not become measured by being looked at: the fill was covering a
    // gap and the lens is the viewer asking to see the gap.
    expect(shownSupport('reconstructed', true)).toBe('none');
    expect(shownSupportAt('reconstructed', 100, 100, OPEN)).toBe('none');
  });

  it('keeps accumulated pixels, which source samples paid for', () => {
    expect(shownSupport('accumulated', true)).toBe('accumulated');
    expect(shownSupportAt('accumulated', 100, 100, OPEN)).toBe('accumulated');
  });

  it('changes nothing outside the lens', () => {
    for (const kind of KINDS) {
      expect(shownSupport(kind, false)).toBe(kind);
      expect(shownSupportAt(kind, 900, 900, OPEN)).toBe(kind);
    }
  });

  it('changes nothing at all when no lens is open', () => {
    for (const kind of KINDS) {
      expect(shownSupportAt(kind, 0, 0, LENS_CLOSED)).toBe(kind);
    }
  });

  it('substitutes only for display, never for the record', () => {
    // The stored provenance is an argument and comes back untouched in every
    // case but the one the lens is for; nothing here writes.
    const stored: SupportKind = 'reconstructed';
    expect(shownSupport(stored, true)).toBe('none');
    expect(stored).toBe('reconstructed');
  });
});

describe('the lens the viewer placed', () => {
  it('refuses substitution wherever the reducer put it', () => {
    // Inputs reach this through the intent reducer rather than a setter, so
    // the placement rules stay in one place.
    const viewport = { widthPx: 800, heightPx: 600 };
    const sizing = { radiusPx: 40, featherPx: 12 };
    const placed = applyLensIntent(
      LENS_CLOSED,
      { kind: 'at', source: 'touch', xPx: 300, yPx: 200 },
      viewport,
      sizing,
    );
    expect(placed.enabled).toBe(true);
    expect(mayReconstructAt(300, 200, placed)).toBe(false);
    expect(mayReconstructAt(300, 400, placed)).toBe(true);

    // A lifted finger keeps a touch lens open, so it keeps refusing.
    const held = applyLensIntent(placed, { kind: 'release', source: 'touch' }, viewport, sizing);
    expect(mayReconstructAt(300, 200, held)).toBe(false);

    // A closed lens refuses nothing.
    const closed = applyLensIntent(held, { kind: 'close' }, viewport, sizing);
    expect(mayReconstructAt(300, 200, closed)).toBe(true);
  });
});

describe('picking', () => {
  it('is not mentioned, because there is nothing to add', () => {
    // A click resolves against the source points, so a reconstructed pixel was
    // never pickable. Anything here that claimed to change what a click hits
    // would be a second picking path.
    const source = readFileSync(
      new URL('../src/render/continuity/lensPresentation.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/pick|raycast|hitTest/i);
    expect(code).toMatch(/export function shownSupport/);
  });
});
