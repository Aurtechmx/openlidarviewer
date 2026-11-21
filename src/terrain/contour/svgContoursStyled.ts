/**
 * svgContoursStyled.ts: the contour SVG in the Light and Dark sheet styles,
 * the vector counterpart of the styled map sheet PDF. The relief raster is
 * embedded as a PNG data URL (encoded by the caller, since encoding is
 * asynchronous and this module is not), the footprint outline and spot heights
 * are vector, and contour strokes and colours come from the same tokens and
 * stroke rules as the PDF.
 *
 * Pure data: no DOM, no I/O. Returns an SVG string. The Classic SVG is still
 * `svgContours`, unchanged.
 */
import {
  contourBasis,
  contourLineKind,
  modelLengthShares,
  type ContourFeatureModel,
  type ContourLineKind,
} from './contourFeatureModel';
import { contourShareLine } from './evidenceGrade';
import { decimalsForInterval, type ContourLabel } from './labelPlacement';
import { contourShapeStyleLabel } from './contourShapeStyle';
import { provenanceLines, type ExportProvenance } from '../export/exportProvenance';
import { NOT_SURVEY_GRADE_NOTE } from '../export/exportNotes';
import { formatScaleTick } from './mapSheetLayout';
import { MAP_TARGET_PX, commentText, niceRound, titleLines, xmlEscape } from './svgContours';
import { cssColor, type SheetTokens } from '../../export/sheetKit/tokens';
import { styledContourStroke, type SpotHeight } from '../../export/sheetKit/contourSheetModel';

/** The relief and footprint drawn under the contours, in the SVG's export frame. */
export interface SvgSheetRelief {
  /** `data:image/png;base64,...`, north at the top, transparent outside the footprint. */
  readonly href: string;
  readonly extent: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  readonly outline: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  readonly hasHoles: boolean;
  readonly highest: SpotHeight | null;
  readonly lowest: SpotHeight | null;
}

export interface SvgStyledParams {
  readonly tokens: SheetTokens;
  readonly relief?: SvgSheetRelief | null;
  readonly labels?: ReadonlyArray<ContourLabel>;
  readonly provenance?: ExportProvenance;
  /** Abbreviation of the drawing's linear unit for the scale bar. Default 'm'. */
  readonly unitLabel?: string;
  /** Value added to spot heights so they read in the label frame (the vertical origin). */
  readonly spotHeightOffset?: number;
}

const SANS = "font-family=\"Figtree, 'Helvetica Neue', Arial, sans-serif\"";
const MONO = "font-family=\"'Courier New', Courier, monospace\"";

function strokeAttrs(t: SheetTokens, isIndex: boolean, kind: ContourLineKind, k: number): string {
  const st = styledContourStroke(t, isIndex, kind);
  const dash = st.dash ? ` stroke-dasharray="${st.dash.map((d) => (d * k).toFixed(2)).join(' ')}"` : '';
  return `stroke="${cssColor(st.color)}" stroke-width="${(st.width * k).toFixed(3)}" fill="none" stroke-opacity="${st.opacity}"${dash}`;
}

