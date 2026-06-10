/**
 * convertCloud.ts — turn one decoded `PointCloud` into an output file.
 *
 * Orchestrates: lift to global coordinates → apply the CRS step (keep /
 * assign / reproject) → write the chosen format. Returns the produced file
 * (or null on failure) plus a structured report with a per-conversion log.
 *
 * Pure data — no DOM. The reprojection branch pulls in proj4 via
 * `reproject.ts`; everything else is dependency-free.
 */

import type { PointCloud } from '../model/PointCloud';
import { cloudToGlobal } from './globalPoints';
import { writeLas, writeLas14 } from './writeLas';
import { writeXyz, writeAsc } from './writeAscii';
import { reprojectGlobal } from './reproject';
import { isGeographicEpsg, epsgLabel, epsgToProj4 } from './epsg';
import {
  CONVERT_FORMATS,
  type ConvertOptions,
  type ConvertedFile,
  type ConvertReport,
  type LogEntry,
} from './types';

const MIME: Record<string, string> = {
  las14: 'application/octet-stream',
  las: 'application/octet-stream',
  xyz: 'text/plain',
  asc: 'text/plain',
};

/** GeoTIFF ProjLinearUnits code for a CRS linear unit (null = don't write it). */
function unitToGeoTiff(unit: 'metre' | 'foot' | 'us-survey-foot' | 'unknown'): number | null {
  switch (unit) {
    case 'metre': return 9001;
    case 'foot': return 9002;
    case 'us-survey-foot': return 9003;
    default: return null;
  }
}

function baseName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const stem = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = stem.lastIndexOf('.');
  return dot > 0 ? stem.slice(0, dot) : stem;
}

