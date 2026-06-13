/**
 * floorPlanSvg.ts
 *
 * Render a {@link FloorPlanModel} as a standalone architectural-style SVG
 * sheet (print-clean, NOT the app's dark theme): solid wall poché (the
 * traced wall strips as one nonzero-winding dark fill — door openings stay
 * as genuine gaps, while UNKNOWN gaps — facing wall ends without square jamb
 * evidence — are drawn as light dashed lines), a light scanned-floor
 * interior fill underneath, door-leaf swing arcs on classified doorways,
 * "Room N · area" labels at each segmented room's pole of inaccessibility
 * plus a footer room schedule (roomDetect.ts; when NO rooms were segmented,
 * the old approximate region-area labels of the floor-fill regions render
 * instead — scanned-floor extents, and the footer says so), a yellow-tinted poché
 * for wall rings mostly interpolated by gap-closing (per-ring observed
 * fraction below OBSERVED_FRAC_MIN), a scale bar, overall W × D dimensions,
 * a bottom-right title block (title / dims / area / scale / date), the
 * local-frame (no true north) note, and
 * the standing suitability caveat. Dimension and scale-bar units follow the
 * caller's unit system: metric prints metres first (feet in parentheses),
 * imperial the other way round, matching the measurement panel.
 *
 * Pure string output, deterministic, no DOM. Every interpolated string is
 * XML-escaped so a scan name with `<` / `&` / `"` can never break the markup.
 */

import { OBSERVED_FRAC_MIN, type FloorPlanModel } from './extractFloorPlan';
import { ringSignedArea, type Ring } from './vectorize';
import { metresToFeet, sqMetresToSqFeet } from '../../spaceMetrics';

/** Mirrors the measurement panel's unit system; kept local so this pure
 * terrain module never imports from the render layer. */
export type PlanUnitSystem = 'metric' | 'imperial';

export interface FloorPlanSvgOptions {
  /** Title printed at the top of the sheet (e.g. the scan name). */
  readonly title?: string;
  /** Target sheet width in px (the drawing area scales to fit). Default 720. */
  readonly width?: number;
  /** Primary unit for dimensions + scale bar. Default 'metric'. */
  readonly unitSystem?: PlanUnitSystem;
  /** Date printed in the title block (ISO yyyy-mm-dd). Default: today. */
  readonly dateText?: string;
}

/** Near-black architectural ink — the sheet is always a white print sheet
 * (theme-agnostic), so the poché stays near-black in every app theme. */
const INK = '#111111';
/** Yellow-tinted poché for walls mostly interpolated by gap-closing. */
const WEAK_INK = '#8f750f';
const DIM = '#6a6f78';
const FLOOR_FILL = '#f1f3f6';
const FLOOR_STROKE = '#d4d9e0';
const CONTENTS_FILL = '#dde2e9';
const CONTENTS_STROKE = '#bfc6d0';
const WARN = '#8a2f1e';

/**
 * Minimum RENDERED wall (poché) thickness, metres. A typical stud wall is
 * ≥ ~0.09 m; the trace's 5 cm cell-floor strip reads toy-like at sheet scale,
 * so the drawn poché is rounded UP to this minimum (the stroke symmetrically
 * widens the traced strip). The MEASURED thickness stays in the footer —
 * rendering convention, never a measurement claim.
 */
export const MIN_WALL_RENDER_M = 0.1;

/** Gutter (px) reserved above / left of the plan for the dimension lines. */
const DIM_GUTTER = 18;

/** Floor-fill regions smaller than this (m²) carry no in-plan area label. */
export const MIN_ROOM_LABEL_M2 = 3;

/**
 * Draw the furniture / contents islands the extractor lifted out of the wall
 * poché as light grey hints (the architectural convention for loose room
 * contents). Set to false to omit them from the sheet entirely — they are
 * never drawn as walls either way.
 */
export const SHOW_CONTENTS_HINTS = true;

/**
 * Reconcile the gross floor-region ring areas to the net scanned floor area.
 *
 * The region rings are vectorised from the CLOSED, simplified floor mask (holes
 * healed, boundary rounded outward), so their summed polygon area is a GROSS
 * extent that can exceed `floorAreaM2` (measured on the OPEN presence mask —
 * net scanned cells). A region breakdown that sums to MORE than the stated
 * floor area is incoherent, so we return a single multiplicative factor (≤ 1)
 * that scales every region down proportionally to make the breakdown sum equal
 * the floor area. Returns 1 when there is nothing to reconcile (no floor area,
 * no regions, or the raw sum already fits within the floor area) — the factor
 * never scales a region UP.
 */
