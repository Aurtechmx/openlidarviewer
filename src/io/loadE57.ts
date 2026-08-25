/**
 * loadE57.ts
 *
 * Adapts the from-scratch E57 parser (`io/e57/`) to a `PointCloud`. It merges
 * every scan in the file, applies each scan's pose, filters points flagged
 * invalid, and bridges global coordinates into the viewer's local space — the
 * same coordinate bridge the LAS loader uses, so an E57 behaves natively.
 *
 * Scope: the common real-world E57 files mainstream scanners produce —
 * Cartesian XYZ plus colour / intensity / classification / normals. Multi-scan
 * files merge into one cloud.
 */

import { parseE57 } from './e57/parseE57';
import type { E57ScanData } from './e57/parseE57';
import type { E57Metadata, E57Pose, E57SourceMetadata } from './e57/schema';
import { preflightE57, e57FieldIsConsumedForScan, e57LocalFieldName } from './e57/preflight';
import { planE57Decode, e57TooLargeMessage, e57NoPlanMessage } from './loadPlan';
import type { E57DecodePlan } from './loadPlan';
import { formatByteSize } from './formatByteSize';
import { LoadError } from './loadErrors';
import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import { declaredCaptureFromSourceMetadata } from '../diagnostics/declaredCapture';
import { sanitizeAndRecenter } from './sanitizeCloud';

/** Clamp a value into the 0–255 byte range. */
function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

/** Clamp a value into the 0–65535 uint16 range. */
function clampU16(v: number): number {
  if (v < 0) return 0;
  if (v > 65535) return 65535;
  return Math.round(v);
}

/**
 * Per-scan scale that carries intensity into the Uint16 store. E57 intensity
 * is commonly a UNIT-RANGE FLOAT (a real user file declares intensityLimits
 * 0.2800009–0.7380647): rounding those floats straight into a Uint16
 * collapsed the whole continuous channel to {0, 1} — silent destruction that
 * reached every downstream surface, including the CSV/XYZ exports. This
 * mirrors the PTS/PCD house rule: a unit-range channel (declared
 * intensityMaximum ≤ 1 when the scan declares limits, otherwise an observed
 * maximum ≤ 1) is rescaled to the full 0–65535 span — absolute values scale
 * by 65535, they are NOT min–max stretched, so the declared magnitudes keep
 * their meaning. A wider range is taken as a raw value and only clamped.
 */
function intensityScaleFor(scan: E57ScanData): number {
  const col = scan.columns.intensity;
  if (!col) return 1;
  if (scan.intensityMax !== null) {
    return scan.intensityMax > 0 && scan.intensityMax <= 1 ? 65535 : 1;
  }
  let max = 0;
  for (const v of col) if (v > max) max = v;
  return max > 0 && max <= 1 ? 65535 : 1;
}

/** Rotate a point by a quaternion `[w, x, y, z]`. */
function rotate(
  px: number,
  py: number,
  pz: number,
  q: [number, number, number, number],
): [number, number, number] {
  const [w, x, y, z] = q;
  // t = 2 · (q.xyz × p)
  const tx = 2 * (y * pz - z * py);
  const ty = 2 * (z * px - x * pz);
  const tz = 2 * (x * py - y * px);
  // p + w·t + (q.xyz × t)
  return [
    px + w * tx + (y * tz - z * ty),
    py + w * ty + (z * tx - x * tz),
    pz + w * tz + (x * ty - y * tx),
  ];
}

/**
 * Count a scan's valid points (those not flagged by `cartesianInvalidState`).
 * A scan with no Cartesian X/Y/Z columns counts as ZERO: the merge loop skips
 * it entirely, so counting its records would size the merged arrays for
 * points that are never written — phantom zero-coordinate points parked at
 * the local origin. The count and the merge must agree on what merges.
 */
