/**
 * analysisStatus.ts
 *
 * One status per analysis for the Analyse home and its task pages, read from
 * the verdicts Process Studio already renders. Nothing here decides a
 * capability: a product row takes the same single authority the Process Studio
 * panel shows (the tool preflight where it answers, else `ProcessService`),
 * and a row with no product of its own reads an independent QA check or the
 * "produced" set the terrain run writes. Pure and DOM-free, so the home can be
 * tested without loading any analysis subsystem. Only the home reads it, so
 * it rides the lazy workspace chunk; the product rule it shares with the
 * Process Studio panel is `productVerdict.ts`.
 */

import type { ProductId, Readiness, ScanFacts } from './ProcessPlan';
import { runQaChecks, type QaCheck } from '../qa/qaChecks';
import type { PreflightActionId, ToolId } from './toolPreflight';
// TYPE-ONLY: the preflight model rides a lazy chunk.
import type { PreflightView } from '../app/toolPreflightRuntime';
import { productVerdict, type ProductVerdict } from './productVerdict';

export { productVerdict, type ProductVerdict };

/** The analyses the Analyse home lists, in order. */
export type AnalysisId = 'terrain' | 'flow-pulse' | 'terrain-access' | 'observatory' | 'objects' | 'features' | 'range';

/** A fix a row offers: open a task page, or run a Process Studio remediation. */
export type AnalysisRemedy =
  | { readonly kind: 'page'; readonly page: 'terrain'; readonly label: string }
  | { readonly kind: 'preflight'; readonly action: PreflightActionId; readonly tool: ToolId; readonly label: string };

/**
 * A row's badge: a verdict, or `present` for an entry no verdict stands
 * behind (the scanner grid), which states a fact rather than a readiness.
 */
export type AnalysisStatus = Readiness | 'present';

/** What the last terrain run says about itself (its surface tier and verdict line). */
export interface TerrainRunUsability {
  readonly tier: 'Good' | 'Preview' | 'Limited' | 'Blocked';
  readonly verdict: string;
}

export interface AnalysisRow {
  readonly id: AnalysisId;
  readonly label: string;
  readonly status: AnalysisStatus;
  /** One sentence: why the row reads as it does. */
  readonly reason: string;
  /** Offered only on a BLOCKED row, and only when something can lift it. */
  readonly remedy: AnalysisRemedy | null;
}

export interface AnalysisStatusInput {
  readonly facts: ScanFacts | null;
  readonly view: PreflightView | undefined;
  /** Products the last terrain run generated (Process Studio's produced set). */
  readonly produced: ReadonlySet<ProductId>;
  /** Entries that exist only for some scans: a scanner grid, classified features. */
  readonly hasRange: boolean;
  readonly hasFeatures: boolean;
  /** The last run's own usability, or null before a run. */
  readonly terrainRun?: TerrainRunUsability | null;
  /** True when the app can carry out a preflight remediation. */
  readonly canRemediate?: (action: PreflightActionId, tool: ToolId) => boolean;
}

const LABEL: Readonly<Record<AnalysisId, string>> = {
  terrain: 'Terrain',
  'flow-pulse': 'Flow Pulse',
  'terrain-access': 'Terrain Access',
  observatory: 'Observatory',
  objects: 'Objects & Space',
  features: 'Feature candidates',
  range: 'Range frames',
};

export const PREPARE_TERRAIN: AnalysisRemedy = { kind: 'page', page: 'terrain', label: 'Prepare terrain' };

const RUN_STATUS: Readonly<Record<TerrainRunUsability['tier'], Readiness>> = {
  Good: 'ready', Preview: 'review', Limited: 'review', Blocked: 'blocked',
};
const RANK: Readonly<Record<Readiness, number>> = { ready: 0, review: 1, blocked: 2 };

/**
 * Presentation rule for a terrain status: the more restrictive of Process
 * Studio's readiness and the run's own usability. The two decisions stay
 * separate; this only picks which one the badge shows. When the run is at
 * least as restrictive and not usable, its verdict line is the reason, so a
 * page never reads Ready beside a run that says it is not usable.
 */
export function capByRun(
  base: { status: Readiness; reason: string | undefined },
  run: TerrainRunUsability | null | undefined,
): { status: Readiness; reason: string | undefined; byRun: boolean } {
  if (!run) return { ...base, byRun: false };
  const rs = RUN_STATUS[run.tier];
  if (rs !== 'ready' && RANK[rs] >= RANK[base.status]) return { status: rs, reason: run.verdict, byRun: true };
  return { ...base, byRun: false };
}

