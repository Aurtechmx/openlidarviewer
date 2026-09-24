/**
 * observatoryPackage.ts — the Observatory deliverable (docs/observatory/SPEC.md
 * §8 OB-EXP-01/02, phase O7).
 *
 * Follows `src/export/flowPulsePackage.ts`'s own pattern — a pure function
 * from a completed run to ZIP bytes, a self-documenting README, a passport
 * bound to the artifact it names — rather than inventing a second export
 * shape. Reuses `buildProcessingManifest`, `buildScientificAnalysisRecord`
 * and `buildScientificArtifactPassport` directly (OB-INT-05: "extended, not
 * paralleled").
 *
 * ── FIELD.BIN'S COLUMNAR LAYOUT, AND WHY IT CARRIES presence/perSource ──────
 * OB-EXP-02 requires the exported `field.bin` to "re-hash to `fieldDigest`".
 * `ledger.ts#computeFieldDigest` folds in each row's `presence` mask and its
 * full sparse `perSource` list, not only the four aggregate counters — so a
 * `field.bin` that kept only the aggregate counters could never reproduce
 * that digest from itself. `writeObservationFieldBinary`/
 * `parseObservationFieldBinary` therefore round-trip the WHOLE
 * `ObservationLedgerRow[]`: fixed-width columns for `key`/aggregate counters/
 * `saturated`/`presence`, then one variable-length region for the sparse
 * `perSource` entries (a per-row count column plus a flat concatenation, in
 * `sourceIndex` order per row — the same order `computeFieldDigest` itself
 * sorts to before hashing, so this file's own row order need not match).
 *
 * Every multi-byte field is written with an explicit `littleEndian: true`
 * `DataView` call, never a `Float64Array`/`Uint16Array` cast, so the bytes
 * are portable across a big-endian reader (SPEC's own "little-endian" header
 * requirement).
 *
 * ── WHY COORDINATES ARE NEVER RECENTRED ─────────────────────────────────────
 * Unlike Flow Pulse's `FlowGrid` (local grid metres only), Observatory's
 * `ObservationDomain` and `AcquisitionStation.pose.worldTranslation` are
 * already Float64 values in the dataset's own declared world/CRS frame
 * (`docs/coordinate-precision.md`) — nothing in `src/observation` subtracts a
 * scene-recentring origin (OB-INT-01: no raw `.positions` reads, no
 * `pointFrames.ts` import). This module carries every domain corner and
 * station position through unchanged, so a far UTM-scale origin (hundreds of
 * thousands of metres) survives to the metre, the exact failure mode the
 * Flow Pulse browser review found and this package is written not to repeat.
 *
 * Pure-data: returns ZIP bytes; no DOM.
 */

import { buildZip, type ZipEntry } from '../convert/zipStore';
import { buildSha256Manifest, sha256Hex } from '../terrain/export/sha256';
import { buildProcessingManifest, type ProcessingOpInput } from '../science/processingManifest';
import { buildScientificAnalysisRecord } from '../science/scientificAnalysisRecord';
import { buildScientificArtifactPassport, type PassportEvidence } from '../science/scientificArtifactPassport';
import { methodRef, methodTag } from '../science/methodRegistry';
import { BUILD_IDENTITY, buildIdentityProvenance, type BuildIdentity } from '../build/buildIdentity';
import {
  computeFieldDigest,
  type ObservationDomain,
  type ObservationLedgerRow,
  type RayPartitionChunkEntry,
} from '../observation/ledger';
import { presenceMaskWordCount } from '../observation/types';
import type { ObservationRunRecord, ObservationRunStation } from '../observation/runRecord';
import { buildObservationConfig } from '../observation/runRecord';

/** A caller-supplied origin, for `stations.json`. */
export interface ObservatoryPackageOptions {
  readonly basename?: string;
  readonly generationDateIso?: string;
  readonly softwareName?: string;
  readonly softwareVersion?: string;
  readonly build?: BuildIdentity;
  readonly crsName?: string | null;
  readonly sourceSha256?: string | null;
}