function countValid(scan: E57ScanData): number {
  const col = scan.columns;
  if (!col.cartesianX || !col.cartesianY || !col.cartesianZ) return 0;
  const invalid = col.cartesianInvalidState;
  if (!invalid) return scan.recordCount;
  let valid = 0;
  for (let i = 0; i < scan.recordCount; i++) if (invalid[i] === 0) valid++;
  return valid;
}

/** Build provenance metadata from the E57 file metadata. */
function e57Metadata(
  meta: E57Metadata,
  sourceMetadata: E57SourceMetadata | null,
  mergedScanCount: number,
  warnings: readonly string[],
): CloudMetadata | undefined {
  const out: CloudMetadata = {};
  if (meta.library) out.sourceSoftware = meta.library;
  if (mergedScanCount > 1) out.captureSensor = `${sourceMetadata?.standard.find((f) => (f.name === 'sensorModel' || f.name.endsWith(' sensorModel')) && f.value.trim().length > 0)?.value.trim() ?? 'sensor not declared'} (${mergedScanCount} merged scans)`;
  if (warnings.length > 0) out.loadWarnings = [...warnings];
  // Declared-only source metadata (standard + extension-namespace fields).
  // Carried as-declared; every surface that renders it must qualify it as
  // declared by the file, not verified.
  if (
    sourceMetadata &&
    (sourceMetadata.standard.length > 0 || sourceMetadata.extensions.length > 0)
  ) {
    out.sourceMetadata = sourceMetadata;
    // Precompute the declared-capture statement HERE (lazy loader chunk) so
    // the classifier wiring in the startup shell reads a plain field instead
    // of carrying the keyword scan.
    const declared = declaredCaptureFromSourceMetadata(sourceMetadata);
    if (declared) out.declaredCapture = declared;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Per-device tuning for the E57 decode plan. */
export interface LoadE57Options {
  /** True on phones — tightens the memory ceiling. */
  isMobile?: boolean;
  /** `navigator.deviceMemory` in GB, when the runtime reports it. */
  deviceMemoryGB?: number;
  /**
   * The decode plan the caller has already built from this file's declaration.
   * Supplied, it is used as given and nothing is re-planned: the stride applied
   * is the stride the caller's preload summary named.
   *
   * `loadFile` builds this on the main thread and posts it to the parse worker.
   * The plan is device-dependent (`memoryCeilingBytes` halves the ceiling on a
   * phone) and the mobile signal is a `matchMedia` query, which exists on
   * `Window` and not on a worker global scope. A worker that planned for itself
   * would therefore plan as a desktop for a phone user, applying a stride, or a
   * full decode, that the main thread had ruled out.
   */
  plan?: E57DecodePlan;
}

/**
 * Device signals for the decode plan, read from whatever runtime the loader
 * finds itself in.
 *
 * The touch-first mobile test is spelled out here rather than imported from the
 * UI layer, for the reason `io/workerPool/decodePoolSize.ts` gives for the same
 * duplication: `src/io` must not depend on `src/ui` for a decision this small.
 * Never throws. A DOM-free environment (a Node test, a worker global scope,
 * neither of which has `matchMedia`) reports no mobile signal and lands on the
 * desktop defaults. Those defaults are a LARGER ceiling than a phone's
 * (`memoryCeilingBytes` takes 0.6 of reported memory against mobile's 0.4, and
 * falls back to 1.5 GB against mobile's 600 MB), so this is not a safe place to
 * decide for a phone user. `LoadE57Options.plan` is how the main thread's
 * verdict reaches a worker.
 */
function readDeviceHints(): Required<Pick<LoadE57Options, 'isMobile'>> & LoadE57Options {
  let deviceMemoryGB: number | undefined;
  try {
    const mem = (globalThis as { navigator?: { deviceMemory?: number } }).navigator?.deviceMemory;
    deviceMemoryGB = typeof mem === 'number' && mem > 0 ? mem : undefined;
  } catch {
    /* no navigator — the fallback ceiling covers it */
  }
  let isMobile = false;
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    if (typeof mm === 'function') {
      isMobile = mm.call(globalThis, '(pointer: coarse) and (hover: none)').matches;
    }
  } catch {
    /* matchMedia unavailable — treat as desktop, clamped anyway */
  }
  return { isMobile, deviceMemoryGB };
}

/**
 * Read the file's own declaration and plan the decode from it. The fallback for
 * a caller with no plan of its own: the batch converter's full-resolution
 * decode, and any direct `loadE57` call.
 *
 * FAILS CLOSED. A file that reaches here carries the E57 signature, so the
 * memory guard applies to it, and a declaration that will not parse leaves no
 * stride, no estimate and no ceiling to check against. The previous code caught
 * this and left `plan` undefined, which `plan?.stride ?? 1` then read as a full
 * decode: a preflight failure turned the guard off on exactly the files it
 * exists for. The same shape `isLinearUnitKnown()` fixed for CRS units.
 */
function planFromDeclaration(
  buffer: ArrayBuffer,
  name: string,
  options?: LoadE57Options,
): E57DecodePlan {
  const hints = { ...readDeviceHints(), ...options };
  try {
    const declared = preflightE57(buffer);
    return planE57Decode({
      sourceCount: declared.recordCount,
      fileBytes: buffer.byteLength,
      columnsPerRecord: declared.columnsPerRecord,
      attributes: declared.attributes,
      isMobile: hints.isMobile ?? false,
      deviceMemoryGB: hints.deviceMemoryGB,
    });
  } catch (err) {
    throw new LoadError(
      'malformed-file',
      e57NoPlanMessage(name, err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Load an `.e57` file into a `PointCloud`. Every scan is merged; invalid
 * points are dropped; positions are recentred about a floored-min origin.
 *
 * Before any of that, the file's own XML declaration is read (a few KB, no
 * point decode) and turned into a decode plan: read every record, read one
 * record per bucket at the smallest stride that fits memory, or refuse. A
 * strided load is a SAMPLE, and it says so — `loadStride` and the declared
 * source count travel with the cloud, so the Health Check, the export scope
 * note and the density disclosures all describe what was actually read.
 */
export async function loadE57(
  buffer: ArrayBuffer,
  name = 'cloud.e57',
  options?: LoadE57Options,
): Promise<PointCloud> {
  // A field's LOCAL name, after any extension `prefix:` (so `nor:normalX` →
  // `normalX`). Used both to resolve namespaced normals and to decide which
  // columns are worth decoding at all.
  const localName = e57LocalFieldName;

  // How this file will be decoded, before a point is read. This is the whole
  // reason E57 can have a budget plan at all: LAS/LAZ expose a point count in
  // their public header, and E57 exposes the same facts in its XML section,
  // which the preflight reaches with two small reads.
  //
  // A caller that already read that declaration passes its plan in, and it is
  // used as given. `loadFile` does exactly that, so the decode applies the
  // stride its preload summary named. Everything else plans here.
  const plan = options?.plan ?? planFromDeclaration(buffer, name, options);
  // Refuse BEFORE decoding. Starting a read already known not to fit is how the
  // tab died: nothing in the app can close a scan that killed the process it
  // was loading in, so the user just loses the session.
  if (!plan.fits) {
    throw new LoadError('memory-constraint', e57TooLargeMessage(name, plan));
  }
  const stride = plan.stride;

  // Decode only the columns this loader consumes. Anything else a file declares
  // — a structured scan's rowIndex / columnIndex, spherical coordinates this
  // loader does not project — would otherwise be expanded into a full Float64
  // column and then immediately dropped: hundreds of MB of allocation and
  // per-value conversion on a tens-of-millions-of-points scan. The predicate
  // resolves per scan, and the preflight resolves its column count through the
  // same function, so the plan's count and the decode's cannot disagree.
  const parsed = parseE57(buffer, { keepField: e57FieldIsConsumedForScan, stride });

  // Partition the scans FIRST: a scan without Cartesian X/Y/Z (spherical-only,
  // for example) contributes no points, so it must contribute nothing to the
  // counts or the attribute decisions either. Merging its record count while
  // skipping its points left `total − written` phantom points frozen at the
  // local origin (the pre-v0.5.4 behaviour) — silent data corruption. The
  // skipped scan is named in a load warning so the user knows the merged
  // cloud is a subset of the file. Parser-level anomalies (a normalised or
  // degenerate pose quaternion) ride the same channel.
  const warnings: string[] = [...parsed.warnings];
  const scans: E57ScanData[] = [];
  for (const scan of parsed.scans) {
    const col = scan.columns;
    if (col.cartesianX && col.cartesianY && col.cartesianZ) {
      scans.push(scan);
    } else {
      warnings.push(
        `Scan "${scan.name}" carries no Cartesian X/Y/Z (spherical-only scans ` +
          `are not supported) — skipped ${scan.declaredRecordCount.toLocaleString('en-US')} ` +
          `point record(s).`,
      );
    }
  }

  // An attribute is merged only when every MERGED scan provides it — a skipped
  // scan must not veto colour/intensity the merged scans all carry.
  const has = (field: string): boolean => scans.every((s) => s.columns[field] !== undefined);
  // Surface normals ride the E57 `nor:` surface-normals extension, so the
  // decoded column is keyed `nor:normalX` — not the bare `normalX` the core
  // Cartesian/colour fields use. Resolve by LOCAL name (via `localName` above)
  // so real scanner files that carry normals aren't decoded and then silently
  // dropped, which also left the Viewer's normal-shading mode dark for exactly
  // the files that provide the data it needs.
  const normalKey = (cols: E57ScanData['columns'], axis: 'X' | 'Y' | 'Z'): string | undefined => {
    const bare = `normal${axis}`;
    if (cols[bare]) return bare;
    return Object.keys(cols).find((k) => localName(k) === bare);
  };
  const hasColor = has('colorRed') && has('colorGreen') && has('colorBlue');
  const hasIntensity = has('intensity');
  const hasClassification = has('classification');
  const hasNormals = scans.every(
    (s) => normalKey(s.columns, 'X') && normalKey(s.columns, 'Y') && normalKey(s.columns, 'Z'),
  );

  let total = 0;
  for (const scan of scans) total += countValid(scan);
  if (total === 0) throw new Error('E57: the file contains no valid points.');

  const global = new Float64Array(total * 3);
  const colors = hasColor ? new Uint8Array(total * 3) : undefined;
  const intensity = hasIntensity ? new Uint16Array(total) : undefined;
  const classification = hasClassification ? new Uint8Array(total) : undefined;
  const normals = hasNormals ? new Float32Array(total * 3) : undefined;

  let w = 0; // running point index across all merged scans
  for (const scan of scans) {
    const col = scan.columns;
    // The partition above guarantees these columns exist on every merged scan.
    const cx = col.cartesianX;
    const cy = col.cartesianY;
    const cz = col.cartesianZ;
    const invalid = col.cartesianInvalidState;
    const pose: E57Pose | null = scan.pose;
    const colorScale = scan.colorMax && scan.colorMax > 0 ? 255 / scan.colorMax : 1;
    const intensityScale = intensity ? intensityScaleFor(scan) : 1;
    // Resolve the (possibly namespaced) normal columns once per scan, not per
    // point. `hasNormals` guarantees all three keys resolve on every merged scan.
    const nX = normals ? col[normalKey(col, 'X')!] : undefined;
    const nY = normals ? col[normalKey(col, 'Y')!] : undefined;
    const nZ = normals ? col[normalKey(col, 'Z')!] : undefined;

    for (let i = 0; i < scan.recordCount; i++) {
      if (invalid && invalid[i] !== 0) continue;

      let px = cx[i];
      let py = cy[i];
      let pz = cz[i];
      if (pose) {
        const r = rotate(px, py, pz, pose.rotation);
        px = r[0] + pose.translation[0];
        py = r[1] + pose.translation[1];
        pz = r[2] + pose.translation[2];
      }
      global[w * 3] = px;
      global[w * 3 + 1] = py;
      global[w * 3 + 2] = pz;

      if (colors && col.colorRed && col.colorGreen && col.colorBlue) {
        colors[w * 3] = clampByte(col.colorRed[i] * colorScale);
        colors[w * 3 + 1] = clampByte(col.colorGreen[i] * colorScale);
        colors[w * 3 + 2] = clampByte(col.colorBlue[i] * colorScale);
      }
      if (intensity && col.intensity) intensity[w] = clampU16(col.intensity[i] * intensityScale);
      if (classification && col.classification) {
        classification[w] = clampByte(col.classification[i]);
      }
      if (normals && nX && nY && nZ) {
        let nx = nX[i];
        let ny = nY[i];
        let nz = nZ[i];
        // Normals are DIRECTIONS: they transform by the pose ROTATION only,
        // never the translation. Copying them verbatim (the pre-v0.5.4
        // behaviour) left every rotated scan's normals pointing where the
        // scanner saw them, not where the merged geometry now faces —
        // silently wrong lighting/orientation for any posed multi-scan file.
        if (pose) {
          const r = rotate(nx, ny, nz, pose.rotation);
          nx = r[0];
          ny = r[1];
          nz = r[2];
        }
        normals[w * 3] = nx;
        normals[w * 3 + 1] = ny;
        normals[w * 3 + 2] = nz;
      }
      w++;
    }
  }

  // Defence in depth: the merge must write EXACTLY the count it declared.
  // A drift means countValid and the merge loop disagree about what merges,
  // and the unwritten tail would ship as zero-coordinate phantom points at
  // the origin — the corruption class this whole partition exists to prevent.
  if (w !== total) {
    throw new Error(
      `E57: merged ${w} points but counted ${total} — internal merge/count mismatch.`,
    );
  }

  // Drop points the file marked valid but wrote non-finite — a truncated or
  // corrupt CompressedVector reaches here as a NaN — then recentre the
  // survivors about their floored-min origin. The exclusion joins the same
  // warning list the skipped-scan and normalised-pose notes already use.
  const clean = sanitizeAndRecenter(global, { colors, intensity, classification, normals });
  if (clean.warning) warnings.push(clean.warning);

  // A strided load is a SAMPLE of the scan, and this project does not let a
  // sample pass as the whole. Three things carry that:
  //
  //   - `loadStride` and a `declaredPointCount` that stays the FILE's declared
  //     total, which is what the Health Check's declared-vs-decoded row and the
  //     exporters' SUBSET scope line both read;
  //   - the load warning below, which states the sampling in words on every
  //     surface that renders `loadWarnings`;
  //   - nothing else. In particular no count is scaled back up to pretend the
  //     missing records were read.
  //
  // At stride 1 every one of these is the no-op it was before: the declared and
  // decoded counts stay equal and no warning is added.
  if (stride > 1) {
    warnings.push(
      `Read as a sample: one record per ${stride} (stride ${stride}) — ` +
        `${total.toLocaleString('en-US')} of ${plan.sourceCount.toLocaleString('en-US')} ` +
        `declared point records. Reading every record needs about ` +
        `${formatByteSize(plan.fullDecodeEstimateBytes)}, above the ` +
        `${formatByteSize(plan.ceilingBytes)} budget for this device. Point counts, ` +
        `densities and anything derived from them describe this sample, not the whole ` +
        `scan. Convert to COPC or EPT (PDAL or untwine) to work with all of it.`,
    );
  }

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    intensity: clean.attributes.intensity,
    classification: clean.attributes.classification,
    normals: clean.attributes.normals,
    origin: clean.origin,
    sourceFormat: 'e57',
    name,
    declaredPointCount: stride > 1 ? plan.sourceCount : total,
    decodedPointCount: total,
    loadStride: stride,
    metadata: e57Metadata(parsed.metadata, parsed.sourceMetadata, scans.length, warnings),
  });
}