/** Convert one cloud. Returns the file (or null) and a report. */
export function convertCloud(
  cloud: PointCloud,
  opts: ConvertOptions,
): { file: ConvertedFile | null; report: ConvertReport } {
  const log: LogEntry[] = [];
  const spec = CONVERT_FORMATS[opts.format];
  const fail = (msg: string, crsNote = '—'): { file: null; report: ConvertReport } => {
    log.push({ level: 'error', message: msg });
    return { file: null, report: { source: cloud.name, ok: false, pointCount: 0, crsNote, log } };
  };

  if (!spec.available) {
    return fail(`${spec.label} output is not available in-browser yet (the bundled decoder cannot encode it).`);
  }

  try {
    return run();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`Conversion failed unexpectedly: ${detail}`);
  }

  function run(): { file: ConvertedFile | null; report: ConvertReport } {
  const mode = opts.crsMode ?? 'keep';
  const sourceEpsg = cloud.metadata?.crs?.epsg ?? opts.sourceEpsg ?? null;
  let g = cloudToGlobal(cloud);
  let outEpsg: number | null = sourceEpsg;
  let crsNote: string;

  if (mode === 'keep') {
    crsNote = sourceEpsg != null ? `kept ${epsgLabel(sourceEpsg)}` : 'no CRS (local coordinates)';
  } else if (mode === 'assign') {
    if (opts.targetEpsg == null) return fail('Assign mode needs a target EPSG.');
    outEpsg = opts.targetEpsg;
    crsNote = `assigned ${epsgLabel(outEpsg)} (coordinates unchanged)`;
    // Light validation: a code outside the plausible EPSG range, or one we
    // don't recognise, is tagged as given but flagged so a typo is visible.
    if (outEpsg < 1024 || outEpsg > 99999) {
      log.push({ level: 'warn', message: `EPSG:${outEpsg} is outside the valid EPSG range — check the code.` });
    } else if (epsgToProj4(outEpsg) == null) {
      log.push({ level: 'info', message: `EPSG:${outEpsg} isn't in the built-in registry — tagged as given; verify it's correct.` });
    }
    if (sourceEpsg != null && sourceEpsg !== outEpsg) {
      log.push({
        level: 'warn',
        message: `Overriding the file's CRS (${epsgLabel(sourceEpsg)}) without moving points — use Reproject to transform coordinates.`,
      });
    }
  } else {
    // reproject
    if (opts.targetEpsg == null) return fail('Reproject mode needs a target EPSG.');
    if (sourceEpsg == null) {
      return fail('Reproject needs a known source CRS. Assign the source EPSG, or pick Assign instead.');
    }
    const r = reprojectGlobal(g, sourceEpsg, opts.targetEpsg);
    g = r.points;
    if (r.transformed) {
      outEpsg = opts.targetEpsg;
      crsNote = r.note;
      log.push({ level: 'info', message: r.note });
    } else {
      // Could not resolve a transform — keep source CRS, warn loudly.
      outEpsg = sourceEpsg;
      crsNote = `reproject skipped — ${r.note}`;
      log.push({ level: 'warn', message: r.note });
    }
  }

  const geo = outEpsg != null ? isGeographicEpsg(outEpsg) : false;
  const filename = `${baseName(cloud.name)}.${spec.ext}`;

  let bytes: Uint8Array;
  if (opts.format === 'las' || opts.format === 'las14') {
    const srcCrs = cloud.metadata?.crs;
    // LAS 1.4 wants the CRS as OGC WKT for point formats 6+. A real WKT only
    // exists when the source carried one AND nothing changed (keep mode) —
    // after assign/reproject the source WKT would describe the wrong CRS,
    // so those modes fall back to a GeoKey tag built from the EPSG.
    const wkt = opts.format === 'las14' && mode === 'keep' ? (srcCrs?.wkt ?? null) : null;
    if (outEpsg != null && outEpsg > 65535 && wkt == null) {
      log.push({
        level: 'warn',
        message: `EPSG:${outEpsg} is too large to record in a LAS GeoKey — the file is written without a CRS tag.`,
      });
    }
    // Linear unit: kept files carry the source unit; reprojected output is in
    // metres (our reproject targets are metric/degree); assigned tags leave it
    // implied by the EPSG. Vertical datum is preserved (no mode transforms Z).
    const linearUnitCode =
      mode === 'reproject' ? 9001
      : mode === 'keep' && srcCrs ? unitToGeoTiff(srcCrs.linearUnit)
      : null;
    if (opts.format === 'las14') {
      if (outEpsg != null && outEpsg <= 65535 && wkt == null) {
        log.push({
          level: 'info',
          message: 'No WKT available for this CRS — recorded as GeoTIFF keys (strict LAS 1.4 readers prefer WKT for point formats 6+).',
        });
      }
      bytes = writeLas14(g, {
        epsg: outEpsg ?? undefined,
        isGeographic: geo,
        linearUnitCode,
        verticalEpsg: srcCrs?.verticalEpsg ?? null,
        wkt,
      });
    } else {
      // LAS 1.2 stores the classification in 5 bits — count what the mask
      // will destroy and say so, instead of silently zeroing class 64 etc.
      if (g.classification) {
        let clamped = 0;
        for (let i = 0; i < g.count; i++) {
          if (g.classification[i] > 31) clamped++;
        }
        if (clamped > 0) {
          log.push({
            level: 'warn',
            message: `LAS 1.2 stores 5-bit classes — ${clamped.toLocaleString()} points with classes > 31 were clamped; use LAS 1.4 to preserve them.`,
          });
        }
      }
      bytes = writeLas(g, {
        epsg: outEpsg ?? undefined,
        isGeographic: geo,
        linearUnitCode,
        verticalEpsg: srcCrs?.verticalEpsg ?? null,
      });
    }
  } else {
    const text =
      opts.format === 'asc'
        ? writeAsc(g, { precision: opts.asciiPrecision, epsg: outEpsg, crsName: cloud.metadata?.crs?.name ?? null })
        : writeXyz(g, opts.asciiPrecision ?? 3);
    bytes = new TextEncoder().encode(text);
  }

  log.push({ level: 'info', message: `Wrote ${g.count.toLocaleString()} points as ${spec.label}.` });
  return {
    file: { filename, mime: MIME[opts.format], bytes },
    report: { source: cloud.name, ok: true, pointCount: g.count, crsNote, log },
  };
  }
}
