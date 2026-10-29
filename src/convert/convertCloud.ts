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

import { exportDigestLines } from '../science/exportDigestRecord';
import { DISPLAY_SAMPLE_SUFFIX, displaySampleLine, pointBasisLine } from '../export/exportSummary';
import { truncationOf } from '../io/truncation';
import { safeEntryName, singleLine } from '../export/safeText';
import { classEditLine, classesEdited, pointBasisOfCloud, softwareLine, sourceFileLine } from '../export/exportProvenanceLines';
import type { PointCloud } from '../model/PointCloud';
import type { CrsInfo } from '../io/crs';
import { ATTR_COLOUR_INVALID, ATTR_INTENSITY_INVALID, countAttributeInvalid, intensityNormalisationLine } from '../model/PointCloud';
import { planAxisHandling, rotateYUpToZUp, yUpRotationEvent } from './axisHandling';
import { cloudToGlobal } from './globalPoints';
import { describeLoss, inspectLegacyConversion } from '../lasSemantics';
import { legacyClassReinterpretationRefusal, planClassSemantics } from './classSemantics';
import {
  acquisitionEvents,
  acquisitionLossRefusal,
  assessLegacyAcquisition,
  combineRefusals,
  type LegacyRefusal,
  eventLogEntry,
  fitProvenance,
  isMaterialAcquisitionLoss,
  asciiDroppedFieldsEvent,
  eventRecordLine,
  provenanceTrimmedMessage,
  type ConversionEvent,
} from './conversionEvents';
import {
  countLegacyReturnClamp,
  legacyReturnClampProvenance,
  legacyReturnClampRefusal,
  legacyReturnClampWarning,
  countLegacyClassWrap,
  legacyClassWrapRefusal,
  legacyClassWrapWarning,
} from './legacyClassGuard';

/**
 * The extended classification-flags bit that carries overlap (LAS 1.4 Table 8),
 * and the legacy record format the loss sentence is phrased against.
 */
const EXT_OVERLAP_FLAG_BIT = 0x8;
const LEGACY_PDRF_FOR_LOSS = 3;

/** Points among the first `count` whose extended flags carry overlap. */
function countOverlapFlag(flags: Uint8Array | null | undefined, count: number): number {
  if (!flags) return 0;
  let n = 0;
  for (let i = 0; i < count; i++) if ((flags[i] & EXT_OVERLAP_FLAG_BIT) !== 0) n++;
  return n;
}

/** Points whose return number or number of returns is 0. */
function countZeroReturns(g: { readonly count: number; readonly returnNumber?: Uint8Array; readonly returnCount?: Uint8Array }): number {
  const rn = g.returnNumber;
  const rc = g.returnCount;
  if (!rn && !rc) return 0;
  let n = 0;
  for (let i = 0; i < g.count; i++) if ((rn && rn[i] === 0) || (rc && rc[i] === 0)) n++;
  return n;
}

/** The refusal a LAS 1.2 write returns when the overlap flag would be dropped. */
function legacyOverlapDropRefusal(points: number): string {
  const label = `${points.toLocaleString()} point${points === 1 ? '' : 's'}`;
  return (
    `LAS 1.2 was not written. ${label} ${points === 1 ? 'carries' : 'carry'} the overlap flag, which LAS 1.2 has no place for. ` +
    `Choose LAS 1.4 to keep it, or tick "${LEGACY_OVERLAP_DROP_OPT_IN}" to write the base class without it.`
  );
}
import { planLas14Crs, writeLas, writeLas14 } from './writeLas';
import { outputCrsKind } from './outputCrsKind';
import { planQuantisation } from './lasQuantisation';
import { spatialContextFrom, verticalMetresPerUnit } from '../geo/SpatialContext';
import { planLasVertical, verifyLasVertical, verifyLasWktVertical } from './lasVerticalIdentity';
import { writeXyzBytes, writeAscBytes } from './writeAscii';
import { reprojectGlobal } from './reproject';
import type { TransformProvenance } from './transformProvenance';
import {
  epsgLabel,
  epsgDatumFamily,
  isGeocentricEpsg,
  GEOCENTRIC_REPROJECT_REFUSAL,
} from './epsg';
import {
  CONVERT_FORMATS,
  type ConvertOptions,
  type ConvertedFile,
  type ConvertReport,
  type LogEntry,
  LEGACY_ACQUISITION_LOSS_OPT_IN,
  LEGACY_CLASS_REINTERPRETATION_OPT_IN,
  LEGACY_CLASS_WRAP_OPT_IN,
  LEGACY_OVERLAP_DROP_OPT_IN,
  LEGACY_RETURN_CLAMP_OPT_IN,
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

/** Z range of the points the writer emits. */
function zRange(g: { readonly count: number; readonly z: Float64Array }): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < g.count; i++) {
    const z = g.z[i];
    if (z < min) min = z;
    if (z > max) max = z;
  }
  return { min, max };
}

