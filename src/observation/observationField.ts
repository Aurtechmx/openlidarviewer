/**
 * observationField.ts — OB-ST-01 wired to a real ledger (docs/observatory/SPEC.md
 * §2, §5.3, phase O5).
 *
 * `stateTable.ts`'s `deriveObservationState` (O1) is a pure function of a
 * per-voxel `SourceObservationRecord[]` plus `insideDomain`. Nothing before
 * this phase produces that input from a real ledger: `ledger.ts`'s
 * `ObservationLedgerSourceCounters` (O4) deliberately omits `addressed`,
 * which `ledger.ts`'s own header attributes to O5 — "a state-derivation fact
 * O5 computes, not a traversal one" — because it needs a geometric test
 * against each source's declared angular/range domain, not anything the DDA
 * traversal itself produces.
 *
 * This module supplies that test (`isVoxelAddressed`, a closed-form
 * spherical-coordinate check against a station's declared azimuth/elevation
 * band and optional range window) and the per-voxel assembly
 * (`classifyObservationField`): every cell of the declared domain grid, not
 * only the ledger's touched rows, so an untouched cell inside a station's
 * addressed angular domain still resolves through the "addressed but no
 * ray happened to land there" branch `types.ts` documents, and a cell no
 * station's domain reaches resolves to `UNADDRESSED` by the residual-default
 * rule already implemented and tested in `stateTable.ts` (O1). Every voxel
 * classified this way lies inside the ledger's own declared domain box by
 * construction (this module only ever iterates `domainGrid`'s own cells), so
 * `insideDomain` is always `true` here — `OUTSIDE_DOMAIN` is not a state this
 * module ever assigns; it belongs to a voxel outside the declared ROI/range/
 * angular extent entirely, which such a voxel is never enumerated to reach.
 *
 * Pure and DOM-free (OB-INT-01): no import beyond sibling `observation`
 * modules, no I/O, no randomness. Exhaustive full-grid iteration is a
 * deliberate O5 scope choice, not an optimisation: SPEC's O9 (panel/
 * coordinator) and the render-loop phases own wiring this to a live scene at
 * scale; O5's own exit evidence (F1-F7, F17) runs on domains sized for a
 * unit test, not a production scan.
 */
import {
  domainGrid,
  packVoxelKey,
  type ObservationDomain,
  type ObservationLedgerRow,
} from './ledger';
import { deriveObservationState, type ObservationStateDecision } from './stateTable';
import type { ObservationParameters, ObservationState, SourceObservationRecord } from './types';
import { OBSERVATION_STATES } from './types';

// ---------------------------------------------------------------------------
// A station's declared addressed domain (SPEC §2.4, §5.1's angular extent)
// ---------------------------------------------------------------------------

/**
 * The declared angular/range domain a source addresses, in the same Float64
 * world frame as {@link ObservationDomain} (`docs/coordinate-precision.md`).
 * `azimuthDeg`/`elevationDeg` follow F1's own fixture convention
 * (`scripts/generate-observatory-fixtures.mjs`): `[lo, hi]` in degrees,
 * azimuth measured from +X toward +Y, elevation from the XY plane toward +Z.
 * An azimuth band may wrap through 0 (e.g. `[350, 10]`); `[0, 360]` (or wider)
 * addresses every azimuth. `minRange`/`maxRange` are optional: omitted means
 * unbounded on that side.
 */
export interface StationAngularDomain {
  readonly origin: readonly [number, number, number];
  readonly azimuthDeg: readonly [number, number];
  readonly elevationDeg: readonly [number, number];
  readonly minRange?: number;
  readonly maxRange?: number;
}

function normalizeAzimuthDeg(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function azimuthInBand(azDeg: number, band: readonly [number, number]): boolean {
  const [loRaw, hiRaw] = band;
  if (hiRaw - loRaw >= 360) return true; // a full-circle (or wider) band addresses every azimuth
  const az = normalizeAzimuthDeg(azDeg);
  const lo = normalizeAzimuthDeg(loRaw);
  const hi = normalizeAzimuthDeg(hiRaw);
  if (lo <= hi) return az >= lo && az <= hi;
  return az >= lo || az <= hi; // the band wraps through 0
}

/**
 * True when `voxelCenter` lies inside `station`'s declared angular and range
 * domain: SPEC §2.4's "it lies within `s`'s addressed angular domain" clause
 * of `SHADOWED_s`, and the residual `UNADDRESSED` default's own "no source's
 * ray domain covers it".
 *
 * A voxel exactly at the station's origin (`range === 0`) is treated as
 * addressed: no azimuth/elevation is defined there, and refusing to classify
 * the station's own cell would leave a hole `deriveObservationState` cannot
 * otherwise close.
 */
export function isVoxelAddressed(voxelCenter: readonly [number, number, number], station: StationAngularDomain): boolean {
  const dx = voxelCenter[0] - station.origin[0];
  const dy = voxelCenter[1] - station.origin[1];
  const dz = voxelCenter[2] - station.origin[2];
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(range)) {
    throw new Error(`isVoxelAddressed: non-finite range (${range}); a NaN or infinite station origin or voxel centre was given`);
  }
  if (range === 0) return true;
  if (station.minRange !== undefined && range < station.minRange) return false;
  if (station.maxRange !== undefined && range > station.maxRange) return false;
  const azimuthDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const elevationDeg = (Math.asin(Math.max(-1, Math.min(1, dz / range))) * 180) / Math.PI;
  if (elevationDeg < station.elevationDeg[0] || elevationDeg > station.elevationDeg[1]) return false;
  return azimuthInBand(azimuthDeg, station.azimuthDeg);
}

