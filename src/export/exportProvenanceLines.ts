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

/** The counts the point-basis line reads from a loaded cloud. */
export interface PointBasisFacts {
  readonly pointCount: number;
  /** True when the loaded cloud is a display sample of a larger file. */
  readonly reduced: boolean;
  /** Points the source file declares, when known. */
  readonly declaredPointCount: number | null;
}

/** "Point basis: full file (N points)" or "Point basis: display sample (n of N points)". */
export function pointBasisOf(f: PointBasisFacts): string {
  if (!f.reduced) return pointBasisLine(true, f.pointCount, null);
  return pointBasisLine(false, f.pointCount, f.declaredPointCount);
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