/** Render the contour model as a Light or Dark SVG sheet. */
export function svgContoursStyled(model: ContourFeatureModel, params: SvgStyledParams): string {
  const t = params.tokens;
  const prov = params.provenance;
  const unit = params.unitLabel ?? 'm';
  const margin = 28;
  // Strokes are in page points in the token table; the SVG canvas is ~880 px
  // across, about 1.3 px per point on a letter-wide map.
  const k = 1.3;
  const labelSize = 9;
  const ink = cssColor(t.ink), dim = cssColor(t.dim);

  const provStamp = prov
    ? `<metadata><!--${commentText(`\n${provenanceLines(prov).map(xmlEscape).join('\n')}\n`)}--></metadata>`
    : `<!--${commentText(` contour style: ${contourShapeStyleLabel(model.contourStyle)} `)}-->`;
  const rel = params.relief ?? null;
  const box = rel?.extent ?? model.bbox;
  if (!box || (model.features.length === 0 && !rel)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1">${provStamp}</svg>`;
  }
  const worldW = Math.max(box.maxX - box.minX, 1e-6);
  const worldH = Math.max(box.maxY - box.minY, 1e-6);
  const scale = MAP_TARGET_PX / Math.max(worldW, worldH);
  const mapW = worldW * scale, mapH = worldH * scale;
  const sx = (x: number): number => margin + (x - box.minX) * scale;
  const sy = (y: number): number => margin + (box.maxY - y) * scale;

  const out: string[] = [];
  // ── relief and footprint ─────────────────────────────────────────────────
  if (rel) {
    out.push(
      `  <image x="${sx(rel.extent.minX).toFixed(2)}" y="${sy(rel.extent.maxY).toFixed(2)}" ` +
        `width="${((rel.extent.maxX - rel.extent.minX) * scale).toFixed(2)}" height="${((rel.extent.maxY - rel.extent.minY) * scale).toFixed(2)}" ` +
        `preserveAspectRatio="none" href="${rel.href}"/>`,
    );
    for (const ring of rel.outline) {
      if (ring.length < 3) continue;
      const d = ring.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)} ${sy(y).toFixed(2)}`).join(' ');
      out.push(`  <path d="${d} Z" fill="none" stroke="${cssColor(t.outline)}" stroke-width="${(t.weight.outline * 0.75 * k).toFixed(3)}" stroke-opacity="0.8" data-layer="footprint"/>`);
    }
  }
  // ── contours, ordinary first ─────────────────────────────────────────────
  const ordered = [...model.features.filter((f) => !f.isIndex), ...model.features.filter((f) => f.isIndex)];
  for (const f of ordered) {
    if (f.coordinates.length < 2) continue;
    let d = '';
    f.coordinates.forEach(([x, y], i) => { d += `${i === 0 ? 'M' : ' L'}${sx(x).toFixed(2)} ${sy(y).toFixed(2)}`; });
    if (f.closed) d += ' Z';
    out.push(
      `  <path d="${d}" ${strokeAttrs(t, f.isIndex, contourLineKind(f), k)} data-elevation="${f.value}" ` +
        `data-grade="${f.grade}" data-basis="${contourBasis(f)}"/>`,
    );
  }
  // ── labels on a halo ─────────────────────────────────────────────────────
  const dec = decimalsForInterval(model.intervalM);
  for (const lab of params.labels ?? []) {
    const lx = sx(lab.x).toFixed(2), ly = sy(lab.y).toFixed(2);
    let deg = (-lab.angleRad * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    else if (deg < -90) deg += 180;
    out.push(
      `  <text x="${lx}" y="${ly}" transform="rotate(${deg.toFixed(2)} ${lx} ${ly})" font-size="${labelSize}" font-weight="600" ` +
        `text-anchor="middle" dominant-baseline="middle" ${SANS} ` +
        `paint-order="stroke" stroke="${cssColor(t.halo)}" stroke-width="${(labelSize * 0.3).toFixed(2)}" fill="${cssColor(t.contourLabel)}">${lab.value.toFixed(dec)}</text>`,
    );
  }
  // ── spot heights ─────────────────────────────────────────────────────────
  const oz = params.spotHeightOffset ?? 0;
  const spot = (p: SpotHeight | null, up: boolean): void => {
    if (!p) return;
    const x = sx(p.x), y = sy(p.y), r = 4;
    const pts = up
      ? `${x.toFixed(2)},${(y - r).toFixed(2)} ${(x + r).toFixed(2)},${(y + r * 0.8).toFixed(2)} ${(x - r).toFixed(2)},${(y + r * 0.8).toFixed(2)}`
      : `${x.toFixed(2)},${(y + r).toFixed(2)} ${(x + r).toFixed(2)},${(y - r * 0.8).toFixed(2)} ${(x - r).toFixed(2)},${(y - r * 0.8).toFixed(2)}`;
    out.push(`  <polygon points="${pts}" fill="${ink}" data-layer="${up ? 'highest' : 'lowest'}"/>`);
    out.push(
      `  <text x="${(x + 6).toFixed(2)}" y="${(y + 3).toFixed(2)}" font-size="8" ${MONO} fill="${ink}" ` +
        `paint-order="stroke" stroke="${cssColor(t.halo)}" stroke-width="2.4">${(p.z + oz).toFixed(1)}</text>`,
    );
  };
  if (rel) { spot(rel.highest, true); spot(rel.lowest, false); }

  // ── marginalia ───────────────────────────────────────────────────────────
  const tLines = titleLines(model, prov, unit, dec);
  type Row = [string, string];
  const legendRows: Row[] = [];
  const kinds = new Set(model.features.map((f) => contourLineKind(f)));
  legendRows.push([strokeAttrs(t, true, 'measured', k), 'Index contour, labelled']);
  legendRows.push([strokeAttrs(t, false, 'measured', k), 'Contour']);
  if (kinds.has('sparse')) legendRows.push([strokeAttrs(t, false, 'sparse', k), 'Sparse measured ground']);
  if (kinds.has('interpolated')) legendRows.push([strokeAttrs(t, false, 'interpolated', k), 'Contour over filled cells']);
  if (kinds.has('gap')) legendRows.push([strokeAttrs(t, false, 'gap', k), 'Low-confidence gap']);
  if (rel) legendRows.push([`stroke="${cssColor(t.outline)}" stroke-width="${(t.weight.outline * 0.75 * k).toFixed(3)}" fill="none"`, 'Scan footprint']);
  const extraRows = (rel?.hasHoles ? 1 : 0) + (rel?.highest ? 1 : 0) + (rel?.lowest ? 1 : 0);
  const footerTop = margin + mapH + 18;
  const legendTop = footerTop + 44;
  const legendBottom = legendTop + (legendRows.length + extraRows - 1) * 16 + 6;
  const titleBottom = footerTop + 12 + tLines.length * 14;
  const H = Math.max(legendBottom, titleBottom) + margin;
  const W = mapW + margin * 2;

  const leg: string[] = legendRows.map(([attrs, label], i) => {
    const ry = legendTop + i * 16;
    return `<line x1="${margin}" y1="${ry.toFixed(1)}" x2="${margin + 34}" y2="${ry.toFixed(1)}" ${attrs}/>` +
      `<text x="${margin + 42}" y="${(ry + 3.5).toFixed(1)}" font-size="10" fill="${ink}" ${SANS}>${label}</text>`;
  });
  let row = legendRows.length;
  if (rel?.hasHoles) {
    const ry = legendTop + row++ * 16;
    leg.push(
      `<rect x="${margin}" y="${(ry - 4).toFixed(1)}" width="34" height="8" fill="${cssColor(t.nodata)}" stroke="${cssColor(t.hatch)}" stroke-width="0.5"/>` +
        `<text x="${margin + 42}" y="${(ry + 3.5).toFixed(1)}" font-size="10" fill="${ink}" ${SANS}>No ground data inside the footprint</text>`,
    );
  }
  for (const [has, up, label] of [[rel?.highest, true, 'Highest measured ground'], [rel?.lowest, false, 'Lowest measured ground']] as const) {
    if (!has) continue;
    const ry = legendTop + row++ * 16;
    const pts = up ? `${margin + 17},${ry - 4} ${margin + 21},${ry + 3} ${margin + 13},${ry + 3}` : `${margin + 17},${ry + 4} ${margin + 21},${ry - 3} ${margin + 13},${ry - 3}`;
    leg.push(`<polygon points="${pts}" fill="${ink}"/><text x="${margin + 42}" y="${(ry + 3.5).toFixed(1)}" font-size="10" fill="${ink}" ${SANS}>${label}</text>`);
  }

  // Scale bar: four segments over a round ground distance.
  const D = niceRound(Math.max(worldW / 4, 1e-6));
  const segPx = (D * scale) / 4;
  const by = footerTop + 24;
  const bar: string[] = [];
  for (let i = 0; i < 4; i++) {
    bar.push(`<rect x="${(margin + i * segPx).toFixed(2)}" y="${by}" width="${segPx.toFixed(2)}" height="6" fill="${i % 2 === 0 ? ink : cssColor(t.panel)}" stroke="${ink}" stroke-width="0.5"/>`);
  }
  for (const [px, lbl] of [[margin, '0'], [margin + (D * scale) / 2, formatScaleTick(D / 2)], [margin + D * scale, `${formatScaleTick(D)} ${unit}`]] as const) {
    bar.push(`<text x="${px.toFixed(2)}" y="${by - 3}" font-size="9" text-anchor="middle" fill="${ink}" ${MONO}>${lbl}</text>`);
  }
  const nx = margin + mapW - 22, ny = margin + 10;
  const north = `<polygon points="${nx},${ny} ${nx - 6},${ny + 26} ${nx},${ny + 19} ${nx + 6},${ny + 26}" fill="${ink}"/>` +
    `<text x="${nx}" y="${ny + 37}" font-size="11" text-anchor="middle" fill="${ink}" ${SANS}>N</text>`;
  const xRight = (W - margin).toFixed(1);
  const title = tLines.map((ln, i) => {
    const weight = i === 0 && prov?.source ? ' font-weight="600"' : '';
    return `<text x="${xRight}" y="${(footerTop + 12 + i * 14).toFixed(1)}" font-size="10" text-anchor="end" fill="${i === 0 ? ink : dim}" ${SANS}${weight}>${xmlEscape(ln)}</text>`;
  }).join('');
  const caption =
    Number.isFinite(model.interpolatedFraction) && model.interpolatedFraction > 0
      ? `<!-- ${commentText(`${contourShareLine(modelLengthShares(model))}. ${NOT_SURVEY_GRADE_NOTE}`)} -->`
      : `<!-- ${NOT_SURVEY_GRADE_NOTE} -->`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(2)}" height="${H.toFixed(2)}" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}">`,
    provStamp,
    caption,
    `<rect x="0" y="0" width="${W.toFixed(2)}" height="${H.toFixed(2)}" fill="${cssColor(t.paper)}"/>`,
    `<rect x="${margin}" y="${margin}" width="${mapW.toFixed(2)}" height="${mapH.toFixed(2)}" fill="${cssColor(t.panel)}"/>`,
    ...out,
    `<rect x="${margin}" y="${margin}" width="${mapW.toFixed(2)}" height="${mapH.toFixed(2)}" fill="none" stroke="${cssColor(t.outline)}" stroke-width="0.8"/>`,
    north,
    bar.join(''),
    leg.join(''),
    title,
    '</svg>',
  ].join('\n');
}