// ---------------------------------------------------------------------------
// Field classification (OB-ST-01 over a real domain)
// ---------------------------------------------------------------------------

/** One declared source: its ledger `sourceIndex` (matches `ObservationLedgerRow.perSource[].sourceIndex`) plus its addressed domain. */
export interface ObservationFieldStation extends StationAngularDomain {
  readonly sourceIndex: number;
}

/** Per-state voxel counts across a classified field (SPEC OB-ST-03: "state counts per state are part of the canonical record"). */
export type ObservationStateCounts = Record<ObservationState, number>;

function zeroStateCounts(): ObservationStateCounts {
  const counts = {} as ObservationStateCounts;
  for (const s of OBSERVATION_STATES) counts[s] = 0;
  return counts;
}

export interface ObservationFieldResult {
  /** Every in-domain voxel's decision, keyed by {@link packVoxelKey}'s packed key. */
  readonly stateByKey: ReadonlyMap<number, ObservationStateDecision>;
  readonly stateCounts: ObservationStateCounts;
  readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number };
}

/**
 * OB-ST-01 over a real domain: classifies every voxel of `domain` at
 * `voxelEdge`, combining `rows`' per-source counters with each station's
 * `isVoxelAddressed` test into the `SourceObservationRecord[]`
 * `deriveObservationState` needs, per voxel.
 *
 * `insideDomain` is always `true` (see module header). Stations not present
 * in a voxel's `perSource` still contribute a record (with all-zero
 * counters and their own `addressed` result): SPEC's `SHADOWED`/`UNADDRESSED`
 * rules both depend on `addressed`, which is a fact about the station's
 * declared domain, independent of whether any of its rays happened to touch
 * this exact voxel.
 */
export function classifyObservationField(
  domain: ObservationDomain,
  voxelEdge: number,
  rows: readonly ObservationLedgerRow[],
  stations: readonly ObservationFieldStation[],
  params: Pick<ObservationParameters, 'p_solid' | 'p_empty' | 'n_min'>,
): ObservationFieldResult {
  const grid = domainGrid(domain, voxelEdge);
  const rowsByKey = new Map<number, ObservationLedgerRow>();
  for (const row of rows) rowsByKey.set(row.key, row);

  const stateByKey = new Map<number, ObservationStateDecision>();
  const stateCounts = zeroStateCounts();

  for (let iz = 0; iz < grid.nz; iz++) {
    for (let iy = 0; iy < grid.ny; iy++) {
      for (let ix = 0; ix < grid.nx; ix++) {
        const key = packVoxelKey(ix, iy, iz, grid.nx, grid.ny);
        const center: readonly [number, number, number] = [
          domain.min[0] + (ix + 0.5) * voxelEdge,
          domain.min[1] + (iy + 0.5) * voxelEdge,
          domain.min[2] + (iz + 0.5) * voxelEdge,
        ];
        const row = rowsByKey.get(key);
        const perSourceByIndex = new Map(row === undefined ? [] : row.perSource.map((s) => [s.sourceIndex, s] as const));

        const sourceRecords: SourceObservationRecord[] = stations.map((station) => {
          const touched = perSourceByIndex.get(station.sourceIndex);
          return {
            sourceIndex: station.sourceIndex,
            hit: touched?.hit ?? 0,
            pass: touched?.pass ?? 0,
            behind: touched?.behind ?? 0,
            noReturn: touched?.noReturn ?? 0,
            saturated: touched?.saturated ?? false,
            notDecoded: touched?.notDecoded ?? false,
            addressed: isVoxelAddressed(center, station),
          };
        });

        const decision = deriveObservationState(sourceRecords, true, params);
        stateByKey.set(key, decision);
        stateCounts[decision.state] += 1;
      }
    }
  }

  return { stateByKey, stateCounts, grid };
}
