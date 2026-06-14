/**
 * dockIcons.ts
 *
 * Line-icons for the bottom tool dock, in the same house style as the
 * measurement-toolbar glyphs (24×24, currentColor, 1.6 px stroke, round
 * caps/joins). Metaphors follow the strongest cross-tool conventions
 * (Material Symbols / QGIS / Blender / Photoshop) surfaced by research:
 *
 *   • Inspect and Probe are DELIBERATELY differentiated — Inspect is a
 *     target/crosshair (a deliberate point pick), Probe is an eyedropper
 *     (a continuous hover readout) — because no single convention separates
 *     the two and users confuse them otherwise.
 *
 * Every dock control keeps its visible TEXT LABEL (evidence: icon-only
 * toolbars hurt first-time users); these glyphs ride to the left of the label.
 */

function svg(inner: string): string {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    inner +
    '</svg>'
  );
}

const dot = (cx: number, cy: number, r = 1.7): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

/** Fit-to-view — frame corners around a centred object (CAD "zoom extents"). */
export const ICON_FRAME = svg(
  `<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"/><path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/>` +
    `<path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>` +
    dot(12, 12, 1.6),
);

/** Snapshot — a camera body with a lens (Material photo_camera). */
export const ICON_SNAPSHOT = svg(
  `<path d="M4 8.5h3l1.4-2h7l1.4 2h3a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z"/>` +
    `<circle cx="12" cy="13" r="3"/>`,
);

/** Copy view link — interlocked chain links (Material link). */
export const ICON_LINK = svg(
  `<path d="M10 14a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1"/>` +
    `<path d="M14 10a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1"/>`,
);

/** Help — a question mark in a circle. */
export const ICON_HELP = svg(
  `<circle cx="12" cy="12" r="9"/>` +
    `<path d="M9.5 9.3a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1.1.9-1.1 1.6v.4"/>` +
    dot(11.8, 16.4, 1.3),
);

/** Measure — a ruler with tick marks (CloudCompare / QGIS measure). */
export const ICON_MEASURE = svg(
  `<path d="M5 15 15 5l4 4L9 19z"/><path d="M8.5 11.5l1.6 1.6"/>` +
    `<path d="M11 9l1.6 1.6"/><path d="M13.5 6.5l1.6 1.6"/>`,
);

/** Inspect — a target/crosshair: a deliberate point pick. */
export const ICON_INSPECT = svg(
  `<circle cx="12" cy="12" r="5.5"/>` +
    `<path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5"/>` +
    dot(12, 12, 1.5),
);

/** Probe — an eyedropper: the continuous hover readout. */
export const ICON_PROBE = svg(
  `<path d="M14.5 5.5l4 4"/>` +
    `<path d="M16.2 6.2l2-2a1.6 1.6 0 0 0-2.3-2.3l-2 2"/>` +
    `<path d="M14.6 6.6 6 15.2 4.7 19.3 8.8 18l8.6-8.6z"/>`,
);

/** Annotate — a comment bubble with a note line. */
export const ICON_ANNOTATE = svg(
  `<path d="M4.5 6.5h15a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H11l-4 3.2V15.5H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/>` +
    `<path d="M8 10h8M8 12.5h5"/>`,
);

/** Analyse — nested terrain contour lines (terrain intelligence). */
export const ICON_ANALYSE = svg(
  `<path d="M3 14.5c3-4 6 1.6 9-1.2s6-2.6 9 .2"/>` +
    `<path d="M3 18.5c3-4 6 1.6 9-1.2s6-2.6 9 .2"/>` +
    `<path d="M3 10.5c3-4 6 1.6 9-1.2s6-2.6 9 .2" stroke-opacity="0.5"/>`,
);

/** Close — an X (clear the scan). */
export const ICON_CLOSE = svg(`<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`);
