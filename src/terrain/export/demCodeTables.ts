/**
 * demCodeTables.ts — the meaning of every code the DEM package's code rasters
 * carry, as one table per band, and the two renderings of it that ship in the
 * package: a QGIS layer style (`.qml`) per raster and a README section.
 *
 * The codes come from the enums the writers use, never retyped here:
 * EVIDENCE_STATE_CODE for the evidence raster's cell_state band,
 * ATTENTION_LEVEL_CODE and ATTENTION_REASON_CODE for the attention raster's
 * two bands, and the ensemble size for the sensitivity raster's member-count
 * band. Each meaning is keyed by the enum's own key, so adding a code without
 * a meaning fails to compile, and the test asserts every code of every enum
 * appears in its style and in the README table. The sensitivity range band is
 * continuous and gets a colour ramp, not a code table.
 *
 * Pure data; no DOM, no I/O.
 */

import { EVIDENCE_STATE_CODE, TERRAIN_EVIDENCE_BANDS } from './demEvidence';
import {
  ATTENTION_LEVEL_CODE,
  ATTENTION_REASON_CODE,
  TERRAIN_ATTENTION_BANDS,
} from './demAttention';
import { SENSITIVITY_ENSEMBLE, TERRAIN_SENSITIVITY_BANDS } from './demSensitivity';

/** One code of one band: its value, the enum key it came from, its meaning and a style colour. */
export interface CodeEntry {
  readonly code: number;
  readonly key: string;
  readonly meaning: string;
  /** `#rrggbb`, used by the QGIS palette. */
  readonly color: string;
}

/** The code table of one band of one raster. */
export interface CodeTable {
  readonly raster: 'evidence' | 'attention' | 'sensitivity';
  /** 1-based band number, as GDAL and QGIS count. */
  readonly band: number;
  readonly bandName: string;
  readonly entries: readonly CodeEntry[];
}

const EVIDENCE_STATE_MEANING: Record<keyof typeof EVIDENCE_STATE_CODE, string> = {
  empty: 'no height (NoData)',
  measured: 'measured: at least one ground return landed in the cell',
  interpolated: 'interpolated from neighbouring measured cells',
  lowConfidence: 'interpolated, low confidence',
  edgeRisk: 'interpolated from 3 or more cells away (edge risk)',
  edgeAffected: 'interpolated, within 2 steps of the survey boundary (edge affected)',
  unresolved: 'unresolved: the vertical unit or CRS is unresolved, set on every cell',
};

const EVIDENCE_STATE_COLOR: Record<keyof typeof EVIDENCE_STATE_CODE, string> = {
  empty: '#ffffff',
  measured: '#1a9850',
  interpolated: '#a6d96a',
  lowConfidence: '#fee08b',
  edgeRisk: '#f46d43',
  edgeAffected: '#d73027',
  unresolved: '#9e9e9e',
};

const ATTENTION_LEVEL_MEANING: Record<keyof typeof ATTENTION_LEVEL_CODE, string> = {
  none: 'none: no scored input reached its reference (not a statement that the surface is verified)',
  low: 'low: the highest input score is at or above 0.33',
  medium: 'medium: the highest input score is at or above 0.67',
  high: 'high: an input score reached 1',
};

const ATTENTION_LEVEL_COLOR: Record<keyof typeof ATTENTION_LEVEL_CODE, string> = {
  none: '#f7f7f7',
  low: '#fdd49e',
  medium: '#fc8d59',
  high: '#b30000',
};

const ATTENTION_REASON_MEANING: Record<keyof typeof ATTENTION_REASON_CODE, string> = {
  NONE: 'no reason: the cell is at level 0',
  LONG_INTERPOLATION: 'long interpolation: interpolation distance set the level',
  LOW_SUPPORT: 'low support: cell confidence set the level',
  EDGE_AFFECTED: 'edge affected: cell_state 5 set the level',
  MODEL_SENSITIVITY: 'model sensitivity: the sensitivity range set the level',
  RECONSTRUCTION_RESIDUAL: 'reconstruction residual: the leave-local-out residual set the level',
  TERRAIN_COMPLEXITY: 'terrain complexity: reserved, not scored',
  CLASSIFICATION_AMBIGUITY: 'classification ambiguity: reserved, not scored',
  UNRESOLVED: 'unresolved: a measured cell the residual sampling skipped that no other input flags',
};

