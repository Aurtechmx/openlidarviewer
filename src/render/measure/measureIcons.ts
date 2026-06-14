/**
 * measureIcons.ts
 *
 * A small set of hand-drawn, futuristic line-icons for the measurement
 * toolbar — one per measurement kind, plus the auxiliary tools (Lasso) and
 * the action controls (Undo / Units / Done / Finish / Clear).
 *
 * House style (matches NavBar's inline SVGs):
 *   • 24×24 viewBox, geometric, single weight.
 *   • stroke = currentColor so the button's text colour drives the glyph —
 *     active/hover states recolour for free.
 *   • 1.6 px stroke, round caps + joins for a clean, technical feel.
 *   • aria-hidden — the accessible name lives on the host <button>.
 *
 * Icons are returned as full <svg> strings (trusted static source markup),
 * injected through the el() trusted-markup prop.
 */

import type { MeasurementKind } from './types';

/** Wrap inner markup in the shared svg shell so every glyph is consistent. */
function svg(inner: string): string {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" ' +
    'fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    inner +
    '</svg>'
  );
}

/** A filled vertex dot (endpoints of a measurement). */
const dot = (cx: number, cy: number, r = 1.9): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

export const KIND_ICON: Record<MeasurementKind, string> = {
  // Straight line between two picked points.
  distance: svg(`<path d="M5 19 19 5"/>${dot(5, 19)}${dot(19, 5)}`),
  // Multi-segment path.
  polyline: svg(`<path d="M4 16l5-5 4 3 7-8"/>${dot(4, 16, 1.6)}${dot(20, 6, 1.6)}`),
  // Closed polygon with a faint fill.
  area: svg(
    `<path d="M5 7l8-2 6 5-3 8-9-2z" fill="currentColor" fill-opacity="0.14"/>`,
  ),
  // Vertical extent — double arrow between two levels.
  height: svg(
    `<path d="M12 4v16"/><path d="M8.5 7.5 12 4l3.5 3.5"/><path d="M8.5 16.5 12 20l3.5-3.5"/>`,
  ),
  // Angle at a vertex with a sweep arc.
  angle: svg(`<path d="M5 19h14"/><path d="M5 19 17 6"/><path d="M12 19a7 7 0 0 0-1.5-4.3"/>`),
  // Right triangle = rise over run.
  slope: svg(
    `<path d="M4 19 19 19 19 6Z" fill="currentColor" fill-opacity="0.12"/>`,
  ),
  // Terrain cross-section over a baseline.
  profile: svg(
    `<path d="M3 12c3-5 6 4 9 0s5-6 9-1"/><path d="M3 19h18" stroke-opacity="0.45"/>`,
  ),
  // Isometric cube (axis-aligned slice).
  box: svg(
    `<path d="M4 8 12 4 20 8 12 12Z"/><path d="M4 8v8l8 4 8-4V8"/><path d="M12 12v8"/>`,
  ),
  // Stacked prisms = volume.
  volume: svg(
    `<path d="M12 3 20 7 12 11 4 7Z"/><path d="M4 11l8 4 8-4"/><path d="M4 15l8 4 8-4"/>`,
  ),
};

/** Lasso (freeform volume footprint) — the auxiliary kind button. */
export const ICON_LASSO = svg(
  `<path d="M4 10c0-3 4-5 8-5s8 2 8 5-4 5-8 5c-2 0-3 1-3 2.2a1.7 1.7 0 1 0 1.6-1.7"/>`,
);

/** Action-control glyphs. */
export const ICON_UNDO = svg(`<path d="M9 8 5 12l4 4"/><path d="M5 12h8a5 5 0 0 1 0 10"/>`);
export const ICON_UNITS = svg(
  `<rect x="3" y="9" width="18" height="6" rx="1.3"/><path d="M7 9v2.6M11 9v3.6M15 9v2.6M19 9v3.6"/>`,
);
export const ICON_DONE = svg(`<path d="M5 12.5 10 17l9-10"/>`);
export const ICON_FINISH = svg(
  `<path d="M5 6l9 1 2 9-8 2z" fill="currentColor" fill-opacity="0.12"/><path d="M9 13l2 2 4-5"/>`,
);
export const ICON_CLEAR = svg(
  `<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 12h8l1-12"/>`,
);