// ---------------------------------------------------------------------------
// field.bin / field.json — the whole ObservationLedgerRow[], columnar
// ---------------------------------------------------------------------------

const FIELD_SCHEMA_VERSION = 1;

export interface ObservationFieldColumnDescriptor {
  readonly name: string;
  readonly dtype: 'float64' | 'uint16' | 'uint8' | 'uint32';
  readonly count: number;
  readonly sha256: string;
}

export interface ObservationFieldHeader {
  readonly schemaVersion: 1;
  readonly byteOrder: 'little-endian';
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
  readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number };
  readonly rowCount: number;
  readonly presenceWordsPerRow: number;
  readonly keyLayout: string;
  readonly columns: readonly ObservationFieldColumnDescriptor[];
}

function le(byteLength: number): DataView {
  return new DataView(new ArrayBuffer(byteLength));
}

/**
 * `field.bin`: every `ObservationLedgerRow`, sorted by `key` ascending (a
 * fixed, reproducible file order — not itself part of `fieldDigest`, which
 * sorts independently before hashing). Layout, in order:
 *
 *   key            Float64 x rowCount
 *   hit/pass/behind/noReturn   Uint16 x rowCount each
 *   saturated      Uint8 x rowCount
 *   presence       Uint32 x (rowCount * presenceWordsPerRow)
 *   perSourceCount Uint16 x rowCount
 *   perSource      flat, row-major, `sourceIndex`-ascending within a row:
 *                  sourceIndex Uint16, hit/pass/behind/noReturn Uint16 x4,
 *                  saturated Uint8, notDecoded Uint8 (16 bytes per entry)
 */
export function writeObservationFieldBinary(
  domain: ObservationDomain,
  voxelEdge: number,
  grid: { readonly nx: number; readonly ny: number; readonly nz: number },
  stationCount: number,
  rows: readonly ObservationLedgerRow[],
): { readonly bytes: Uint8Array; readonly header: ObservationFieldHeader } {
  const sorted = rows.slice().sort((a, b) => a.key - b.key);
  const rowCount = sorted.length;
  const wordsPerRow = presenceMaskWordCount(stationCount);

  const keyBuf = le(8 * rowCount);
  const hitBuf = le(2 * rowCount);
  const passBuf = le(2 * rowCount);
  const behindBuf = le(2 * rowCount);
  const noReturnBuf = le(2 * rowCount);
  const saturatedBuf = le(1 * rowCount);
  const presenceBuf = le(4 * rowCount * wordsPerRow);
  const perSourceCountBuf = le(2 * rowCount);

  const perSourceParts: number[] = []; // flattened bytes, appended below
  for (let i = 0; i < rowCount; i++) {
    const row = sorted[i]!;
    keyBuf.setFloat64(i * 8, row.key, true);
    hitBuf.setUint16(i * 2, row.counters.hit, true);
    passBuf.setUint16(i * 2, row.counters.pass, true);
    behindBuf.setUint16(i * 2, row.counters.behind, true);
    noReturnBuf.setUint16(i * 2, row.counters.noReturn, true);
    saturatedBuf.setUint8(i, row.counters.saturated ? 1 : 0);
    for (let w = 0; w < wordsPerRow; w++) {
      presenceBuf.setUint32((i * wordsPerRow + w) * 4, row.presence[w] ?? 0, true);
    }
    const perSource = row.perSource.slice().sort((a, b) => a.sourceIndex - b.sourceIndex);
    perSourceCountBuf.setUint16(i * 2, perSource.length, true);
    for (const s of perSource) {
      perSourceParts.push(
        s.sourceIndex & 0xff, (s.sourceIndex >>> 8) & 0xff,
        s.hit & 0xff, (s.hit >>> 8) & 0xff,
        s.pass & 0xff, (s.pass >>> 8) & 0xff,
        s.behind & 0xff, (s.behind >>> 8) & 0xff,
        s.noReturn & 0xff, (s.noReturn >>> 8) & 0xff,
        s.saturated ? 1 : 0,
        s.notDecoded ? 1 : 0,
      );
    }
  }
  const perSourceBuf = new Uint8Array(perSourceParts);

  const columnsData: readonly [string, DataView | Uint8Array][] = [
    ['key', keyBuf], ['hit', hitBuf], ['pass', passBuf], ['behind', behindBuf], ['noReturn', noReturnBuf],
    ['saturated', saturatedBuf], ['presence', presenceBuf], ['perSourceCount', perSourceCountBuf], ['perSource', perSourceBuf],
  ];
  const bytesOf = (v: DataView | Uint8Array): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v.buffer));
  const bytes = new Uint8Array(columnsData.reduce((n, [, v]) => n + bytesOf(v).byteLength, 0));
  let offset = 0;
  for (const [, v] of columnsData) {
    const b = bytesOf(v);
    bytes.set(b, offset);
    offset += b.byteLength;
  }

  const dtypeOf: Record<string, ObservationFieldColumnDescriptor['dtype']> = {
    key: 'float64', hit: 'uint16', pass: 'uint16', behind: 'uint16', noReturn: 'uint16',
    saturated: 'uint8', presence: 'uint32', perSourceCount: 'uint16', perSource: 'uint8',
  };
  const columns: ObservationFieldColumnDescriptor[] = columnsData.map(([name, v]) => {
    const b = bytesOf(v);
    return { name, dtype: dtypeOf[name]!, count: name === 'presence' ? rowCount * wordsPerRow : name === 'perSource' ? b.byteLength : rowCount, sha256: sha256Hex(b) };
  });

  const header: ObservationFieldHeader = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    byteOrder: 'little-endian',
    domain, voxelEdge, grid, rowCount,
    presenceWordsPerRow: wordsPerRow,
    keyLayout: 'packVoxelKey(ix,iy,iz,nx,ny) ascending; see src/observation/ledger.ts',
    columns,
  };
  return { bytes, header };
}

