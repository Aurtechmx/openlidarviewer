/**
 * exportProvenanceLines.ts — the plain-text provenance lines shared by the
 * converter's XYZ / ASC / LAS writers and the measurement CSV sidecar.
 *
 * Each line names one fact a reader needs to trace an exported file back to
 * its source: the build that wrote it, the source file, the point basis and
 * whether the classification was edited in the app.
 *
 * The measurement CSV carries the same facts in a `<name>.provenance.txt`
 * sidecar: a CSV has no comment convention every parser honours, so the record
 * travels beside it rather than inside it.
 *
 * Pure data: no DOM, no I/O.
 */

import { BUILD_IDENTITY, type BuildIdentity } from '../build/buildIdentity';
import { classificationDiffersFromSource } from './fullResClassGuard';
import { pointBasisLine } from './exportSummary';
import { truncationOf, type Truncation } from '../io/truncation';
import { crsOriginLine } from '../science/crsOrigin';
import { sourceSha256Text } from '../science/exportDigestRecord';
import { lightProvenance, type LightProvenanceInput } from './lightProvenance';

/** "Software: OpenLiDARViewer 0.7.0 (a1b2c3d)"; an unresolved commit is left out. */
export function softwareLine(id: Pick<BuildIdentity, 'version' | 'commit' | 'dirty'> = BUILD_IDENTITY): string {
  const hasCommit = id.commit.length > 0 && id.commit !== 'unknown';
  if (!hasCommit) return `Software: OpenLiDARViewer ${id.version}`;
  const dirty = id.dirty ? '+dirty' : '';
  return `Software: OpenLiDARViewer ${id.version} (${id.commit}${dirty})`;
}

/** "Source file: scan.las"; any directory part is stripped so no host path is written. */
export function sourceFileLine(name: string | null | undefined): string {
  const parts = (name ?? '').split(/[\\/]/);
  const base = parts[parts.length - 1];
  return `Source file: ${base || 'unknown'}`;
}

/** "Classes edited in app: yes" or "... no". */
export function classEditLine(edited: boolean): string {
  return `Classes edited in app: ${edited ? 'yes' : 'no'}`;
}

/** The classification facts of one cloud, as the class-edit line reads them. */
export interface ClassEditFacts {
  readonly provenance: string;
  readonly editEpoch: number;
}

/** Whether the classes were edited in the app: an edit epoch above 0, or codes not from the source. */
export function classesEdited(f: ClassEditFacts): boolean {
  return classificationDiffersFromSource(f.provenance, f.editEpoch);
}

/** The fields of a loaded cloud the point-basis line reads. */
export interface PointBasisCloud {
  readonly pointCount: number;
  /** Decode stride the loader applied; above 1 means a strided display sample. */
  readonly loadStride?: number;
  readonly sourceDeclaredPointCount?: number;
  readonly declaredPointCount?: number;
  readonly metadata?: { readonly truncation?: Truncation } | null;
}

const count = (n: number): string => n.toLocaleString('en-US');

/**
 * The point-basis line for a loaded cloud.
 *
 * `reduced` is the caller's own record of whether the held points are a
 * display sample (true) or every record the file yields (false, e.g. a
 * full-resolution re-decode). Null falls back to the cloud: a load stride
 * above 1, or a file that declares more points than the cloud holds.
 *
 * A truncated file (its body held fewer records than the header declares) is
 * never called a display sample on the count gap alone. It reads "truncated
 * file (n of N declared points read)", or, when the read points were also
 * sampled for display, names both with each count.
 */
export function pointBasisOfCloud(c: PointBasisCloud, reduced: boolean | null): string {
  const trunc = truncationOf(c);
  const declared = c.sourceDeclaredPointCount ?? c.declaredPointCount;
  if (trunc) {
    const sampled = reduced ?? ((c.loadStride ?? 1) > 1 || c.pointCount < trunc.read);
    if (sampled && c.pointCount < trunc.read) {
      return `Point basis: truncated file, display sample (${count(c.pointCount)} held of ${count(trunc.read)} read of ${count(trunc.declared)} declared points)`;
    }
    return `Point basis: truncated file (${count(trunc.read)} of ${count(trunc.declared)} declared points read)`;
  }
  const larger = declared !== undefined && Number.isFinite(declared) && declared > c.pointCount ? declared : null;
  if (reduced === false) return pointBasisLine(true, larger ?? c.pointCount, null);
  const sampled = reduced ?? ((c.loadStride ?? 1) > 1 || larger !== null);
  return sampled ? pointBasisLine(false, c.pointCount, larger) : pointBasisLine(true, c.pointCount, null);
}

/** The scan facts the sidecar adds to the light provenance record. */
export interface MeasurementCsvBasis {
  /** "Point basis: ..." line for the scan the measurements were taken on. */
  readonly pointBasis: string;
  /** Classes edited in the app; null when not recorded (several scans, or none active). */
  readonly classesEdited: boolean | null;
  /** Full source file name when one scan is the source; else the record's basename is used. */
  readonly sourceName?: string | null;
}

/** The sidecar file name for a CSV: `a-measurements.csv` → `a-measurements.provenance.txt`. */
export function provenanceSidecarName(filename: string): string {
  return `${filename.replace(/\.[^./\\]+$/, '')}.provenance.txt`;
}

/** The sidecar text, one `Key: value` fact per line. */
export function measurementCsvProvenance(input: LightProvenanceInput, basis: MeasurementCsvBasis): string {
  const p = lightProvenance(input);
  const edited = basis.classesEdited === null
    ? 'Classes edited in app: not recorded'
    : classEditLine(basis.classesEdited);
  const lines = [
    'OpenLiDARViewer measurement CSV provenance',
    softwareLine({ version: p.version, commit: p.commit, dirty: p.dirty }),
    `Generated: ${p.generatedAt}`,
    sourceFileLine(basis.sourceName ?? p.source),
    `Source SHA-256: ${sourceSha256Text(p)}`,
    `CRS: ${p.crs}`,
    crsOriginLine(p.crsOrigin),
    basis.pointBasis,
    edited,
  ];
  return lines.join('\n') + '\n';
}