const ATTENTION_REASON_COLOR: Record<keyof typeof ATTENTION_REASON_CODE, string> = {
  NONE: '#f7f7f7',
  LONG_INTERPOLATION: '#8dd3c7',
  LOW_SUPPORT: '#ffffb3',
  EDGE_AFFECTED: '#bebada',
  MODEL_SENSITIVITY: '#fb8072',
  RECONSTRUCTION_RESIDUAL: '#80b1d3',
  TERRAIN_COMPLEXITY: '#fdb462',
  CLASSIFICATION_AMBIGUITY: '#b3de69',
  UNRESOLVED: '#9e9e9e',
};

const MEMBER_COLORS = ['#f7f7f7', '#fee5d9', '#fcae91', '#fb6a4a', '#1a9850'];

function tableOf<K extends string>(
  raster: CodeTable['raster'],
  band: number,
  bandName: string,
  codes: Readonly<Record<K, number>>,
  meanings: Readonly<Record<K, string>>,
  colors: Readonly<Record<K, string>>,
): CodeTable {
  const entries = (Object.keys(codes) as K[])
    .map((key) => ({ code: codes[key], key, meaning: meanings[key], color: colors[key] }))
    .sort((a, b) => a.code - b.code);
  return { raster, band, bandName, entries };
}

/** The cell_state table of the evidence raster (band 3). */
export function evidenceCodeTable(): CodeTable {
  return tableOf('evidence', 3, TERRAIN_EVIDENCE_BANDS[2], EVIDENCE_STATE_CODE, EVIDENCE_STATE_MEANING, EVIDENCE_STATE_COLOR);
}

/** The attention_level (band 1) and dominant_reason (band 2) tables of the attention raster. */
export function attentionCodeTables(): readonly [CodeTable, CodeTable] {
  return [
    tableOf('attention', 1, TERRAIN_ATTENTION_BANDS[0], ATTENTION_LEVEL_CODE, ATTENTION_LEVEL_MEANING, ATTENTION_LEVEL_COLOR),
    tableOf('attention', 2, TERRAIN_ATTENTION_BANDS[1], ATTENTION_REASON_CODE, ATTENTION_REASON_MEANING, ATTENTION_REASON_COLOR),
  ];
}

/**
 * The sensitivity_members table of the sensitivity raster (band 2): the number
 * of ensemble members that produced a height at the cell, 0 to the ensemble size.
 */
export function sensitivityMembersCodeTable(): CodeTable {
  const n = SENSITIVITY_ENSEMBLE.length;
  const entries: CodeEntry[] = [];
  for (let k = 0; k <= n; k++) {
    entries.push({
      code: k,
      key: `members_${k}`,
      meaning: memberMeaning(k, n),
      color: MEMBER_COLORS[Math.min(k, MEMBER_COLORS.length - 1)],
    });
  }
  return { raster: 'sensitivity', band: 2, bandName: TERRAIN_SENSITIVITY_BANDS[1], entries };
}

/** What `k` of `n` ensemble members producing a height means for a cell. */
function memberMeaning(k: number, n: number): string {
  if (k === n) return `all ${n} ensemble members produced a height`;
  if (k === 0) return 'no member produced a height';
  return `${k} of ${n} ensemble members produced a height`;
}

const xmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A QGIS 3 layer style with a paletted renderer over `table.band`, one palette
 * entry per code, labelled "<code> <meaning>". NoData is left to the raster's
 * own GDAL_NODATA tag; `noData` is excluded from the palette when given.
 */