/** The inverse of {@link writeObservationFieldBinary}: reconstructs every `ObservationLedgerRow`, for OB-EXP-02's round trip. */
export function parseObservationFieldBinary(bytes: Uint8Array, header: ObservationFieldHeader): readonly ObservationLedgerRow[] {
  const { rowCount, presenceWordsPerRow: wordsPerRow } = header;
  let offset = 0;
  const take = (n: number): Uint8Array => {
    const slice = bytes.subarray(offset, offset + n);
    offset += n;
    return slice;
  };
  const view = (buf: Uint8Array): DataView => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const keyBuf = view(take(8 * rowCount));
  const hitBuf = view(take(2 * rowCount));
  const passBuf = view(take(2 * rowCount));
  const behindBuf = view(take(2 * rowCount));
  const noReturnBuf = view(take(2 * rowCount));
  const saturatedBuf = view(take(1 * rowCount));
  const presenceBuf = view(take(4 * rowCount * wordsPerRow));
  const perSourceCountBuf = view(take(2 * rowCount));
  const perSourceBuf = take(bytes.length - offset);
  const perSourceView = new DataView(perSourceBuf.buffer, perSourceBuf.byteOffset, perSourceBuf.byteLength);

  const rows: ObservationLedgerRow[] = [];
  let cursor = 0;
  for (let i = 0; i < rowCount; i++) {
    const presence = new Uint32Array(wordsPerRow);
    for (let w = 0; w < wordsPerRow; w++) presence[w] = presenceBuf.getUint32((i * wordsPerRow + w) * 4, true);
    const count = perSourceCountBuf.getUint16(i * 2, true);
    const perSource = [];
    for (let j = 0; j < count; j++) {
      const sourceIndex = perSourceView.getUint16(cursor, true); cursor += 2;
      const hit = perSourceView.getUint16(cursor, true); cursor += 2;
      const pass = perSourceView.getUint16(cursor, true); cursor += 2;
      const behind = perSourceView.getUint16(cursor, true); cursor += 2;
      const noReturn = perSourceView.getUint16(cursor, true); cursor += 2;
      const saturated = perSourceView.getUint8(cursor) === 1; cursor += 1;
      const notDecoded = perSourceView.getUint8(cursor) === 1; cursor += 1;
      perSource.push({ sourceIndex, hit, pass, behind, noReturn, saturated, notDecoded });
    }
    rows.push({
      key: keyBuf.getFloat64(i * 8, true),
      counters: {
        hit: hitBuf.getUint16(i * 2, true),
        pass: passBuf.getUint16(i * 2, true),
        behind: behindBuf.getUint16(i * 2, true),
        noReturn: noReturnBuf.getUint16(i * 2, true),
        saturated: saturatedBuf.getUint8(i) === 1,
      },
      presence,
      perSource,
    });
  }
  return rows;
}

