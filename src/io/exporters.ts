/**
 * exporters.ts
 *
 * Serialise a `PointCloud` back out to common point-cloud formats: XYZ, CSV,
 * PLY (ASCII) and OBJ. Pure functions — no DOM, no three.js — so they are
 * straightforward to unit-test; the UI layer handles turning the result into
 * a download.
 *
 * Coordinates are written in **global** space (the cloud's local positions
 * plus its `sourceOrigin`), so an exported file carries real-world survey
 * coordinates and round-trips back through the importers at the written
 * precision — each text importer re-reads coordinates in float64 and
 * recentres before narrowing to float32 (PLY declares `double` x/y/z so
 * third-party readers keep that precision too).
 *
 * Two honesty rules (v0.5.4) apply to every format with a comment
 * convention (XYZ `#`, PLY `comment`, OBJ `#`):
 *
 *   - **Declared provenance rides along.** When the cloud carries
 *     `CloudMetadata.sourceMetadata`, the header states the exporter +
 *     version, the source file name, the declared source (sensorModel or
 *     scan name), the declared license and limitations when present — each
 *     verbatim, single-line-sanitised, and explicitly qualified as declared
 *     by the file, not verified by OpenLiDARViewer. A cloud that declares
 *     nothing gets no section, so metadata-less exports stay byte-identical
 *     to earlier releases.
 *   - **Dropped channels are disclosed.** A channel the cloud carries but
 *     the writer does not put in the file (intensity/classification in OBJ,
 *     everything beyond xyz+rgb in PLY, normals in XYZ) is named in a
 *     comment — a silent drop looks identical to "the source never had it".
 *
 * A third rule (v0.6.0): **non-finite points are dropped, and the drop is
 * disclosed.** `toFixed` serialises NaN as a literal `NaN` token, so a point
 * with any non-finite coordinate is skipped, declared counts follow the
 * emitted rows, and the omission count is stated through the same comment
 * channel.
 *
 * A fourth rule (v0.6.0): **a sampled cloud says so.** When the viewer holds
 * fewer points than the file declared — a display-sample cap, a load stride —
 * the header states how many of how many were written and what caused it.
 * Without it the export is indistinguishable from a complete export of a
 * smaller scan, which is the dropped-channel failure one level up.
 *
 * CSV is the deliberate exception to the comment rules: it has no comment
 * convention naive parsers survive, so it stays pure data — header row, then
 * rows. Its provenance story is the source file itself, and a non-finite
 * point is dropped without an in-file note.
 */

import type { PointCloud } from '../model/PointCloud';
import type { SourceMetadata, DeclaredMetadataField } from '../model/PointCloud';

/** The export formats this module produces. */
export type ExportFormat = 'xyz' | 'csv' | 'ply' | 'obj';

/** Format a coordinate to millimetre precision without exponent notation. */
function coord(v: number): string {
  return v.toFixed(3);
}

/** True when point `i` has three finite coordinates — writable as text. */
function isFinitePoint(positions: Float32Array, i: number): boolean {
  return (
    Number.isFinite(positions[i * 3]) &&
    Number.isFinite(positions[i * 3 + 1]) &&
    Number.isFinite(positions[i * 3 + 2])
  );
}

/** Points whose coordinates are all finite; only these are serialised. */
function finitePointCount(positions: Float32Array, n: number): number {
  let finite = 0;
  for (let i = 0; i < n; i++) if (isFinitePoint(positions, i)) finite++;
  return finite;
}

/** Disclosure line for skipped non-finite points (comment prefix per format). */
function omittedPointsLine(omitted: number): string {
  return `${omitted} point${omitted === 1 ? '' : 's'} with non-finite coordinates — omitted`;
}

/**
 * Disclosure line for a cloud that holds fewer points than its file declared.
 *
 * The dropped-channel rule exists because a silent drop looks identical to
 * "the source never had it". Dropped POINTS are the same failure one level up:
 * a display-sample cap or a load stride leaves the viewer holding a fraction
 * of the file, and the export then looks exactly like a complete export of a
 * smaller scan. Nothing in the file contradicts that reading, so the reader
 * has no way to discover it.
 *
 * Only a declared count can establish the full size, so a cloud that declares
 * nothing stays silent rather than guessing. A cloud holding at least what it
 * declared is not a subset — a merge or a densify legitimately lands there, and
 * calling it one would be its own false statement.
 */
