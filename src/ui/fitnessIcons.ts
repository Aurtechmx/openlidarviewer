/**
 * fitnessIcons.ts
 *
 * Friendly metaphor icons for the Data Fitness scorecard, in the SAME house
 * style as the measurement / dock glyphs (24×24, currentColor, 1.6 px stroke,
 * round caps/joins — reusing `svg`/`dot` from dockIcons so the family is
 * literally shared, not re-derived). Each verification dimension gets a concrete
 * metaphor a non-expert recognises; each row also carries the icon beside its
 * text label (icon-only toolbars hurt first-time users — labels stay).
 *
 * The tone glyphs (ready / okay / review) are deliberately SHAPE-distinct
 * (check / dash / warning-triangle), not colour-only — the accessibility fix the
 * design council flagged: a traffic-light dot must not rely on hue alone.
 *
 * Pure strings, no DOM. Keyed by the scanFitness vocabulary so the panel just
 * looks them up.
 */

import { svg, dot } from './dockIcons';
import type { FitnessKey, FitnessTone } from '../terrain/quality/scanFitness';

/** Location & height — a map pin (the universal "where on Earth" metaphor). */
const ICON_GEOREF = svg(
  `<path d="M12 21s6-5.4 6-10a6 6 0 1 0-12 0c0 4.6 6 10 6 10z"/>` + dot(12, 11, 2.1),
);

/** Coverage — a ground patch (grid) with one cell missing (a gap in coverage). */
const ICON_COVERAGE = svg(
  `<rect x="4" y="4" width="16" height="16" rx="1.6"/><path d="M12 4v16M4 12h16"/>` +
    // three filled quadrants, one left empty = the uncovered gap
    dot(8, 8, 1.4) + dot(16, 8, 1.4) + dot(8, 16, 1.4),
);

/** Ground detail — a field of dots (point density). */
const ICON_DENSITY = svg(
  [
    dot(7, 8, 1.3), dot(12, 8, 1.3), dot(17, 8, 1.3),
    dot(7, 12, 1.3), dot(12, 12, 1.3), dot(17, 12, 1.3),
    dot(9.5, 16, 1.3), dot(14.5, 16, 1.3),
  ].join(''),
);

/** Vertical accuracy — a bullseye / target (how close to the truth). */
const ICON_ACCURACY = svg(`<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.4"/>` + dot(12, 12, 1.3));

/** Classification — stacked layers (points sorted into classes). */
const ICON_CLASSIFICATION = svg(
  `<path d="M12 4 3 8.5l9 4.5 9-4.5z"/><path d="M3 13l9 4.5 9-4.5"/>`,
);

/** Integrity — a shield with a check (the file is sound and tells the truth). */
const ICON_INTEGRITY = svg(`<path d="M12 3l7 3v5c0 4.6-3 7.8-7 9-4-1.2-7-4.4-7-9V6z"/><path d="M9 12l2 2 4-4"/>`);

const DIMENSION_ICONS: Record<FitnessKey, string> = {
  georeferencing: ICON_GEOREF,
  coverage: ICON_COVERAGE,
  density: ICON_DENSITY,
  accuracy: ICON_ACCURACY,
  classification: ICON_CLASSIFICATION,
  integrity: ICON_INTEGRITY,
};

/** The friendly metaphor icon (SVG string) for a scorecard dimension. */
export function fitnessIcon(key: FitnessKey): string {
  return DIMENSION_ICONS[key];
}

// ── Tone glyphs — shape-distinct, NOT colour-only ──────────────────────────────
/** Ready — a check mark. */
const TONE_READY = svg(`<path d="M5 12.5l4.5 4.5L19 7"/>`);
/** Okay — a neutral dash (present, with limits). */
const TONE_OKAY = svg(`<path d="M6 12h12"/>`);
/** Review — a warning triangle. */
const TONE_REVIEW = svg(`<path d="M12 4.5 21 19.5H3z"/><path d="M12 10.5v4"/>` + dot(12, 17, 1.2));

const TONE_GLYPHS: Record<FitnessTone, string> = {
  ready: TONE_READY,
  okay: TONE_OKAY,
  review: TONE_REVIEW,
};

/** The shape-distinct glyph (SVG string) for a tone — pairs with the colour. */
export function fitnessToneGlyph(tone: FitnessTone): string {
  return TONE_GLYPHS[tone];
}