export function regionAreaReconcileScale(
  rawRegionAreasM2: readonly number[],
  floorAreaM2: number | null,
): number {
  if (floorAreaM2 == null || floorAreaM2 <= 0 || rawRegionAreasM2.length === 0) return 1;
  let sum = 0;
  for (const a of rawRegionAreasM2) sum += a;
  if (sum <= floorAreaM2 || sum <= 0) return 1;
  return floorAreaM2 / sum;
}

/** XML-escape a string for safe insertion into SVG text / attributes. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Greedy word-wrap (the footer has no DOM to measure text with). */
function wrapText(s: string, maxChars: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (cand.length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = cand;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A round-number scale-bar length ≤ maxLen, in the bar's own unit. */
function niceBar(maxLen: number): number {
  if (maxLen <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(maxLen)));
  for (const mult of [5, 2, 1]) {
    const v = mult * pow;
    if (v <= maxLen) return v;
  }
  return pow;
}

/** "10.0 m (32.8 ft)" or "32.8 ft (10.0 m)" per unit system. */
function lengthLabel(metres: number, unitSystem: PlanUnitSystem): string {
  const ft = metresToFeet(metres);
  return unitSystem === 'imperial'
    ? `${ft.toFixed(1)} ft (${metres.toFixed(1)} m)`
    : `${metres.toFixed(1)} m (${ft.toFixed(1)} ft)`;
}

/** "141.0 m² (1518 sq ft)" or "1518 sq ft (141.0 m²)" per unit system. */
function areaLabel(m2: number, unitSystem: PlanUnitSystem): string {
  const sf = sqMetresToSqFeet(m2);
  return unitSystem === 'imperial'
    ? `${sf.toFixed(0)} sq ft (${m2.toFixed(1)} m²)`
    : `${m2.toFixed(1)} m² (${sf.toFixed(0)} sq ft)`;
}

/** A 45° dimension tick (architectural convention) centred on (x, y). */
function dimTick(x: number, y: number): string {
  const t = 3.2;
  return `M${(x - t).toFixed(1)} ${(y + t).toFixed(1)} L${(x + t).toFixed(1)} ${(y - t).toFixed(1)} `;
}

/** Build one SVG path `d` string from a set of rings (closed subpaths). */
function ringsPath(rings: ReadonlyArray<Ring>, px: (x: number) => number, py: (y: number) => number): string {
  let d = '';
  for (const ring of rings) {
    ring.forEach((p, i) => {
      d += `${i === 0 ? 'M' : 'L'}${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)} `;
    });
    d += 'Z ';
  }
  return d.trim();
}

/** Area-weighted centroid of a simple polygon ring (plan metres). */
function ringCentroid(ring: Ring): readonly [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const w = x1 * y2 - x2 * y1;
    a += w;
    cx += (x1 + x2) * w;
    cy += (y1 + y2) * w;
  }
  if (Math.abs(a) < 1e-12) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Ray-cast point-in-polygon (plan metres). Boundary cases need no rigour
 * here — the test only decides label placement / hole grouping. */
function pointInRing(p: readonly [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Short single-unit area text: "12.3 m²" or "132 sq ft" per unit system. */
function areaShort(m2: number, unitSystem: PlanUnitSystem): string {
  return unitSystem === 'imperial'
    ? `${sqMetresToSqFeet(m2).toFixed(0)} sq ft`
    : `${m2.toFixed(1)} m²`;
}

/**
 * Render the floor-plan sheet to an SVG string. Plan-metre coordinates fit a
 * padded drawing area with Y flipped (up = +h2 in the scan's own local frame
 * — NOT true north; the footer says so).
 */
export function floorPlanSvg(model: FloorPlanModel, opts: FloorPlanSvgOptions = {}): string {
  const W = Math.max(360, Math.floor(opts.width ?? 720));
  const unitSystem: PlanUnitSystem = opts.unitSystem === 'imperial' ? 'imperial' : 'metric';
  const titleH = 54;
  const pad = 36;
  const [minX, minY, maxX, maxY] = model.bbox;
  const planW = Math.max(1e-6, maxX - minX);
  const planD = Math.max(1e-6, maxY - minY);

  // Rendered-poché rounding (see MIN_WALL_RENDER_M): computed up front so the
  // footer can carry the honest note when the rounding fires.
  const measuredWallM = model.wallThicknessM ?? Math.max(model.cellSizeM, 0.05);
  const pocheRounded = model.wallRings.length > 0 && measuredWallM < MIN_WALL_RENDER_M;

  // ── Wall confidence partition: OUTER rings observed below the threshold
  //    render as yellow-tinted poché ("interpolated from sparse evidence");
  //    hole rings follow their containing outer so punching stays correct.
  //    Coarse and honest — a boundary-sample statistic, not survey confidence. ──
  const fracs = model.wallRingObservedFrac;
  const hasFracs = fracs.length === model.wallRings.length;
  const strongRings: Ring[] = [];
  const weakRings: Ring[] = [];
  {
    const outers: number[] = [];
    const holesIdx: number[] = [];
    model.wallRings.forEach((r, i) => (ringSignedArea(r) > 0 ? outers : holesIdx).push(i));
    const weakOuter = new Set(
      outers.filter((i) => hasFracs && fracs[i] < OBSERVED_FRAC_MIN),
    );
    if (weakOuter.size === 0) {
      strongRings.push(...model.wallRings);
    } else {
      for (const i of outers) {
        (weakOuter.has(i) ? weakRings : strongRings).push(model.wallRings[i]);
      }
      for (const h of holesIdx) {
        const p = model.wallRings[h][0];
        let best = -1, bestA = Infinity;
        for (const o of outers) {
          if (!pointInRing(p, model.wallRings[o])) continue;
          const a = ringSignedArea(model.wallRings[o]);
          if (a < bestA) { bestA = a; best = o; }
        }
        (best >= 0 && weakOuter.has(best) ? weakRings : strongRings).push(model.wallRings[h]);
      }
    }
  }

  // ── Approximate floor-region areas (the floor-fill regions the extractor
  //    kept — scanned-floor extents, NOT wall-graph rooms; said so below).
  //    Only labelled when NO segmented rooms exist — once roomDetect.ts has
  //    real wall-bounded rooms, those carry the labels and the schedule. ──
  //
  //    Coherence guard (v0.4.6): the region rings are vectorised from the
  //    CLOSED, simplified floor mask — closing heals furniture/occlusion holes
  //    and simplification rounds the boundary OUTWARD, so the rings' polygon
  //    area is a GROSS extent that can (and did: 106.6 m² vs a 94.4 m² floor)
  //    exceed the headline `floorAreaM2`, which is measured on the OPEN
  //    presence mask (net scanned cells). A region sum larger than the stated
  //    floor area is incoherent on an honesty-first sheet. When the raw region
  //    sum overshoots the net floor area we scale every region proportionally
  //    so the breakdown sums to the floor area exactly — the relative extents
  //    (which region is bigger) stay honest, and no figure ever exceeds the
  //    headline. Never scales UP (a smaller-than-floor sum is left as-is).
  const rawRegionAreasM2 =
    model.rooms.length > 0 || model.roomSegmentation === 'open-space'
      ? []
      : model.floorRings.map((r) => Math.abs(ringSignedArea(r))).filter((a) => a > 0.01);
  // One scale factor (≤ 1) reconciling the gross region rings to the net floor
  // area — applied to BOTH the footer sum and the in-plan per-region labels so
  // the sheet never shows two different areas for the same region.
  const regionAreaScale = regionAreaReconcileScale(rawRegionAreasM2, model.floorAreaM2);
  const regionAreasM2 = rawRegionAreasM2.map((a) => a * regionAreaScale);

  // The standing experimental note leads the footer — the sheet must carry the
  // same caveat the panel button shows.
  const footerReasons: string[] = [
    'Experimental — requires visual validation.',
    ...model.reasons,
  ];
  if (pocheRounded) {
    footerReasons.push(
      `Wall poché drawn at the ${MIN_WALL_RENDER_M.toFixed(2)} m architectural minimum for legibility — measured thickness ~${measuredWallM.toFixed(2)} m.`,
    );
  }
  if (regionAreasM2.length > 0) {
    footerReasons.push(
      `Approx. region areas (scanned-floor extents, not wall-measured rooms): ${regionAreasM2
        .map((a) => areaShort(a, unitSystem))
        .join(', ')}.`,
    );
  }
  // Room schedule (rooms from the wall-graph flood fill — areas measured on
  // the region mask, doors kept distinct, unknown gaps never closed). Printed
  // ONLY for the 'rooms' outcome — the open-space / unsegmented cases print an
  // honest single line instead of a fabricated numbered schedule.
  if (model.rooms.length > 0) {
    footerReasons.push(
      `Room schedule (flood-fill of the wall graph, approx.): ${model.rooms
        .map((r, i) => `Room ${i + 1} ${areaShort(r.areaM2, unitSystem)}`)
        .join(' · ')}.`,
    );
  } else if (model.roomSegmentation === 'open-space') {
    footerReasons.push(
      `Single open space (no interior partitions reliably segmented): ~${areaShort(model.openSpaceAreaM2, unitSystem)}.`,
    );
  }
  if (weakRings.length > 0) {
    footerReasons.push(
      `Tinted walls: interpolated from sparse evidence — under ${Math.round(OBSERVED_FRAC_MIN * 100)}% of their outline is backed by raw wall returns (morphological gap-closing filled the rest).`,
    );
  }

  // Footer: dims + scale bar + frame note + (wrapped) reasons. Wrap width is
  // sized for ~5.2 px/char at the footer font over the sheet's inner width.
  const wrapChars = Math.max(40, Math.floor((W - 2 * pad) / 5.2));
  const reasonLines = footerReasons.flatMap((r) => wrapText(r, wrapChars));
  const footerH = 64 + reasonLines.length * 14;

  const drawW = W - 2 * pad;
  // The dimension lines live in a gutter above / left of the plan.
  const drawTop = titleH + DIM_GUTTER;
  const targetDrawH = Math.max(180, Math.round(drawW * (planD / planW)));
  const drawH = Math.min(560, targetDrawH);
  const scale = Math.min(drawW / planW, drawH / planD);
  const usedW = planW * scale;
  const usedH = planD * scale;
  const offX = pad + (drawW - usedW) / 2;
  const offY = drawTop + (drawH - usedH) / 2;
  // A real sheet carries a title block bottom-right (title / dims / area /
  // scale / date); the honest empty sheet does not pretend to be a sheet.
  const titleBlockH = model.wallRings.length > 0 ? 88 : 0;
  const totalH = drawTop + drawH + footerH + titleBlockH;

  // plan-metre (x east, y north) → SVG px (y flipped so +h2 is up).
  const px = (x: number): number => offX + (x - minX) * scale;
  const py = (y: number): number => offY + (maxY - y) * scale;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" font-family="Helvetica, Arial, sans-serif">`,
  );
  parts.push(`<rect x="0" y="0" width="${W}" height="${totalH}" fill="#ffffff"/>`);

  // ── Title ──
  const title = escapeXml((opts.title ?? 'Floor plan preview').trim() || 'Floor plan preview');
  parts.push(`<text x="${pad}" y="28" font-size="18" font-weight="bold" fill="${INK}">${title}</text>`);
  // Claim-accurate subtitle: "wall-graph reconstruction" only when the walls
  // really were re-extruded from the centerline graph; still a preview.
  parts.push(
    `<text x="${pad}" y="46" font-size="11" fill="${DIM}">Floor Plan Preview — ${
      model.fromWallGraph ? 'wall-graph reconstruction' : 'approximate wall-trace sketch'
    } (top-down)</text>`,
  );

  if (model.wallRings.length === 0) {
    parts.push(
      `<text x="${pad}" y="${drawTop + 40}" font-size="12" fill="${WARN}">No wall structure could be traced from this scan.</text>`,
    );
  } else {
    // ── Scanned-floor interior (light), under the walls ──
    if (model.floorRings.length > 0) {
      parts.push(
        `<path d="${ringsPath(model.floorRings, px, py)}" fill="${FLOOR_FILL}" stroke="${FLOOR_STROKE}" stroke-width="0.75" stroke-linejoin="round"/>`,
      );
    }
    // ── Furniture / contents hints (light grey, under the walls) ──
    if (SHOW_CONTENTS_HINTS && model.contentRings.length > 0) {
      parts.push(
        `<path d="${ringsPath(model.contentRings, px, py)}" fill="${CONTENTS_FILL}" stroke="${CONTENTS_STROKE}" stroke-width="0.75" stroke-linejoin="round"/>`,
      );
    }
    // ── Wall poché: ALL wall rings in one nonzero-winding fill, so wall
    //    strips render solid with their holes punched and every door gap in
    //    the mask stays a real white gap on the sheet. The stroke widens the
    //    traced strip symmetrically so the RENDERED wall thickness rounds up
    //    to the 0.10 m architectural minimum (MIN_WALL_RENDER_M) — a 5 cm
    //    cell-floor trace reads toy-like otherwise. Geometry is untouched, a
    //    1 m doorway loses at most ~2.5 cm per jamb, the measured thickness
    //    stays in the footer, and walls already at/above the minimum keep a
    //    hairline outline only. ──
    const renderWallM = Math.max(measuredWallM, MIN_WALL_RENDER_M);
    const strokeWallM = pocheRounded ? renderWallM - measuredWallM : 0.02;
    const wallStrokePx = Math.max(1, Math.min(6, strokeWallM * scale));
    if (strongRings.length > 0) {
      parts.push(
        `<path class="wall-poche" d="${ringsPath(strongRings, px, py)}" fill="${INK}" stroke="${INK}" stroke-width="${wallStrokePx.toFixed(2)}" stroke-linejoin="round"/>`,
      );
    }
    // Yellow-tinted poché: rings whose outline is mostly gap-closing
    // interpolation, not observed returns (see the footer note).
    if (weakRings.length > 0) {
      parts.push(
        `<path class="wall-weak" d="${ringsPath(weakRings, px, py)}" fill="${WEAK_INK}" stroke="${WEAK_INK}" stroke-width="${wallStrokePx.toFixed(2)}" stroke-linejoin="round"/>`,
      );
    }
    // ── Door-leaf symbols: one quarter-circle swing arc per CLASSIFIED
    //    doorway (jamb evidence on both sides) — leaf from one jamb, radius =
    //    clear gap width, opening toward the plan centre. A drawing symbol
    //    (approximate by design), not a hinge-side or swing claim. ──
    if (model.doorways.length > 0) {
      const cxm = (minX + maxX) / 2;
      const cym = (minY + maxY) / 2;
      const arcs: string[] = [];
      for (const g of model.doorways) {
        const w = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
        if (!(w > 0)) continue;
        const ux = (g.b[0] - g.a[0]) / w, uy = (g.b[1] - g.a[1]) / w;
        // Perpendicular toward the plan centre — doors usually draw opening
        // into the room; with no room graph this is the honest approximation.
        let nx = -uy, ny = ux;
        if ((cxm - g.a[0]) * nx + (cym - g.a[1]) * ny < 0) { nx = -nx; ny = -ny; }
        const tip: readonly [number, number] = [g.a[0] + nx * w, g.a[1] + ny * w];
        const ax = px(g.a[0]), ay = py(g.a[1]);
        const bx = px(g.b[0]), by = py(g.b[1]);
        const tx = px(tip[0]), ty = py(tip[1]);
        // Sweep so the arc bulges away from the hinge jamb (screen coords).
        const cross = (tx - ax) * (by - ay) - (ty - ay) * (bx - ax);
        const sweep = cross > 0 ? 1 : 0;
        const r = (w * scale).toFixed(1);
        arcs.push(
          `<path class="door-arc" d="M${ax.toFixed(1)} ${ay.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} A${r} ${r} 0 0 ${sweep} ${bx.toFixed(1)} ${by.toFixed(1)}"/>`,
        );
      }
      if (arcs.length > 0) {
        parts.push(
          `<g class="door-arcs" fill="none" stroke="${INK}" stroke-width="0.9">${arcs.join('')}</g>`,
        );
      }
    }
    // ── Unknown wall gaps: facing wall ends WITHOUT square jamb evidence —
    //    unscanned or unclassifiable. Drawn as a light dashed line so the
    //    plan reads "the wall may continue here, the scan can't say";
    //    classified doorways stay genuine openings (nothing drawn). ──
    if (model.unknownGaps.length > 0) {
      let d = '';
      for (const g of model.unknownGaps) {
        d += `M${px(g.a[0]).toFixed(1)} ${py(g.a[1]).toFixed(1)} L${px(g.b[0]).toFixed(1)} ${py(g.b[1]).toFixed(1)} `;
      }
      parts.push(
        `<path d="${d.trim()}" fill="none" stroke="${DIM}" stroke-width="1.4" stroke-dasharray="5 4" stroke-linecap="round"/>`,
      );
    }
    // ── Dimension lines (architectural convention): overall width above the
    //    plan and overall depth on its left — extension lines off the plan
    //    corners, 45° tick marks at the dimension-line ends, the measurement
    //    written on the line. Same numbers as the footer's "Overall" line. ──
    const x0 = px(minX), x1 = px(maxX);
    const yT = py(maxY), yB = py(minY);
    const dimY = offY - 12;
    const dimX = offX - 12;
    let dd = '';
    dd += `M${x0.toFixed(1)} ${(yT - 2).toFixed(1)} L${x0.toFixed(1)} ${(dimY - 4).toFixed(1)} `;
    dd += `M${x1.toFixed(1)} ${(yT - 2).toFixed(1)} L${x1.toFixed(1)} ${(dimY - 4).toFixed(1)} `;
    dd += `M${x0.toFixed(1)} ${dimY.toFixed(1)} L${x1.toFixed(1)} ${dimY.toFixed(1)} `;
    dd += dimTick(x0, dimY) + dimTick(x1, dimY);
    dd += `M${(x0 - 2).toFixed(1)} ${yT.toFixed(1)} L${(dimX - 4).toFixed(1)} ${yT.toFixed(1)} `;
    dd += `M${(x0 - 2).toFixed(1)} ${yB.toFixed(1)} L${(dimX - 4).toFixed(1)} ${yB.toFixed(1)} `;
    dd += `M${dimX.toFixed(1)} ${yT.toFixed(1)} L${dimX.toFixed(1)} ${yB.toFixed(1)} `;
    dd += dimTick(dimX, yT) + dimTick(dimX, yB);
    const dimLabelY = (dimY - 4).toFixed(1);
    const depthLabelX = (dimX - 4).toFixed(1);
    const depthLabelY = ((yT + yB) / 2).toFixed(1);
    parts.push(`<g class="plan-dims"><path d="${dd.trim()}" fill="none" stroke="${INK}" stroke-width="0.55"/>`);
    parts.push(
      `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${dimLabelY}" font-size="10" text-anchor="middle" fill="${INK}">${escapeXml(lengthLabel(model.widthM, unitSystem))}</text>`,
    );
    parts.push(
      `<text x="${depthLabelX}" y="${depthLabelY}" font-size="10" text-anchor="middle" fill="${INK}" transform="rotate(-90 ${depthLabelX} ${depthLabelY})">${escapeXml(lengthLabel(model.depthM, unitSystem))}</text></g>`,
    );
    // ── Room labels: "Room N · 12.3 m²" at each segmented room's pole of
    //    inaccessibility (roomDetect.ts guarantees the anchor is inside the
    //    region, so no centroid check is needed). Drawn only when the text
    //    fits the room's extent; the footer schedule always carries the full
    //    list, so a too-small room loses its in-plan label, not its claim. ──
    if (model.rooms.length > 0) {
      const labels: string[] = [];
      model.rooms.forEach((room, i) => {
        const txt = `Room ${i + 1} · ${areaShort(room.areaM2, unitSystem)}`;
        const wPx = txt.length * 5.6 + 6;
        let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
        for (const [x, y] of room.ring) {
          if (x < rMinX) rMinX = x;
          if (x > rMaxX) rMaxX = x;
          if (y < rMinY) rMinY = y;
          if (y > rMaxY) rMaxY = y;
        }
        if ((rMaxX - rMinX) * scale < wPx || (rMaxY - rMinY) * scale < 14) return;
        labels.push(
          `<text x="${px(room.label[0]).toFixed(1)}" y="${(py(room.label[1]) + 3.5).toFixed(1)}" text-anchor="middle">${escapeXml(txt)}</text>`,
        );
      });
      if (labels.length > 0) {
        parts.push(
          `<g class="room-labels" font-size="10" font-weight="bold" fill="#2c3640">${labels.join('')}</g>`,
        );
      }
    }
    // ── Approximate region area labels, centred in floor-fill regions large
    //    enough to carry them (≥ MIN_ROOM_LABEL_M2 and the text fits inside
    //    the region's extent with its centroid inside the polygon). These are
    //    scanned-floor regions, not wall-graph rooms — the footer says so.
    //    Skipped when real rooms exist (their labels supersede these). ──
    // Open-space label: ONE honest "Open space · ~N m²" at the largest
    // floor-fill region's interior point, in place of the scattered region
    // areas — the floor is essentially one connected space, not many rooms.
    if (model.rooms.length === 0 && model.roomSegmentation === 'open-space') {
      let big: Ring | null = null;
      let bigA = 0;
      for (const ring of model.floorRings) {
        const a = ringSignedArea(ring);
        if (a > bigA) { bigA = a; big = ring; }
      }
      if (big) {
        const c = ringCentroid(big);
        const anchor = pointInRing(c, big) ? c : big[0];
        const txt = `Open space · ~${areaShort(model.openSpaceAreaM2, unitSystem)}`;
        parts.push(
          `<g class="room-labels open-space" font-size="11" font-weight="bold" fill="#2c3640"><text x="${px(anchor[0]).toFixed(1)}" y="${(py(anchor[1]) + 4).toFixed(1)}" text-anchor="middle">${escapeXml(txt)}</text></g>`,
        );
      }
    }
    // Approximate region-area labels — only for the 'unsegmented' fallback
    // (no rooms, no dominant open space). The 'rooms' and 'open-space' cases
    // carry their own labels above.
    if (model.rooms.length === 0 && model.roomSegmentation === 'unsegmented') {
      const labels: string[] = [];
      for (const ring of model.floorRings) {
        // Same reconcile scale as the footer sum — the in-plan label and the
        // footer must report one coherent area per region (never > floor area).
        const aM2 = Math.abs(ringSignedArea(ring)) * regionAreaScale;
        if (aM2 < MIN_ROOM_LABEL_M2) continue;
        const c = ringCentroid(ring);
        if (!pointInRing(c, ring)) continue; // centroid outside a concave region
        const txt = `≈ ${areaShort(aM2, unitSystem)}`;
        // Fit check (no DOM to measure with): ~5.6 px/char at font 10.
        const wPx = txt.length * 5.6 + 6;
        let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < rMinX) rMinX = x;
          if (x > rMaxX) rMaxX = x;
          if (y < rMinY) rMinY = y;
          if (y > rMaxY) rMaxY = y;
        }
        if ((rMaxX - rMinX) * scale < wPx || (rMaxY - rMinY) * scale < 14) continue;
        labels.push(
          `<text x="${px(c[0]).toFixed(1)}" y="${(py(c[1]) + 3.5).toFixed(1)}" text-anchor="middle">${escapeXml(txt)}</text>`,
        );
      }
      if (labels.length > 0) {
        parts.push(
          `<g class="room-areas" font-size="10" fill="#3c4753">${labels.join('')}</g>`,
        );
      }
    }
  }

  // ── Overall dimensions (primary unit per the caller's unit system) ──
  // Empty model ⇒ no dims line and no scale bar: a 0.0 m × 0.0 m label and a
  // bar scaled off the degenerate 1e-6 bbox guard (it would read "2e-7 m")
  // are fabricated figures on a sheet whose whole point is honesty.
  let sheetBarText = '';
  if (model.wallRings.length > 0) {
    const dimY = drawTop + drawH + 26;
    // Floor area: from the scanned-floor presence mask (the floor-fill
    // polygon's own region) — NEVER the bbox product, which would overstate
    // an L-shaped or partially scanned interior.
    const floorAreaTxt =
      model.floorAreaM2 != null
        ? ` · Floor area ${escapeXml(areaLabel(model.floorAreaM2, unitSystem))}`
        : '';
    parts.push(
      `<text x="${pad}" y="${dimY}" font-size="12" fill="${INK}">Overall ${escapeXml(lengthLabel(model.widthM, unitSystem))} x ${escapeXml(lengthLabel(model.depthM, unitSystem))}${floorAreaTxt}</text>`,
    );

    // ── Scale bar (round number in the primary unit) ──
    const maxBarM = Math.max(planW, planD) / 4;
    if (maxBarM > 0 && scale > 0) {
      let barLen: number, barM: number, barText: string;
      if (unitSystem === 'imperial') {
        barLen = niceBar(metresToFeet(maxBarM));
        barM = barLen * 0.3048;
        barText = `${barLen} ft`;
      } else {
        barLen = niceBar(maxBarM);
        barM = barLen;
        barText = `${barLen} m`;
      }
      if (barLen > 0) sheetBarText = barText;
      if (barLen > 0) {
        const barPx = barM * scale;
        const bx = W - pad - barPx;
        const by = drawTop + drawH + 18;
        parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barPx.toFixed(1)}" height="6" fill="${INK}"/>`);
        parts.push(
          `<text x="${(bx + barPx).toFixed(1)}" y="${(by - 4).toFixed(1)}" font-size="10" text-anchor="end" fill="${INK}">${escapeXml(barText)}</text>`,
        );
      }
    }
  }

  // ── Local-frame note + the model's honesty caveats ──
  let fy = drawTop + drawH + 46;
  parts.push(
    `<text x="${pad}" y="${fy}" font-size="10" fill="${DIM}">Orientation: local scan frame — not aligned to true north.</text>`,
  );
  fy += 17;
  for (const reason of footerReasons) {
    // The suitability + experimental caveats must never be skimmed past.
    const warn = /not for construction|no plan extracted|requires visual validation/i.test(reason);
    for (const line of wrapText(reason, wrapChars)) {
      parts.push(
        `<text x="${pad}" y="${fy}" font-size="${warn ? 10 : 9.5}" ${warn ? 'font-weight="bold"' : ''} fill="${warn ? WARN : DIM}">${escapeXml(line)}</text>`,
      );
      fy += 14;
    }
  }

  // ── Title block (bottom-right, like a real sheet): title / overall dims /
  //    area / scale / date. The scale ratio is NOMINAL (96 dpi CSS pixels) —
  //    the graphic bar above is the trustworthy scale reference. ──
  if (model.wallRings.length > 0) {
    const tbW = 232;
    const tbH = 76;
    const tbX = W - pad - tbW;
    const tbY = totalH - tbH - 8;
    const rawTitle = (opts.title ?? 'Floor plan preview').trim() || 'Floor plan preview';
    const tbTitle = rawTitle.length > 34 ? `${rawTitle.slice(0, 33)}…` : rawTitle;
    // 1 m = 96/0.0254 CSS px at 1:1 ⇒ nominal ratio = 3779.5 / (px per m).
    const ratio = scale > 0 ? Math.max(5, Math.round(3779.5 / scale / 5) * 5) : 0;
    const scaleTxt =
      (ratio > 0 ? `Scale ~1:${ratio} (nominal)` : 'Scale: see bar') +
      (sheetBarText ? ` · bar ${sheetBarText}` : '');
    const dateTxt = (opts.dateText ?? new Date().toISOString().slice(0, 10)).trim();
    const areaTxt =
      model.floorAreaM2 != null
        ? `Floor area ${areaLabel(model.floorAreaM2, unitSystem)} (approx.)`
        : 'Floor area: not measured';
    parts.push(
      `<g class="title-block">` +
        `<rect x="${tbX}" y="${tbY}" width="${tbW}" height="${tbH}" fill="#ffffff" stroke="${INK}" stroke-width="1"/>` +
        `<line x1="${tbX}" y1="${tbY + 21}" x2="${tbX + tbW}" y2="${tbY + 21}" stroke="${INK}" stroke-width="0.55"/>` +
        `<text x="${tbX + 8}" y="${tbY + 15}" font-size="11" font-weight="bold" fill="${INK}">${escapeXml(tbTitle)}</text>` +
        `<text x="${tbX + 8}" y="${tbY + 34}" font-size="8.5" fill="${INK}">${escapeXml(`Overall ${lengthLabel(model.widthM, unitSystem)} x ${lengthLabel(model.depthM, unitSystem)}`)}</text>` +
        `<text x="${tbX + 8}" y="${tbY + 46}" font-size="8.5" fill="${INK}">${escapeXml(areaTxt)}</text>` +
        `<text x="${tbX + 8}" y="${tbY + 58}" font-size="8.5" fill="${INK}">${escapeXml(scaleTxt)}</text>` +
        `<text x="${tbX + 8}" y="${tbY + 70}" font-size="8.5" fill="${DIM}">${escapeXml(`${dateTxt} · Floor plan preview — not for construction`)}</text>` +
        `</g>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}