function subsetLine(cloud: PointCloud): string | null {
  const declared = cloud.declaredPointCount;
  if (declared === undefined || !Number.isFinite(declared)) return null;
  const held = cloud.pointCount;
  if (held >= declared) return null;
  const pct = (held / declared) * 100;
  // Two significant-ish digits: "12.3 %" for a typical cap, "0.4 %" for a
  // heavy stride, never "0.0 %" for something that did write points.
  const share = pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct.toFixed(2);
  const stride = cloud.loadStride;
  const cause =
    stride !== undefined && stride > 1
      ? ` (load stride ${stride} — one record kept per ${stride})`
      : '';
  return (
    `SUBSET: ${held.toLocaleString('en-US')} of ${declared.toLocaleString('en-US')} ` +
    `points the source declared (${share} %)${cause} — this file is a sample of the ` +
    `scan, not the whole scan`
  );
}

/**
 * Horizontal-coordinate formatter (v0.4.5, workplan C5 — extended to PLY/OBJ
 * in v0.5.4). Projected/local frames keep the millimetre 3 dp; a GEOGRAPHIC
 * CRS gets 7 dp, because 3 dp of a degree is ~110 m of position — the old
 * fixed precision silently destroyed lat/lon exports. 1e-7° ≈ 1.1 cm at the
 * equator, matching the survey convention for degree output. Z stays 3 dp
 * in both cases (heights are linear units even in a geographic CRS).
 */
function horizontalCoordFormatter(cloud: PointCloud): (v: number) => string {
  return cloud.metadata?.crs?.isGeographic === true ? (v) => v.toFixed(7) : coord;
}

// ─────────────────────────────────────────────────────────────────────────────
// Declared provenance + channel-drop disclosure (v0.5.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Longest declared value quoted into a header line before truncation. */
const DECLARED_VALUE_MAX = 160;

/**
 * Collapse a declared value to one line and cap its length — a declared
 * string is verbatim FILE data, so it must never be able to inject a line
 * break (which would corrupt line-oriented formats) or swallow a header in
 * pathological lengths. Truncation is disclosed by the ellipsis.
 */
function declaredLine(v: string): string {
  const flat = v.replace(/\s+/g, ' ').trim();
  return flat.length > DECLARED_VALUE_MAX ? `${flat.slice(0, DECLARED_VALUE_MAX)}…` : flat;
}

/**
 * Find a declared field by its local name. Multi-scan files prefix per-scan
 * fields ("scan 2 sensorModel"), so the suffix match covers both shapes;
 * standard fields win over extension-namespace ones of the same name.
 */
function declaredField(
  meta: SourceMetadata,
  name: string,
): DeclaredMetadataField | undefined {
  const match = (f: DeclaredMetadataField): boolean =>
    f.name === name || f.name.endsWith(` ${name}`);
  return meta.standard.find(match) ?? meta.extensions.find(match);
}

/**
 * The declared-provenance header lines (WITHOUT a comment prefix — each
 * format prepends its own). Emitted only when the cloud carries declared
 * source metadata; everything quoted is the file's own declaration, so the
 * block closes with the standing not-verified disclosure.
 */
function provenanceLines(cloud: PointCloud): string[] {
  const meta = cloud.metadata?.sourceMetadata;
  if (!meta || (meta.standard.length === 0 && meta.extensions.length === 0)) return [];
  const lines: string[] = [
    `exported by OpenLiDARViewer v${__APP_VERSION__}`,
    `source file: ${declaredLine(cloud.name)}`,
  ];
  const source = declaredField(meta, 'sensorModel') ?? declaredField(meta, 'name');
  if (source) lines.push(`declared source: ${declaredLine(source.value)}`);
  const license = declaredField(meta, 'license');
  if (license) lines.push(`declared license: ${declaredLine(license.value)}`);
  const limitations = declaredField(meta, 'limitations');
  if (limitations) lines.push(`declared limitations: ${declaredLine(limitations.value)}`);
  lines.push('declared by the file, not verified by OpenLiDARViewer');
  return lines;
}

/**
 * Disclosure lines for channels the cloud carries but `carried` says the
 * writer does not put in the file. `unrepresentable` names channels the
 * FORMAT cannot express (worded "not representable"); everything else the
 * format could express but this writer does not is worded honestly as
 * "not written by this exporter".
 */