/**
 * Rebuilds the minimal `Pick<RayPartitionInput, 'domain'|'voxelEdge'|'stations'|'returnedChunks'>`
 * `computeFieldDigest` needs, from an exported run record's own stations
 * (which carry `tauAbs`/`tauRel` and `worldTranslation` — OB-EXP-02 needs no
 * access to the original ray chunks to re-verify `fieldDigest`).
 */
export function recomputeFieldDigestFromExport(
  domain: ObservationDomain,
  voxelEdge: number,
  stations: readonly ObservationRunStation[],
  rows: readonly ObservationLedgerRow[],
): string {
  const emptyChunk = { originIndex: new Uint16Array(0), direction: new Float32Array(0), range: new Float32Array(0), returnOffset: new Uint32Array(0) };
  const returnedChunks: readonly RayPartitionChunkEntry[] = stations.map((s) => ({
    sourceIndex: s.sourceIndex, tauAbs: s.tauAbs, tauRel: s.tauRel, chunk: emptyChunk,
  }));
  const fakeStations = stations
    .slice()
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map((s) => ({ id: s.id, source: s.source, originStatus: s.originStatus, pose: { worldTranslation: s.worldTranslation } }));
  return computeFieldDigest(
    { domain, voxelEdge, stations: fakeStations as unknown as Parameters<typeof computeFieldDigest>[0]['stations'], returnedChunks },
    rows,
  );
}

// ---------------------------------------------------------------------------
// CSV bodies
// ---------------------------------------------------------------------------

function stateSummaryCsv(record: ObservationRunRecord): string {
  const rows = Object.entries(record.stateCounts).map(([state, count]) => `${state},${count}`);
  return ['state,count', ...rows].join('\n') + '\n';
}

function frontierCsv(record: ObservationRunRecord, frontierVoxelKeys: readonly number[]): string {
  const f = record.frontier;
  const summary = f
    ? `# frontierVoxelCount=${f.frontierVoxelCount} areaSquareMetres=${f.areaSquareMetres ?? ''} `
      + `adjacentToShadowed=${f.adjacentToShadowed} adjacentToUnaddressed=${f.adjacentToUnaddressed} `
      + `adjacentToNoReturnPath=${f.adjacentToNoReturnPath}`
    : '# frontier not computed for this run';
  const lines = ['voxelKey', ...frontierVoxelKeys.map((k) => String(k))];
  return [summary, ...lines].join('\n') + '\n';
}

/** OB-GAIN-01..04 (phase O10) are not implemented; this is a stable header-only file, per OB-EXP-01's bundle shape. */
function candidatesCsv(): string {
  return [
    '# Coverage Gain (olv.observation.coverage-gain, olv.observation.station-suggestion) is not implemented in this build; no candidates were generated.',
    'candidateIndex,weightedVisibilitySum,redundantPenalty,gain,excludedVoxelCount',
  ].join('\n') + '\n';
}

function stationsJson(record: ObservationRunRecord): string {
  return `${JSON.stringify(
    record.stations.map((s) => ({
      id: s.id, source: s.source, originStatus: s.originStatus,
      position: Array.from(s.worldTranslation), sourceIndex: s.sourceIndex, tauAbs: s.tauAbs, tauRel: s.tauRel,
    })),
    null, 2,
  )}\n`;
}