/** True when a reprojection crosses into or out of NAD27. */
function nad27DatumLeg(src: number, dst: number): boolean {
  const a = epsgDatumFamily(src);
  const b = epsgDatumFamily(dst);
  return a !== b && (a === 'NAD27' || b === 'NAD27');
}

/** Convert one cloud. Returns the file (or null) and a report. */
export function convertCloud(
  cloud: PointCloud,
  opts: ConvertOptions,
): { file: ConvertedFile | null; report: ConvertReport } {
  const log: LogEntry[] = [];
  // Everything the conversion changes or loses, once: the log, the panels and
  // the written file's text area all read this list.
  const events: ConversionEvent[] = [];
  const record = (...added: ConversionEvent[]): void => {
    for (const e of added) {
      events.push(e);
      log.push(eventLogEntry(e));
    }
  };
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
  const intensityLine = cloud.intensity ? intensityNormalisationLine(cloud.metadata) : null;
  const lines = [
    ...(opts.digests ? exportDigestLines(opts.digests) : []),
    ...(opts.displaySample ? [displaySampleLine(opts.displaySample)] : []),
    pointBasisFor(cloud, opts),
    ...(opts.scopeNote ? [opts.scopeNote] : []),
    // XYZ output carries no intensity column, so it has nothing to qualify.
    ...(intensityLine && opts.format !== 'xyz' ? [intensityLine] : []),
    classEditLine(
      opts.classesEdited ?? classesEdited({ provenance: cloud.classificationProvenance, editEpoch: 0 }),
      opts.omitClassification === true,
    ),
  ];
  const provenance = lines.map(singleLine);
  // ASCII has no header slot for the build or the source name, so both lead its comment lines.
  const asciiProvenanceBase = [softwareLine(), sourceFileLine(cloud.name), ...provenance];
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
  if (g.count === 0) {
    return fail('Nothing was exported: the scan has no points in the current scope, so no file was written.');
  }
  // The written coordinates are the source coordinates. A shape classifier
  // never authorises a transformation (a surveyed facade reads as Y-up to it),
  // and nor does the viewer's display orientation, so the only axis change is
  // the rotation of a local Y-up model the request asks for explicitly. Metadata
  // decides the refusals: a kept or assigned CRS, a Z-up-by-spec format, or a
  // glTF (Y-up by spec) under a CRS. See axisHandling.ts.
  const axes = planAxisHandling({
    format: cloud.sourceFormat,
    handling: opts.axisHandling ?? 'preserve',
    mode,
    sourceCrs,
    sourceEpsg,
    targetEpsg: opts.targetEpsg ?? null,
  });
  if (!axes.ok) return fail(axes.message);
  const rotatedToZUp = axes.rotate;
  if (rotatedToZUp) {
    rotateYUpToZUp(g);
    record(yUpRotationEvent(g.count));
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
    crsNote = sourceEpsg != null ? `kept ${epsgLabel(sourceEpsg)}` : rotatedToZUp ? 'no CRS recorded (axes rotated Y-up to Z-up)' : 'no CRS recorded (coordinates unchanged)';
  } else if (mode === 'assign') {
    if (opts.targetEpsg == null) return fail('Assign mode needs a target EPSG.');
    outEpsg = opts.targetEpsg;
    crsNote = `assigned ${epsgLabel(outEpsg)} (coordinates unchanged)`;
    // The code's kind (geographic or projected) and units are resolved below;
    // a code whose kind cannot be determined refuses the export there.
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
    // proj4 has no NAD27 grids and applies a null shift (61.7 m off PROJ in
    // UTM zone 12), so a NAD27 datum leg is refused rather than written under
    // the target EPSG, where every later export would read it as exact.
    if (nad27DatumLeg(sourceEpsg, opts.targetEpsg)) {
      return fail(
        'Reproject refused: OLV has no NAD27 datum grids and would apply no NAD27 shift (tens of metres). '
        + 'Reproject with PROJ, GDAL or PDAL using the NADCON or NTv2 grids instead.',
      );
    }
    // A geocentric CRS needs a 3-D transform the reprojector does not perform.
    if (isGeocentricEpsg(sourceEpsg) || isGeocentricEpsg(opts.targetEpsg)) {
      return fail(GEOCENTRIC_REPROJECT_REFUSAL);
    }
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

  // Colour / intensity the source flags invalid have no null value in LAS, so
  // the attribute is left out of the whole file there; the ASCII writers write
  // `nan` for the flagged rows instead. Either way the file says so.
  {
    const isLas = opts.format === 'las' || opts.format === 'las14';
    const carriesColour = isLas || opts.format === 'xyz';
    const carriesIntensity = isLas || opts.format === 'asc';
    const badColour = carriesColour && g.colors ? countAttributeInvalid(g.attributeInvalid, ATTR_COLOUR_INVALID, g.count) : 0;
    const badIntensity = carriesIntensity && g.intensity ? countAttributeInvalid(g.attributeInvalid, ATTR_INTENSITY_INVALID, g.count) : 0;
    const pts = (k: number): string => `${k.toLocaleString('en-US')} point${k === 1 ? '' : 's'}`;
    const names = [badColour > 0 ? `colour (${pts(badColour)})` : '', badIntensity > 0 ? `intensity (${pts(badIntensity)})` : ''].filter(Boolean).join(' and ');
    if (names) {
      if (isLas) {
        g = { ...g, ...(badColour > 0 ? { colors: undefined } : {}), ...(badIntensity > 0 ? { intensity: undefined } : {}) };
      }
      record({
        id: 'attribute-invalid',
        kind: 'dropped',
        level: 'warn',
        points: Math.max(badColour, badIntensity),
        message: isLas
          ? `The source flags ${names} as invalid and LAS has no null value, so ${[
              badColour > 0 ? 'colour is left out of the whole file (a point format without colour is written)' : '',
              badIntensity > 0 ? 'intensity is left out of the whole file (the field holds 0 for every point and carries no measurement)' : '',
            ].filter(Boolean).join(' and ')}.`
          : `The source flags ${names} as invalid; those values are written as nan, meaning unavailable.`,
        acknowledged: false,
      });
    }
  }

  // Geographic (degrees) or not decides the GeoKey that carries the code, the
  // default LAS scale and the ASCII decimals. It comes from the RESOLVED CRS:
  // the source's own kind while the file stays in the source CRS (keep, a
  // skipped reproject, or an assign of the same code), the proj4 definition a
  // reprojection used, and the EPSG tables for a code known by number. A code
  // of unknown kind refuses: it is never taken to be projected.
  const kind = outputCrsKind({ mode, reprojectApplied, outEpsg, sourceEpsg, sourceCrs });
  if (!kind.ok) return fail(kind.message, crsNote);
  const geo = kind.geographic;
  if (mode === 'assign' && kind.unit != null) {
    log.push({
      level: 'info',
      message: `EPSG:${outEpsg} is a ${geo ? 'geographic' : 'projected'} CRS in ${kind.unit === 'us-survey-foot' ? 'US survey feet' : kind.unit === 'foot' ? 'feet' : kind.unit === 'other' ? 'a non-metre unit' : `${kind.unit}s`}.`,
    });
  }
  const filename = `${safeEntryName(baseName(cloud.name), 'converted')}${opts.displaySample ? DISPLAY_SAMPLE_SUFFIX : ''}.${spec.ext}`;

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
    // LAS 1.4 point formats 6-10 require the CRS as OGC WKT. The source's own
    // WKT is used only in keep mode (after assign or reproject it describes
    // the wrong CRS); otherwise the writer builds a verified WKT for outEpsg,
    // and refuses when it has none (planLas14Crs, below).
    const sourceWkt = opts.format === 'las14' && mode === 'keep' ? (sourceCrs?.wkt ?? null) : null;
    if (opts.format === 'las' && outEpsg != null && outEpsg > 65535) {
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
    // Vertical CRS and unit: Z is untouched by every mode, so the output
    // declares the SOURCE's own vertical unit, never the horizontal one in its
    // place; an unreadable one is left undeclared and a contradictory one
    // refuses (see lasVerticalIdentity.ts).
    // A source horizontal unit that is a valid length but not metre, foot or
    // US survey foot (a centimetre or kilometre grid) has no LAS unit key. The
    // output keeps source coordinates unless a reprojection was applied, so
    // only the source's own WKT, written verbatim in LAS 1.4, can state it.
    const byFactorUnit = sourceCrs != null && srcCtx.linearUnit === 'unknown' && srcCtx.linearUnitKnown
      && (mode === 'keep' || (mode === 'reproject' && !reprojectApplied));
    if (byFactorUnit && (opts.format === 'las' || sourceWkt == null)) {
      return fail(
        `Horizontal unit not representable: the source coordinates are in a unit of ${srcCtx.linearUnitToMetres} m, which LAS GeoKeys (metre, foot or US survey foot) cannot state. ` +
        'Nothing was written. Export as LAS 1.4 with the source WKT kept, or reproject to a metre CRS.',
        crsNote,
      );
    }
    const vertical = planLasVertical(srcCtx, sourceCrs != null, mode);
    if (!vertical.ok) return fail(vertical.message, crsNote);
    if (vertical.warning) log.push({ level: 'warn', message: vertical.warning });
    // Keep the source file's own scale and offset when they can represent
    // these coordinates; otherwise re-quantise, and say which in the file.
    const quantPlan = planQuantisation(g, cloud.metadata?.sourceQuantisation, {
      sourceFormat: cloud.sourceFormat,
      sourceOrigin: cloud.sourceOrigin,
      coordinatesChanged: reprojectApplied
        ? 'the coordinates were reprojected'
        : rotatedToZUp
          ? 'the axes were rotated into the Z-up frame'
          : null,
      angularOutput: geo,
    });
    log.push({ level: 'info', message: quantPlan.line });
    if (geo && quantPlan.use == null) {
      log.push({ level: 'info', message: 'X and Y are written at 1e-7 degree steps because the output CRS is geographic.' });
    }
    const lasProvenance = [...provenance, quantPlan.line];
    // Global Encoding bit 0 on the source, when it declared one. undefined
    // leaves the writer's modern default in place for a source that carries no
    // such declaration at all.
    const declaredGps = cloud.metadata?.gpsTimeType;
    const gpsStandardFromSource =
      declaredGps === undefined ? undefined : declaredGps === 'adjusted-standard';
    // Both writers clamp a return number or number of returns of 0 up to 1,
    // the lowest value LAS allows. That rewrites a stored value, so say so.
    const zeroReturns = countZeroReturns(g);
    if (zeroReturns > 0) {
      record({
        id: 'return-zero-raised', kind: 'clipped', level: 'warn', points: zeroReturns, acknowledged: false,
        message: `${zeroReturns.toLocaleString('en-US')} point${zeroReturns === 1 ? '' : 's'} ${zeroReturns === 1 ? 'has' : 'have'} return number or number of returns 0, which LAS does not allow; written as 1.`,
      });
    }
    if (opts.format === 'las14') {
      const semantics = planClassSemantics({
        sourcePdrf: cloud.metadata?.pointFormat,
        provenance: cloud.classificationProvenance,
        producerClassification: cloud.originalClassification,
        classification: g.classification,
        classificationFlags: g.classificationFlags,
        count: g.count,
        target: 'extended',
      });
      g = { ...g, classification: semantics.classification, classificationFlags: semantics.classificationFlags };
      record(...semantics.events);
      // The same options writeLas14 passes, so the writer's own plan can never
      // differ from this refusal: the horizontal unit decides whether a declared
      // height unit with no vertical datum is one a WKT reader would assume.
      const crsPlan = planLas14Crs({
        epsg: outEpsg, wkt: sourceWkt, isGeographic: geo, linearUnitCode,
        verticalEpsg: vertical.verticalEpsg, verticalUnitCode: vertical.unitCode,
      });
      if (!crsPlan.ok) return fail(crsPlan.message, crsNote);
      if (byFactorUnit && crsPlan.origin !== 'source') {
        return fail(
          `Horizontal unit not representable: the source coordinates are in a unit of ${srcCtx.linearUnitToMetres} m, and the source WKT that states it could not be kept. Nothing was written.`,
          crsNote,
        );
      }
      if (crsPlan.sourceWktRejected) {
        log.push({ level: 'warn', message: `The source WKT is not a usable definition; the CRS is written as the WKT for EPSG:${outEpsg}.` });
      }
      if (crsPlan.wkt != null) {
        log.push({
          level: 'info',
          message:
            `CRS written as OGC WKT${crsPlan.origin === 'source' ? ' from the source WKT' : ` for EPSG:${outEpsg}`}${crsPlan.compound ? ' with its vertical CRS' : ''}` +
            `${crsPlan.evlr ? ', in an extended VLR because it exceeds the 65,535-byte VLR limit' : ''}.`,
        });
      }
      const record14 = fitProvenance(lasProvenance, datumNote, events);
      if (record14.trimmed) log.push({ level: 'warn', message: provenanceTrimmedMessage(record14.eventsOmitted) });
      bytes = writeLas14(g, {
        gpsStandardTime: gpsStandardFromSource,
        epsg: outEpsg ?? undefined,
        isGeographic: geo,
        linearUnitCode,
        verticalEpsg: vertical.verticalEpsg,
        verticalUnitCode: vertical.unitCode,
        wkt: crsPlan.wkt,
        description: datumNote,
        provenance: record14.lines,
        quantisation: quantPlan.use ?? undefined,
      });
    } else {
      // LAS 1.2 stores the classification in 5 bits and the writer masks
      // (`& 0x1f`), so a class above 31 WRAPS onto another valid class: 33
      // reads back as 1 and 64 as 0, and the file opens without an error.
      // That is refused unless the request opts in; opted in, the write goes
      // ahead and the wrap is logged with its arithmetic. Only the `count`
      // records the writer emits are judged.
      const wrap = countLegacyClassWrap(g.classification?.subarray(0, g.count));
      // Return number and number of returns are 3 bits each in LAS 1.2, and the
      // writer clamps them to 7, which changes which return a point is.
      const clamped = countLegacyReturnClamp(g.returnNumber, g.returnCount, g.count);
      // The scan angle is clipped to 90 degrees and the scanner channel has no
      // field.
      const acquisition = assessLegacyAcquisition(g.scanAngle, g.scannerChannel, g.count);
      const acquisitionLoss = isMaterialAcquisitionLoss(acquisition);
      // Numbers whose meaning differs between the two class tables. The number
      // is written as it is, so a reader of the file would read another class.
      const semantics = planClassSemantics({
        sourcePdrf: cloud.metadata?.pointFormat,
        provenance: cloud.classificationProvenance,
        producerClassification: cloud.originalClassification,
        classification: g.classification,
        classificationFlags: g.classificationFlags,
        count: g.count,
        target: 'legacy',
      });
      // The extended encoding carries overlap as a flag bit beside a real base
      // class; the legacy byte has nowhere to put it, so `writeLas` composes
      // only the synthetic/key-point/withheld bits and the overlap mark is lost.
      const overlapped = countOverlapFlag(g.classificationFlags, g.count);
      // Each loss is refused unless the request allows that loss, and one
      // refusal names every loss that is not allowed.
      const refusals: LegacyRefusal[] = [];
      if (wrap.points > 0 && !opts.allowLegacyClassWrap) {
        refusals.push({ text: legacyClassWrapRefusal(wrap), optIn: LEGACY_CLASS_WRAP_OPT_IN });
      }
      if (clamped > 0 && !opts.allowLegacyReturnClamp) {
        refusals.push({ text: legacyReturnClampRefusal(clamped), optIn: LEGACY_RETURN_CLAMP_OPT_IN });
      }
      if (acquisitionLoss && !opts.allowLegacyAcquisitionLoss) {
        refusals.push({ text: acquisitionLossRefusal(acquisition, LEGACY_ACQUISITION_LOSS_OPT_IN), optIn: LEGACY_ACQUISITION_LOSS_OPT_IN });
      }
      if (semantics.changes.length > 0 && !opts.allowLegacyClassReinterpretation) {
        refusals.push({ text: legacyClassReinterpretationRefusal(semantics.changes), optIn: LEGACY_CLASS_REINTERPRETATION_OPT_IN });
      }
      if (overlapped > 0 && !opts.allowLegacyOverlapDrop) {
        refusals.push({ text: legacyOverlapDropRefusal(overlapped), optIn: LEGACY_OVERLAP_DROP_OPT_IN });
      }
      if (refusals.length > 0) return fail(combineRefusals(refusals), crsNote);
      if (wrap.points > 0) {
        record({
          id: 'class-wrap', kind: 'clipped', level: 'warn', points: wrap.points,
          message: legacyClassWrapWarning(wrap.points), acknowledged: true,
        });
      }
      if (clamped > 0) {
        record({
          id: 'return-clamp', kind: 'clipped', level: 'warn', points: clamped,
          message: legacyReturnClampWarning(clamped), record: legacyReturnClampProvenance(clamped), acknowledged: true,
        });
      }
      record(...acquisitionEvents(acquisition, acquisitionLoss));
      // Only reached when the request allowed these losses, so the record
      // says the loss was allowed.
      record(...semantics.events.map((e) => (e.kind === 'reinterpreted' ? { ...e, acknowledged: true } : e)));
      if (overlapped > 0) {
        const loss = describeLoss(inspectLegacyConversion([], true), LEGACY_PDRF_FOR_LOSS);
        record({
          id: 'overlap-dropped', kind: 'dropped', level: 'warn', points: overlapped, acknowledged: true,
          message: `LAS 1.2 cannot record the overlap flag \u2014 ${overlapped.toLocaleString()} point${overlapped === 1 ? '' : 's'} ${overlapped === 1 ? 'carries' : 'carry'} it and ${loss}; the base class is written and the overlap mark is dropped. Use LAS 1.4 to preserve it.`,
        });
      }
      const recordLegacy = fitProvenance(lasProvenance, datumNote, events);
      if (recordLegacy.trimmed) log.push({ level: 'warn', message: provenanceTrimmedMessage(recordLegacy.eventsOmitted) });
      bytes = writeLas(g, {
        // Declare the time the source declared. Adjusted Standard GPS Time and
        // GPS Week Time are different quantities, so carrying the values across
        // unchanged while relabelling them changes what they mean. A source
        // that did not say keeps the modern default.
        gpsStandardTime: gpsStandardFromSource,
        epsg: outEpsg ?? undefined,
        isGeographic: geo,
        linearUnitCode,
        verticalEpsg: vertical.verticalEpsg,
        verticalUnitCode: vertical.unitCode,
        description: datumNote,
        provenance: recordLegacy.lines,
        quantisation: quantPlan.use ?? undefined,
      });
    }
    const z = zRange(g);
    const zToMetres = (crs: CrsInfo): number | undefined => verticalMetresPerUnit(spatialContextFrom(crs), 'horizontal-when-known');
    const verticalProblem = verifyLasVertical(bytes, vertical, z.min, z.max, zToMetres) ?? verifyLasWktVertical(bytes, vertical, zToMetres);
    if (verticalProblem) return fail(verticalProblem, crsNote);
  } else {
    // ASCII holds fewer columns than the cloud: say which were left out, here
    // and in the file's own header.
    const dropped = asciiDroppedFieldsEvent(g, opts.format === 'asc' ? 'asc' : 'xyz');
    if (dropped) record(dropped);
    const asciiProvenance = [...asciiProvenanceBase, ...events.map(eventRecordLine)];
    bytes =
      opts.format === 'asc'
        ? writeAscBytes(g, { precision: opts.asciiPrecision, epsg: outEpsg, crsName: sourceCrs?.name ?? null, geographic: geo, datumNote, provenance: asciiProvenance })
        : writeXyzBytes(g, opts.asciiPrecision ?? 3, geo, datumNote, asciiProvenance, { epsg: outEpsg, crsName: sourceCrs?.name ?? null });
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
      events,
      // Only reproject mode produces provenance; keep/assign omit the field.
      ...(transformProvenance ? { provenance: transformProvenance } : {}),
    },
  };
  }
}

/** Source-file digest and CRS origin for this export's provenance, resolved off the main thread. */
export { resolveExportDigests } from '../export/exportDigests';

/**
 * The point-basis line every converted file carries: the caller's own line, or
 * the cloud's own basis (a truncated file is named as such; a display sample
 * when `displaySample` is set or the cloud reads as strided).
 */
function pointBasisFor(cloud: PointCloud, opts: ConvertOptions): string {
  if (opts.pointBasis) return opts.pointBasis;
  const sample = opts.displaySample;
  if (sample && !truncationOf(cloud)) return pointBasisLine(false, sample.held, sample.source);
  return pointBasisOfCloud(cloud, sample ? true : null);
}