export function writePalettedQml(table: CodeTable, noData: number | null = null): string {
  const entries = table.entries
    .filter((e) => noData === null || e.code !== noData)
    .map((e) => {
      const label = xmlAttr(e.code + ' ' + e.meaning);
      return `        <paletteEntry value="${e.code}" color="${e.color}" alpha="255" label="${label}"/>`;
    })
    .join('\n');
  return [
    `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>`,
    `<qgis version="3.34.0" styleCategories="Symbology">`,
    `  <pipe>`,
    `    <rasterrenderer type="paletted" band="${table.band}" opacity="1" alphaBand="-1" nodataColor="">`,
    `      <rasterTransparency/>`,
    `      <colorPalette>`,
    entries,
    `      </colorPalette>`,
    `    </rasterrenderer>`,
    `    <brightnesscontrast brightness="0" contrast="0" gamma="1"/>`,
    `    <huesaturation saturation="0" grayscaleMode="0" colorizeOn="0"/>`,
    `    <rasterresampler maxOversampling="2"/>`,
    `  </pipe>`,
    `  <blendMode>0</blendMode>`,
    `</qgis>`,
    ``,
  ].join('\n');
}

/**
 * A QGIS 3 layer style with a single-band pseudocolour ramp over a continuous
 * band, from `min` to `max` in the band's own unit (the sensitivity range).
 */
export function writePseudocolorQml(band: number, bandName: string, min: number, max: number, unit: string): string {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  const stops: Array<[number, string]> = [
    [lo, '#ffffcc'],
    [lo + (hi - lo) * 0.5, '#fd8d3c'],
    [hi, '#800026'],
  ];
  const items = stops
    .map(([v, c]) => {
      const label = xmlAttr(Number(v.toFixed(6)) + ' ' + unit);
      return `          <item value="${v}" color="${c}" alpha="255" label="${label}"/>`;
    })
    .join('\n');
  return [
    `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>`,
    `<qgis version="3.34.0" styleCategories="Symbology">`,
    `  <pipe>`,
    `    <rasterrenderer type="singlebandpseudocolor" band="${band}" classificationMin="${lo}" classificationMax="${hi}" opacity="1" alphaBand="-1" nodataColor="">`,
    `      <rasterTransparency/>`,
    `      <rastershader>`,
    `        <colorrampshader colorRampType="INTERPOLATED" classificationMode="1" clip="0" minimumValue="${lo}" maximumValue="${hi}" labelPrecision="6">`,
    items,
    `        </colorrampshader>`,
    `      </rastershader>`,
    `    </rasterrenderer>`,
    `    <brightnesscontrast brightness="0" contrast="0" gamma="1"/>`,
    `    <huesaturation saturation="0" grayscaleMode="0" colorizeOn="0"/>`,
    `    <rasterresampler maxOversampling="2"/>`,
    `  </pipe>`,
    `  <blendMode>0</blendMode>`,
    `  <!-- ${xmlAttr(bandName)} -->`,
    `</qgis>`,
    ``,
  ].join('\n');
}

/**
 * README lines: one fixed-width table per band, every code with its meaning,
 * and the name of the style file that renders it. Only the rasters the package
 * holds are listed, so `files` names the raster file of each table's raster.
 */
export function codeTablesReadmeLines(
  tables: readonly { readonly table: CodeTable; readonly rasterFile: string; readonly styleFile: string }[],
): string[] {
  if (tables.length === 0) return [];
  const out = [
    `Code tables`,
    `  Every value the code rasters carry, with its meaning. The same tables`,
    `  are written as QGIS layer styles (.qml) beside each raster: load the`,
    `  raster, then Layer > Properties > Style > Load Style and pick the file.`,
  ];
  for (const { table, rasterFile, styleFile } of tables) {
    out.push(``, `  ${rasterFile} band ${table.band} ${table.bandName} (style ${styleFile})`, `    code  meaning`);
    for (const e of table.entries) out.push(`    ${String(e.code).padStart(4)}  ${e.meaning}`);
  }
  out.push(``);
  return out;
}