function readmeText(record: ObservationRunRecord, opts: {
  readonly basename: string; readonly generationDateIso: string; readonly build: BuildIdentity;
  readonly softwareVersion: string; readonly crsName: string | null;
}): string {
  const f = record.frontier;
  const lines = [
    'OpenLiDARViewer — Observatory export',
    '',
    'Observation states, in this bundle\'s own words:',
    '  SURFACE            A source found a surface here.',
    '  OBSERVED_EMPTY      A ray passed through and found nothing.',
    '  CONFLICT           Two distinct sources disagree about this space.',
    '  PARTIAL             One source disagrees with itself across returns.',
    '  SHADOWED             This space sat behind a found surface, from every addressing source.',
    '  NO_RETURN_PATH       A ray fired here and returned nothing.',
    '  UNADDRESSED         No source\'s declared domain reaches this space.',
    '  NOT_READ            This session did not decode enough to classify this space.',
    '  OUTSIDE_DOMAIN       Outside the declared region of interest.',
    '',
    'Files',
    '  observation-record.json     The sealed run record (parameters, methods, digests)',
    `  ${opts.basename}.olv-observation.json   Reproducible config: re-run it, get the same fieldDigest`,
    '  stations.json                Every participating station: id, origin status, declared position',
    '  field.bin + field.json       Every voxel\'s counters (header: layout, columns, little-endian, SHA-256 per column)',
    '  state-summary.csv            Per-state voxel counts',
    '  frontier.csv                 The shadow frontier\'s voxel keys and summary',
    '  candidates.csv                Coverage Gain candidates (not implemented in this build; header only)',
    '  processing-manifest.json     Ordered, tamper-evident processing steps',
    '  scientific-passport.json     Tamper-evident provenance for field.bin',
    '  SHA256SUMS.txt                SHA-256 of every file above',
    '',
    'Identity',
    `  OLV version    ${opts.build.version} (${opts.build.commit}${opts.build.dirty ? '+dirty' : ''})`,
    `  Generated      ${opts.generationDateIso}`,
    `  Source file    ${record.source.filename ?? 'unknown'}`,
    `  Source digest  ${record.source.sourceDigest ?? 'unavailable'}`,
    `  Basis          ${record.source.basis}`,
    `  CRS            ${opts.crsName ?? 'not recorded by this package'}`,
    `  Metres/unit    ${record.source.metresPerUnit ?? 'unknown (metric figures withheld, OB-INV-10)'}`,
    '',
    'Method',
    `  Methods run    ${record.methods.map((id) => methodTag(methodRef(id))).join(', ')}`,
    `  Parameters     p_solid=${record.parameters.p_solid} p_empty=${record.parameters.p_empty} n_min=${record.parameters.n_min} ` +
      `tau_abs=${record.parameters.tau_abs} tau_rel=${record.parameters.tau_rel}`,
    '',
    'Results',
    `  Field digest        ${record.fieldDigest}`,
    `  Run record digest   ${record.digest}`,
    `  Rejection ratio     ${record.rejectionRatio}`,
    f ? `  Shadow frontier      ${f.frontierVoxelCount} voxels, area ${f.areaSquareMetres ?? 'withheld (unit unknown)'}` : '  Shadow frontier      not computed for this run',
    '',
    'Limitations',
    ...record.limitations.map((l) => `  - ${l}`),
    '',
    'Reproduction',
    `  1. Load ${opts.basename}.olv-observation.json's domain/voxelEdge/parameters/stations against the identical`,
    `     source and station set (source digest ${record.source.sourceDigest ?? 'unavailable'}).`,
    `  2. Re-run. The result's fieldDigest must equal ${record.fieldDigest}.`,
    '  3. A different digest means the source, the ROI, the stations or the parameters changed.',
    '',
    'What this is not',
    '  Not occupancy probability, not sensor simulation, not survey-grade accuracy, and no state above',
    '  other than OBSERVED_EMPTY represents empty space (OB-INV-01).',
    '',
  ];
  return lines.join('\n');
}

