/**
 * georefStatus.ts
 *
 * Plain-language "is this scan anchored to the real world?" status — the
 * intuitive replacement for the jargon "CRS Unknown / Datum Unknown" chips.
 *
 * Two INDEPENDENT facts drive it (a scan can have one without the other):
 *   • Position (horizontal CRS) — can the scan be placed on a map?
 *   • Height   (vertical datum) — are the heights real elevations or relative?
 *
 * The module is pure data: given the two booleans it returns a muted-tone
 * status (never an error red — a missing CRS is a neutral fact, not a fault), a
 * plain-English headline, the two sub-facts, an expert tooltip, and a small
 * schematic glyph (a marker over a "world" ground line: planted when
 * positioned, floating with a dashed tether when heights are relative). All
 * four states are covered so the UI never renders only the unknown case.
 *
 * No DOM, no I/O. Deterministic. The caller renders the returned strings.
 */

/** Tone for the status — drives colour only. Deliberately never 'error'. */
export type GeorefTone = 'anchored' | 'partial' | 'floating';

/** The plain-language georeferencing status of a scan. */
export interface GeorefStatus {
  readonly tone: GeorefTone;
  /** One-line plain-English summary, e.g. "Floating scan — not placed on Earth". */
  readonly headline: string;
  /** Whether the scan has a horizontal position (CRS). */
  readonly positionKnown: boolean;
  /** Whether the scan has a real-world height reference (vertical datum). */
  readonly heightKnown: boolean;
  /** Plain sub-fact for position, e.g. "On the map" / "Not on a map". */
  readonly positionLabel: string;
  /** Plain sub-fact for height, e.g. "Real-world elevation" / "Relative heights". */
  readonly heightLabel: string;
  /** Expert detail for the tooltip (names the actual CRS / datum when known). */
  readonly tooltip: string;
}

/** Options carrying the real CRS / datum names for the expert tooltip. */
export interface GeorefStatusNames {
  /** Horizontal CRS name when known (e.g. "WGS 84 / UTM zone 12N"). */
  readonly crsName?: string | null;
  /** Vertical datum name when known (e.g. "NAVD88"). */
  readonly datumName?: string | null;
}

/**
 * Derive the plain-language georeferencing status from the two booleans.
 * `crsKnown` = has a horizontal position; `datumKnown` = has a height datum.
 */
export function georefStatus(
  crsKnown: boolean,
  datumKnown: boolean,
  names: GeorefStatusNames = {},
): GeorefStatus {
  const positionLabel = crsKnown ? 'On the map' : 'Not on a map';
  const heightLabel = datumKnown ? 'Real-world elevation' : 'Relative heights';

  let tone: GeorefTone;
  let headline: string;
  if (crsKnown && datumKnown) {
    tone = 'anchored';
    headline = 'Placed in the real world';
  } else if (!crsKnown && !datumKnown) {
    tone = 'floating';
    headline = 'Floating scan — not placed on Earth';
  } else if (crsKnown) {
    tone = 'partial';
    headline = 'On the map · heights are relative';
  } else {
    tone = 'partial';
    headline = 'Real elevations · not placed on a map';
  }

  // Expert tooltip names the real CRS / datum so a surveyor still gets the
  // technical fact; a plain consequence sentence follows for everyone else.
  const crsPart = crsKnown ? `Position: ${names.crsName?.trim() || 'defined'}` : 'Position: none (no CRS)';
  const datumPart = datumKnown ? `Height: ${names.datumName?.trim() || 'defined'}` : 'Height: none (no vertical datum)';
  const consequence =
    crsKnown && datumKnown
      ? 'Coordinates and heights are real-world values.'
      : !crsKnown && !datumKnown
        ? 'The scan can’t be placed on a map and its heights are relative only.'
        : crsKnown
          ? 'The scan is georeferenced horizontally, but heights are relative (no vertical datum).'
          : 'Heights are referenced, but the scan can’t be placed on a map (no CRS).';
  const tooltip = `${crsPart} · ${datumPart}. ${consequence}`;

  return { tone, headline, positionKnown: crsKnown, heightKnown: datumKnown, positionLabel, heightLabel, tooltip };
}

/**
 * A small schematic glyph (viewBox 0 0 24 24, uses `currentColor`) that encodes
 * both axes at a glance:
 *   • a "world" ground line at the bottom — solid when heights are real,
 *     dashed/faint when relative;
 *   • a marker that sits ON the ground when the height is real, or FLOATS above
 *     with a dashed tether when heights are relative;
 *   • the marker is a planted PIN when positioned, or a detached, slashed dot
 *     when it can't be placed on a map.
 *
 * Returned as an SVG string so it is deterministic and unit-testable (the
 * structural marks — dashed tether, slash, pin — appear only in the right
 * states). The caller sets the colour via `currentColor` from the tone.
 */
export function georefGlyphSvg(crsKnown: boolean, datumKnown: boolean): string {
  const markerY = datumKnown ? 14 : 8; // floats up when height is relative
  const parts: string[] = [
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
    // The "world" ground line — solid for a real datum, dashed + faint when relative.
    `<line x1="4" y1="19" x2="20" y2="19" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"` +
      `${datumKnown ? '' : ' stroke-dasharray="2.2 2.2" opacity="0.55"'}/>`,
  ];
  // Relative height → a dashed tether from the floating marker down to the ground.
  if (!datumKnown) {
    parts.push(
      `<line x1="12" y1="${markerY + 4}" x2="12" y2="19" stroke="currentColor" stroke-width="1.2" stroke-dasharray="1.6 1.8" opacity="0.8"/>`,
    );
  }
  if (crsKnown) {
    // Planted pin (teardrop) — positioned on the map.
    parts.push(
      `<path d="M12 ${markerY - 4} a4 4 0 0 1 4 4 c0 3 -4 ${datumKnown ? '5' : '5'} -4 ${datumKnown ? '5' : '5'} ` +
        `c0 0 -4 -2 -4 -5 a4 4 0 0 1 4 -4 z" stroke="currentColor" stroke-width="1.4" fill="none"/>`,
      `<circle cx="12" cy="${markerY}" r="1.4" fill="currentColor"/>`,
    );
  } else {
    // Detached, slashed dot — can't be placed on a map.
    parts.push(
      `<circle cx="12" cy="${markerY}" r="3.4" stroke="currentColor" stroke-width="1.4" fill="none"/>`,
      `<line x1="9.2" y1="${markerY - 2.8}" x2="14.8" y2="${markerY + 2.8}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}
