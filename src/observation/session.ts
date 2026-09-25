/**
 * session.ts — OB-SES-01: the Observatory session record and its commit gate
 * (docs/observatory/SPEC.md §8, phase O7).
 *
 * "A session stores the parameters and the fieldDigest, not the field. On
 * reload it offers a rerun, and marks the result current only when the rerun
 * digest matches." Two separate questions are answered here, deliberately
 * kept apart:
 *
 *   1. Was anything the run depended on still true at commit time? —
 *      `commitObservationSession`, which refuses BEFORE a session record is
 *      even created, naming the fact that moved
 *      (`observationFreshnessBreach`, already implemented in
 *      `analysisFreshness.ts`; this module is the first caller that wires it
 *      into an actual commit path — OB-INV-09, F14).
 *   2. Given a session saved earlier, does re-running it now reproduce the
 *      same evidence? — `verifyObservationRerun`, a bare digest comparison,
 *      run only after a rerun has actually happened.
 *
 * The session record never holds the field itself (`ObservationLedgerRow[]`
 * or the classified `stateByKey`): only the facts small enough to keep
 * indefinitely and compare against a fresh run.
 *
 * Pure: no DOM, no I/O, no storage mechanism (OB-INT-01). Where the record is
 * actually persisted (localStorage, a session file) is a UI-layer decision
 * outside `src/observation`.
 */

import {
  observationFreshnessBreach,
  OBSERVATION_FRESHNESS_REFUSALS,
  type ObservationFreshnessBreach,
  type ObservationFreshnessStamp,
} from '../science/analysisFreshness';
import type { ObservationDomain } from './ledger';
import type { ObservationParameters } from './types';

/** What a saved Observatory session keeps. Never the field itself. */
export interface ObservationSessionRecord {
  readonly schemaVersion: 1;
  readonly stamp: ObservationFreshnessStamp;
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
  readonly parameters: ObservationParameters;
  readonly fieldDigest: string;
  readonly runRecordDigest: string;
}

export type ObservationCommitVerdict =
  | { readonly status: 'committed'; readonly session: ObservationSessionRecord }
  | { readonly status: 'refused'; readonly reason: Exclude<ObservationFreshnessBreach, null>; readonly message: string };

/**
 * Try to commit a completed run into a session record. Checks freshness
 * FIRST, before a session record is ever built (OB-INV-09: "shall not
 * commit, display as current, or export"; F14 exercises the `roi` reason
 * directly through this function).
 */
export function commitObservationSession(
  stamp: ObservationFreshnessStamp,
  now: Pick<
    ObservationFreshnessStamp,
    'targetId' | 'classificationEpoch' | 'crsRevision' | 'sourceDigest' | 'roiDigest' | 'stationSetDigest' | 'parameterDigest'
  >,
  sameTarget: (a: string | null, b: string | null) => boolean,
  result: {
    readonly domain: ObservationDomain;
    readonly voxelEdge: number;
    readonly parameters: ObservationParameters;
    readonly fieldDigest: string;
    readonly runRecordDigest: string;
  },
): ObservationCommitVerdict {
  const breach = observationFreshnessBreach(stamp, now, sameTarget);
  if (breach !== null) {
    return { status: 'refused', reason: breach, message: OBSERVATION_FRESHNESS_REFUSALS[breach] };
  }
  return {
    status: 'committed',
    session: {
      schemaVersion: 1,
      stamp,
      domain: result.domain,
      voxelEdge: result.voxelEdge,
      parameters: result.parameters,
      fieldDigest: result.fieldDigest,
      runRecordDigest: result.runRecordDigest,
    },
  };
}

/** Whether a reload's own rerun still matches the session it was offered from (OB-SES-01's own rule). */
export type ObservationRerunVerdict = 'current' | 'stale';

/**
 * Compares only the fieldDigest — the one figure OB-SES-01 names — never the
 * parameters or the stamp, which a caller may legitimately want to inspect
 * even on a stale reload (to show the reader what to change back).
 */
export function verifyObservationRerun(saved: ObservationSessionRecord, rerunFieldDigest: string): ObservationRerunVerdict {
  return rerunFieldDigest === saved.fieldDigest ? 'current' : 'stale';
}