function droppedChannelLines(
  cloud: PointCloud,
  carried: { intensity?: boolean; classification?: boolean; normals?: boolean },
  unrepresentable: readonly string[],
): string[] {
  const dropped: string[] = [];
  if (cloud.intensity && !carried.intensity) dropped.push('intensity');
  if (cloud.classification && !carried.classification) dropped.push('classification');
  if (cloud.normals && !carried.normals) dropped.push('normals');
  return dropped.map((ch) =>
    unrepresentable.includes(ch)
      ? `${ch} channel not representable in OBJ — omitted`
      : `${ch} channel not written by this exporter — omitted`,
  );
}

/**
 * Serialise to plain-text XYZ (or CSV when `delimiter` is `,`).
 * Columns: `x y z`, then — each only when the cloud carries the channel —
 * `r g b` (0–255), `intensity` (the 16-bit store, 0–65535; unit-range float
 * sources are rescaled ×65535 at load) and `classification` (raw ASPRS
 * code). A CSV always gets a header row naming the columns; an XYZ gets
 * `#` comment lines (provenance, channel notes, `# columns: …`) only when
 * there is something to say — a plain x-y-z file stays byte-identical to
 * earlier releases. Importers — ours included — skip `#` comment lines by
 * long-standing XYZ convention. A CSV never gets comment lines: naive CSV
 * parsers must always see the header row first.
 */
export function toXyz(cloud: PointCloud, delimiter = ' '): string {
  // World coordinates come from the SOURCE origin, which is fixed for the
  // cloud's life. `origin` moves when a layer mounts into a project frame;
  // sourceOrigin does not, so an export stays in the file's real-world frame
  // regardless of project membership. (Today the two coincide — mounting is
  // off — so this is a no-op that stays correct once mounting rebases layers.)
  const { positions, colors, sourceOrigin } = cloud;
  const n = cloud.pointCount;
  const omitted = n - finitePointCount(positions, n);
  const lines: string[] = [];
  const csv = delimiter === ',';
  const hcoord = horizontalCoordFormatter(cloud);
  // Length guards: a malformed cloud with a misaligned channel drops the
  // column rather than writing values from the wrong points.
  const intensity =
    cloud.intensity && cloud.intensity.length === n ? cloud.intensity : undefined;
  const classification =
    cloud.classification && cloud.classification.length === n
      ? cloud.classification
      : undefined;
  const columns = [
    'x',
    'y',
    'z',
    ...(colors ? ['r', 'g', 'b'] : []),
    ...(intensity ? ['intensity'] : []),
    ...(classification ? ['classification'] : []),
  ];
  // Honest provenance: when the classification column was DERIVED by the
  // viewer's heuristic classifier (not read from the source), stamp it so a
  // downstream reader never mistakes derived codes for a producer's
  // survey-grade classification. Kept to the XYZ path (a leading `#` comment),
  // matching the column-header convention; CSV's first line must be the header.
  const derivedNote =
    classification && cloud.classificationIsDerived
      ? '# classification: DERIVED (heuristic ground/vegetation/building — ' +
        'not survey-grade; validate before relying on it)'
      : null;
  if (csv) lines.push(columns.join(','));
  else {
    for (const l of provenanceLines(cloud)) lines.push(`# ${l}`);
    const subset = subsetLine(cloud);
    if (subset) lines.push(`# ${subset}`);
    if (derivedNote) lines.push(derivedNote);
    for (const l of droppedChannelLines(cloud, { intensity: true, classification: true }, []))
      lines.push(`# ${l}`);
    if (omitted > 0) lines.push(`# ${omittedPointsLine(omitted)}`);
    if (intensity || classification) lines.push(`# columns: ${columns.join(' ')}`);
  }

  for (let i = 0; i < n; i++) {
    if (!isFinitePoint(positions, i)) continue;
    const row: Array<string | number> = [
      hcoord(positions[i * 3] + sourceOrigin[0]),
      hcoord(positions[i * 3 + 1] + sourceOrigin[1]),
      coord(positions[i * 3 + 2] + sourceOrigin[2]),
    ];
    if (colors) row.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    if (intensity) row.push(intensity[i]);
    if (classification) row.push(classification[i]);
    lines.push(row.join(delimiter));
  }
  return lines.join('\n') + '\n';
}

/** Serialise to CSV — comma-delimited XYZ with a header row. */
export function toCsv(cloud: PointCloud): string {
  return toXyz(cloud, ',');
}