/** Build the Observatory ZIP package from a sealed run record and its rows. */
export function buildObservatoryPackage(
  record: ObservationRunRecord,
  rows: readonly ObservationLedgerRow[],
  frontierVoxelKeys: readonly number[],
  options: ObservatoryPackageOptions = {},
): Uint8Array {
  const basename = options.basename ?? 'observatory';
  const generationDateIso = options.generationDateIso ?? new Date().toISOString();
  const build = options.build ?? BUILD_IDENTITY;
  const softwareVersion = options.softwareVersion ?? buildIdentityProvenance(build);

  const entries: ZipEntry[] = [];

  entries.push({ name: `${basename}/observation-record.json`, bytes: new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`) });
  entries.push({ name: `${basename}/${basename}.olv-observation.json`, bytes: new TextEncoder().encode(`${JSON.stringify(buildObservationConfig(record), null, 2)}\n`) });
  entries.push({ name: `${basename}/stations.json`, bytes: new TextEncoder().encode(stationsJson(record)) });

  const { bytes: fieldBytes, header: fieldHeader } = writeObservationFieldBinary(
    record.domain, record.voxelEdge,
    { nx: 0, ny: 0, nz: 0 }, // grid shape is derivable from domain/voxelEdge (domainGrid); recorded for a reader's convenience only
    record.stations.length, rows,
  );
  entries.push({ name: `${basename}/field.bin`, bytes: fieldBytes });
  entries.push({ name: `${basename}/field.json`, bytes: new TextEncoder().encode(`${JSON.stringify(fieldHeader, null, 2)}\n`) });

  entries.push({ name: `${basename}/state-summary.csv`, bytes: new TextEncoder().encode(stateSummaryCsv(record)) });
  entries.push({ name: `${basename}/frontier.csv`, bytes: new TextEncoder().encode(frontierCsv(record, frontierVoxelKeys)) });
  entries.push({ name: `${basename}/candidates.csv`, bytes: new TextEncoder().encode(candidatesCsv()) });

  const ops: ProcessingOpInput[] = record.methods.map((id) => ({ method: methodTag(methodRef(id)), params: {} }));
  const manifest = buildProcessingManifest({ build: softwareVersion, source: record.source.filename, ops });
  entries.push({ name: `${basename}/processing-manifest.json`, bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) });

  const readme = readmeText(record, { basename, generationDateIso, build, softwareVersion, crsName: options.crsName ?? null });
  entries.push({ name: `${basename}/README.md`, bytes: new TextEncoder().encode(readme) });

  const fieldBinEntry = entries.find((e) => e.name === `${basename}/field.bin`)!;
  const analysis = buildScientificAnalysisRecord({
    kind: 'observation-evidence-ledger',
    source: record.source.filename,
    crs: { horizontal: options.crsName ?? 'not recorded', horizontalKnown: options.crsName != null, verticalDatum: 'unknown', verticalDatumKnown: false },
    methodIds: [...record.methods],
    evidenceExploratory: true,
    summary: { fieldDigest: record.fieldDigest, ...record.stateCounts },
    generatedAt: generationDateIso,
    build,
  });
  const evidence: PassportEvidence = {
    baseline: null, effective: null, resolutionState: 'not applicable', matchedStudy: null,
    applicabilityVerdict: 'Deterministic evidence ledger; not a claim scored on the evidence ladder.',
  };
  const passport = buildScientificArtifactPassport({
    source: { name: record.source.filename, sha256: options.sourceSha256 ?? null },
    analysis, processing: manifest, evidence,
    artifact: { filename: 'field.bin', mediaType: 'application/octet-stream', bytes: fieldBinEntry.bytes },
    build,
  });
  entries.push({ name: `${basename}/scientific-passport.json`, bytes: new TextEncoder().encode(`${JSON.stringify(passport, null, 2)}\n`) });

  entries.push({ name: `${basename}/SHA256SUMS.txt`, bytes: new TextEncoder().encode(buildSha256Manifest(entries)) });

  return buildZip(entries);
}

export { sha256Hex };
