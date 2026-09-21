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
import { sourcePositions } from '../model/pointFrames';
import { classifyScanShape } from '../terrain/scanShape';
import { isZUpFormat } from '../io/sniffFormat';
import { wktForEpsg } from '../io/epsgWkt';
import { cloudToGlobal } from './globalPoints';
import { describeLoss, inspectLegacyConversion } from '../lasSemantics';

/**
 * The extended classification-flags bit that carries overlap (LAS 1.4 Table 8),
 * and the legacy record format the loss sentence is phrased against.
 */
const EXT_OVERLAP_FLAG_BIT = 0x8;
const LEGACY_PDRF_FOR_LOSS = 3;
import { writeLas, writeLas14 } from './writeLas';
import { spatialContextFrom } from '../geo/SpatialContext';
import { writeXyz, writeAsc } from './writeAscii';
import { reprojectGlobal } from './reproject';
import type { TransformProvenance } from './transformProvenance';
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
  // The RESOLVED source CRS (CrsService), when the caller supplies it, is the
  // authority — it honours any user override, so `cloud.metadata.crs` stays
  // source-declared PROVENANCE only. Given a resolved value we never consult
  // metadata, so a rejected or local override can't resurrect the file's declared
  // CRS into the output tag or a reprojection (blocker #2D). `undefined` means no
  // resolver is in play (the pure module's own callers / tests), which falls back
  // to the detected metadata exactly as before — a byte-identical no-override path.
  const resolvedProvided = opts.resolvedSourceCrs !== undefined;
  const sourceCrs = resolvedProvided ? opts.resolvedSourceCrs : (cloud.metadata?.crs ?? null);
  const sourceEpsg = resolvedProvided
    ? (opts.resolvedSourceCrs?.epsg ?? opts.sourceEpsg ?? null)
    : (cloud.metadata?.crs?.epsg ?? opts.sourceEpsg ?? null);
  let g = cloudToGlobal(cloud);
  // Every output format here reads Z as elevation (LAS by spec; the ASCII
  // writers by the same convention), which is wrong for the Y-up mesh formats:
  // raw storage order would put the mesh's elevation in the northing column and
  // its depth in the height column — plausible numbers, scrambled axes. Same
  // remedy as the terrain pipeline (`terrain/canonicalFrame.ts`): one rotation
  // at the boundary, (x, y, z) → (x, −z, y), so every writer stays
  // axis-ignorant. Disclosed in the report because the written coordinates no
  // longer match the source bytes.
  // Mesh formats carry no mandated up-axis (photogrammetry writes Y-up,
  // CloudCompare/PDAL-style tools write Z-up PLYs), so the DATA decides via the
  // same detection the terrain gather uses — a format table alone rotated
  // genuinely Z-up PLYs into vertical walls there, and would corrupt exports
  // identically here. Survey formats skip detection: Z-up by spec.
  if (!isZUpFormat(cloud.sourceFormat) && classifyScanShape(sourcePositions(cloud)).up === 'y') {
    const { y, z } = g;
    for (let i = 0; i < g.count; i++) {
      const yv = y[i];
      y[i] = -z[i];
      z[i] = yv;
    }
    log.push({
      level: 'info',
      message:
        'Y-up source rotated into the Z-up survey frame (elevation → Z, north → Y) so the output axes mean what the format says they mean.',
    });
  }
  let outEpsg: number | null = sourceEpsg;
  let crsNote: string;
  // True only when a reproject ACTUALLY moved coordinates into the target CRS.
  // Output-CRS-dependent stamps below (the metre GeoKey) key off this, not off
  // the requested mode — a skipped reproject leaves the file in its SOURCE CRS.
  let reprojectApplied = false;
  // The APPROXIMATE-datum caveat to EMBED in the deliverable (LAS VLR / ASCII
  // header comment), not just the UI report. Non-null only when a transform
  // that DID move coordinates crossed a grid-less/identity datum leg — so the
  // exact-transform path leaves it null and the output stays byte-clean.
  let datumNote: string | null = null;
  // Machine-readable provenance of the transform, threaded into the report so
  // the reproject path stops discarding it (present on every reproject outcome).
  let transformProvenance: TransformProvenance | null = null;

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
    // Pass the source CRS as a provenance hint so the result's
    // TransformProvenance carries the realization-preserving datum name and the
    // source coordinate epoch. Hints affect only the metadata, never the
    // reprojected coordinates.
    const r = reprojectGlobal(g, sourceEpsg, opts.targetEpsg, { sourceCrs });
    g = r.points;
    // Provenance is present on every reproject outcome (applied / approximate /
    // skipped) — keep it for the report instead of discarding it.
    transformProvenance = r.provenance;
    if (r.transformed && r.datumCaveat == null) {
      reprojectApplied = true;
      outEpsg = opts.targetEpsg;
      crsNote = r.note;
      log.push({ level: 'info', message: r.note });
    } else if (r.transformed) {
      // Transformed, but the datum leg is known-missing/degenerate (grid-less
      // NAD27, identity GDA94↔GDA2020). The coordinates ARE in the target
      // projection, so the file is stamped with the target CRS — but the
      // status and log say "approximate", never a clean "reprojected ✓".
      reprojectApplied = true;
      outEpsg = opts.targetEpsg;
      crsNote = `${r.note} — APPROXIMATE datum shift`;
      log.push({ level: 'warn', message: `${r.note}, but ${r.datumCaveat}.` });
      // Carry that same caveat INTO the file. The UI report is not the
      // deliverable; a downstream reader only has the bytes, so the
      // approximation must be recorded there too (LAS Text Area Description
      // VLR, ASCII `# datum-transform:` header). Coordinates are untouched.
      datumNote = `APPROXIMATE — ${r.datumCaveat}`;
    } else {
      // Could not resolve a transform — keep source CRS, warn loudly.
      outEpsg = sourceEpsg;
      crsNote = `reproject skipped — ${r.note}`;
      log.push({ level: 'warn', message: r.note });
    }
  }

  // Honesty guard — drop the classification channel when the user opts out
  // (e.g. a derived/heuristic classification they don't want to ship as if it
  // were a producer classification). Written as class 0 by the LAS writers.
  if (opts.omitClassification && g.classification) {
    g = { ...g, classification: undefined };
    log.push({ level: 'info', message: 'Classification omitted at the user’s request — written as class 0.' });
  }

  const geo = outEpsg != null ? isGeographicEpsg(outEpsg) : false;
  const filename = `${baseName(cloud.name)}.${spec.ext}`;

  let bytes: Uint8Array;
  if (opts.format === 'las' || opts.format === 'las14') {
    // ONE spatial context for the written file, from the RESOLVED source CRS
    // (`sourceCrs`, override applied) — never the declared `cloud.metadata.crs`.
    // The horizontal unit code, the vertical datum code and the vertical unit
    // code below all come off it, so a LAS the reader trusts is tagged with the
    // CRS the user resolved, not a resolved EPSG beside the declared units/WKT
    // (blocker 2). A local resolution carries no unit facts, so the output is
    // untagged rather than restoring the rejected CRS.
    const srcCtx = spatialContextFrom(sourceCrs);
    // LAS 1.4 wants the CRS as OGC WKT for point formats 6+. A real WKT only
    // exists when the source carried one AND nothing changed (keep mode) —
    // after assign/reproject the source WKT would describe the wrong CRS,
    // so those modes fall back to a GeoKey tag built from the EPSG. The WKT is
    // the RESOLVED source CRS's, matching the EPSG the same object supplied.
    const sourceWkt = opts.format === 'las14' && mode === 'keep' ? (sourceCrs?.wkt ?? null) : null;
    // Falling back to a WKT derived from the OUTPUT code covers the modes the
    // source WKT cannot: after assign or reproject the source WKT describes
    // the wrong CRS, but a derived one describes outEpsg by construction. It
    // also covers keep mode for the common case of a source georeferenced by
    // GeoKeys alone, which is what left LAS 1.4 files with bit 4 clear.
    const wkt = opts.format === 'las14' ? (sourceWkt ?? wktForEpsg(outEpsg)) : null;
    if (outEpsg != null && outEpsg > 65535 && wkt == null) {
      log.push({
        level: 'warn',
        message: `EPSG:${outEpsg} is too large to record in a LAS GeoKey — the file is written without a CRS tag.`,
      });
    }
    // Linear unit: kept files carry the source unit; output that was ACTUALLY
    // reprojected is in metres (our reproject targets are metric/degree); a
    // SKIPPED reproject leaves the file in its source CRS, so it carries the
    // source unit exactly like keep mode (stamping 9001 on a skipped reproject
    // mislabelled foot data as metres — v0.4.4 defect). Assigned tags leave the
    // unit implied by the EPSG. Vertical datum is preserved (no mode moves Z).
    let linearUnitCode: number | null;
    if (mode === 'reproject' && reprojectApplied) {
      linearUnitCode = 9001;
    } else if ((mode === 'keep' || mode === 'reproject') && sourceCrs) {
      linearUnitCode = unitToGeoTiff(srcCtx.linearUnit);
    } else {
      linearUnitCode = null;
    }
    // Vertical unit: Z is untouched by every mode, so its unit is the SOURCE's
    // declared vertical unit — falling back to the source's horizontal family
    // (the GeoTIFF convention that vertical tracks the model's units), never
    // the OUTPUT horizontal. Reprojecting a foot-height file to metre eastings
    // used to relabel its unchanged Z as metres.
    const verticalUnitCode = sourceCrs
      ? unitToGeoTiff(srcCtx.verticalLinearUnit ?? srcCtx.linearUnit)
      : null;
    // Global Encoding bit 0 on the source, when it declared one. undefined
    // leaves the writer's modern default in place for a source that carries no
    // such declaration at all.
    const declaredGps = cloud.metadata?.gpsTimeType;
    const gpsStandardFromSource =
      declaredGps === undefined ? undefined : declaredGps === 'adjusted-standard';
    if (opts.format === 'las14') {
      if (outEpsg != null && outEpsg <= 65535 && wkt == null) {
        log.push({
          level: 'info',
          message: 'No WKT available for this CRS — recorded as GeoTIFF keys (strict LAS 1.4 readers prefer WKT for point formats 6+).',
        });
      }
      bytes = writeLas14(g, {
        gpsStandardTime: gpsStandardFromSource,
        epsg: outEpsg ?? undefined,
        isGeographic: geo,
        linearUnitCode,
        verticalEpsg: srcCtx.verticalEpsg ?? null,
        verticalUnitCode,
        wkt,
        description: datumNote,
      });
    } else {
      // LAS 1.2 stores the classification in 5 bits — count what the mask
      // will destroy and say so, instead of silently zeroing class 64 etc.
      // The writer masks (`& 0x1f`), so a class above 31 WRAPS: it is not
      // pinned to 31. The message states the wrap, because a reader told
      // "clamped" would expect 64 to arrive as 31 when it arrives as 0.
      if (g.classification) {
        let wrapped = 0;
        for (let i = 0; i < g.count; i++) {
          if (g.classification[i] > 31) wrapped++;
        }
        if (wrapped > 0) {
          log.push({
            level: 'warn',
            message: `LAS 1.2 stores 5-bit classes — ${wrapped.toLocaleString()} points with classes > 31 wrap to their low 5 bits (class & 31), so 33 reads back as 1 and 64 as 0; use LAS 1.4 to preserve them.`,
          });
        }
      }
      // The OTHER thing a legacy write drops, which went out silently. The
      // extended encoding carries overlap as a flag bit beside a real base
      // class; the legacy byte has nowhere to put it, so `writeLas` composes
      // only the synthetic/key-point/withheld bits and the overlap mark
      // disappears. `lasSemantics` has described this loss precisely since it
      // was written — `inspectLegacyConversion` / `describeLoss` — and had no
      // caller anywhere in `src/`, so the sentence existed and never reached a
      // user. The class-wrap warning above is the same shape; this is its
      // missing half.
      if (g.classificationFlags) {
        let overlapped = 0;
        for (let i = 0; i < g.count; i++) {
          if ((g.classificationFlags[i] & EXT_OVERLAP_FLAG_BIT) !== 0) overlapped++;
        }
        if (overlapped > 0) {
          const loss = describeLoss(inspectLegacyConversion([], true), LEGACY_PDRF_FOR_LOSS);
          log.push({
            level: 'warn',
            message: `LAS 1.2 cannot record the overlap flag — ${overlapped.toLocaleString()} points carry it and ${loss}; the base class is written and the overlap mark is dropped. Use LAS 1.4 to preserve it.`,
          });
        }
      }
      bytes = writeLas(g, {
        // Declare the time the source declared. Adjusted Standard GPS Time and
        // GPS Week Time are different quantities, so carrying the values across
        // unchanged while relabelling them changes what they mean. A source
        // that did not say keeps the modern default.
        gpsStandardTime: gpsStandardFromSource,
        epsg: outEpsg ?? undefined,
        isGeographic: geo,
        linearUnitCode,
        verticalEpsg: srcCtx.verticalEpsg ?? null,
        verticalUnitCode,
        description: datumNote,
      });
    }
  } else {
    const text =
      opts.format === 'asc'
        ? writeAsc(g, { precision: opts.asciiPrecision, epsg: outEpsg, crsName: sourceCrs?.name ?? null, geographic: geo, datumNote })
        : writeXyz(g, opts.asciiPrecision ?? 3, geo, datumNote);
    bytes = new TextEncoder().encode(text);
  }

  log.push({ level: 'info', message: `Wrote ${g.count.toLocaleString()} points as ${spec.label}.` });
  return {
    file: { filename, mime: MIME[opts.format], bytes },
    report: {
      source: cloud.name,
      ok: true,
      pointCount: g.count,
      crsNote,
      log,
      // Only reproject mode produces provenance; keep/assign omit the field.
      ...(transformProvenance ? { provenance: transformProvenance } : {}),
    },
  };
  }
}