const QA_STATUS: Readonly<Record<QaCheck['status'], Readiness>> = { pass: 'ready', review: 'review', block: 'blocked' };

function qa(facts: ScanFacts, id: string): QaCheck | undefined {
  return runQaChecks(facts).find((c) => c.id === id);
}

function preflightRemedy(v: ProductVerdict, can: AnalysisStatusInput['canRemediate']): AnalysisRemedy | null {
  const pre = v.preflight;
  const r = pre?.remediations.find((x) => can?.(x.action, pre.tool) === true);
  return pre && r ? { kind: 'preflight', action: r.action, tool: pre.tool, label: r.label } : null;
}

/** The contours status shown on the Terrain page link and the Contours page. */
export function contoursStatus(input: AnalysisStatusInput): Omit<AnalysisRow, 'id' | 'label'> {
  if (!input.facts) return { status: 'blocked', reason: 'Load a scan first.', remedy: null };
  if (!input.produced.has('contours')) {
    return { status: 'blocked', reason: 'Contours come from a terrain run. Run terrain analysis first.', remedy: PREPARE_TERRAIN };
  }
  const v = productVerdict(input.facts, input.view, 'contours');
  const c = capByRun({ status: v.status, reason: v.reason ?? 'Contours from the latest terrain run.' }, input.terrainRun);
  return { status: c.status, reason: c.reason ?? 'Contours from the latest terrain run.', remedy: null };
}

/** One row per analysis the Analyse home lists for the loaded scan. */
export function analysisRows(input: AnalysisStatusInput): AnalysisRow[] {
  const ids: AnalysisId[] = ['terrain', 'flow-pulse', 'terrain-access', 'observatory', 'objects'];
  if (input.hasFeatures) ids.push('features');
  if (input.hasRange) ids.push('range');
  const { facts } = input;
  if (!facts) {
    return ids.map((id) => ({ id, label: LABEL[id], status: 'blocked', reason: 'Load a scan first.', remedy: null }));
  }
  const dtm = productVerdict(facts, input.view, 'dtm');
  const hasDtm = input.produced.has('dtm');
  const row = (id: AnalysisId, status: AnalysisStatus, reason: string | undefined, remedy: AnalysisRemedy | null = null): AnalysisRow => ({
    id, label: LABEL[id], status,
    reason: reason ?? (status === 'ready' ? 'Nothing blocks this analysis for the loaded scan.' : 'Process Studio gives no reason for this verdict.'),
    remedy: status === 'blocked' ? remedy : null,
  });
  return ids.map((id) => {
    switch (id) {
      case 'terrain': {
        const base = { status: dtm.status, reason: hasDtm && dtm.status === 'ready' ? 'The latest run produced a DTM.' : dtm.reason };
        const t = capByRun(base, hasDtm ? input.terrainRun : null);
        return row(id, t.status, t.reason, t.byRun ? null : preflightRemedy(dtm, input.canRemediate));
      }
      case 'flow-pulse':
      case 'terrain-access':
        // Both labs read the DTM of the latest terrain run and refuse without one.
        if (!hasDtm) return row(id, 'blocked', 'Needs the DTM from a terrain run.', PREPARE_TERRAIN);
        return row(id, dtm.status, dtm.status === 'ready' ? 'Reads the DTM from the latest terrain run.' : dtm.reason);
      case 'observatory': {
        // The run reads the resident static cloud and does nothing without one.
        const c = qa(facts, 'COVERAGE');
        return row(id, facts.kind === 'streaming' ? 'blocked' : QA_STATUS[c?.status ?? 'review'], c?.reason);
      }
      case 'objects': {
        // Sizes are only metric with a known unit; the panel still measures in scan units.
        const c = qa(facts, 'SPATIAL_REFERENCE');
        return row(id, c?.status === 'pass' ? 'ready' : 'review', c?.reason);
      }
      case 'features': {
        const v = productVerdict(facts, input.view, 'building-footprints');
        return row(id, v.status, v.reason, preflightRemedy(v, input.canRemediate));
      }
      case 'range':
        // No Process Studio verdict stands behind this entry, so it states the fact only.
        return row(id, 'present', 'The active layer carries a scanner grid. No readiness check applies.');
    }
  });
}