/** Serialise to ASCII PLY, with `uchar` RGB when the cloud carries colour. */
export function toPly(cloud: PointCloud): string {
  // World coordinates come from the SOURCE origin, which is fixed for the
  // cloud's life. `origin` moves when a layer mounts into a project frame;
  // sourceOrigin does not, so an export stays in the file's real-world frame
  // regardless of project membership. (Today the two coincide — mounting is
  // off — so this is a no-op that stays correct once mounting rebases layers.)
  const { positions, colors, sourceOrigin } = cloud;
  const n = cloud.pointCount;
  const finite = finitePointCount(positions, n);
  const omitted = n - finite;
  const hcoord = horizontalCoordFormatter(cloud);

  // `double` x/y/z: the values are global survey coordinates written at
  // millimetre precision, and a `float` declaration instructs conforming
  // readers to store them in float32 — snapping a UTM northing onto a
  // ~0.25 m grid. ASCII PLY readers accept `double` universally.
  const header = [
    'ply',
    'format ascii 1.0',
    'comment Generated by OpenLiDARViewer',
    ...provenanceLines(cloud).map((l) => `comment ${l}`),
    ...(subsetLine(cloud) ? [`comment ${subsetLine(cloud)}`] : []),
    ...droppedChannelLines(cloud, {}, []).map((l) => `comment ${l}`),
    ...(omitted > 0 ? [`comment ${omittedPointsLine(omitted)}`] : []),
    `element vertex ${finite}`,
    'property double x',
    'property double y',
    'property double z',
  ];
  if (colors) {
    header.push('property uchar red', 'property uchar green', 'property uchar blue');
  }
  header.push('end_header');

  const lines: string[] = [header.join('\n')];
  for (let i = 0; i < n; i++) {
    if (!isFinitePoint(positions, i)) continue;
    const x = hcoord(positions[i * 3] + sourceOrigin[0]);
    const y = hcoord(positions[i * 3 + 1] + sourceOrigin[1]);
    const z = coord(positions[i * 3 + 2] + sourceOrigin[2]);
    if (colors) {
      lines.push(`${x} ${y} ${z} ${colors[i * 3]} ${colors[i * 3 + 1]} ${colors[i * 3 + 2]}`);
    } else {
      lines.push(`${x} ${y} ${z}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Serialise to OBJ as a vertex-only cloud. Colour, when present, is written
 * with the widely-supported `v x y z r g b` extension (channels in 0–1).
 * OBJ has no standard slot for intensity or classification, so those
 * channels are disclosed as omitted rather than dropped silently.
 */
export function toObj(cloud: PointCloud): string {
  // World coordinates come from the SOURCE origin, which is fixed for the
  // cloud's life. `origin` moves when a layer mounts into a project frame;
  // sourceOrigin does not, so an export stays in the file's real-world frame
  // regardless of project membership. (Today the two coincide — mounting is
  // off — so this is a no-op that stays correct once mounting rebases layers.)
  const { positions, colors, sourceOrigin } = cloud;
  const n = cloud.pointCount;
  const finite = finitePointCount(positions, n);
  const omitted = n - finite;
  const hcoord = horizontalCoordFormatter(cloud);

  const lines: string[] = [
    '# OpenLiDARViewer point-cloud export',
    `# ${finite} points`,
    ...provenanceLines(cloud).map((l) => `# ${l}`),
    ...(subsetLine(cloud) ? [`# ${subsetLine(cloud)}`] : []),
    ...droppedChannelLines(cloud, {}, ['intensity', 'classification']).map((l) => `# ${l}`),
    ...(omitted > 0 ? [`# ${omittedPointsLine(omitted)}`] : []),
  ];
  for (let i = 0; i < n; i++) {
    if (!isFinitePoint(positions, i)) continue;
    const x = hcoord(positions[i * 3] + sourceOrigin[0]);
    const y = hcoord(positions[i * 3 + 1] + sourceOrigin[1]);
    const z = coord(positions[i * 3 + 2] + sourceOrigin[2]);
    if (colors) {
      const r = (colors[i * 3] / 255).toFixed(4);
      const g = (colors[i * 3 + 1] / 255).toFixed(4);
      const b = (colors[i * 3 + 2] / 255).toFixed(4);
      lines.push(`v ${x} ${y} ${z} ${r} ${g} ${b}`);
    } else {
      lines.push(`v ${x} ${y} ${z}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Serialise `cloud` to `format`. */
export function exportCloud(cloud: PointCloud, format: ExportFormat): string {
  switch (format) {
    case 'xyz': return toXyz(cloud);
    case 'csv': return toCsv(cloud);
    case 'ply': return toPly(cloud);
    case 'obj': return toObj(cloud);
    default: {
      const exhaustive: never = format;
      throw new Error(`Unknown export format: ${String(exhaustive)}`);
    }
  }
}
