/**
 * productVerdict.ts
 *
 * The one rule for what Process Studio shows for a product, shared by the
 * Process Studio panel and the Analyse home (`analysisStatus.ts`) so the two
 * can never disagree.
 */

import type { ProductId, Readiness, ScanFacts } from './ProcessPlan';
import { ProcessService } from './ProcessService';
import type { ToolPreflight } from './toolPreflight';
// TYPE-ONLY: the preflight model rides a lazy chunk.
import type { PreflightView } from '../app/toolPreflightRuntime';

/** What Process Studio shows for one product, and what would lift it. */
export interface ProductVerdict {
  readonly status: Readiness;
  /** The authority's own sentence, or undefined when it gave none. */
  readonly reason: string | undefined;
  /** The preflight entry the verdict came from, for its remediations. */
  readonly preflight: ToolPreflight | undefined;
}

/**
 * The verdict for one product. ONE authority per row: the preflight carries
 * the capability verdict whole (over every loaded layer), so where it answers
 * it is the row; the single-scan service is the fallback. The two are never
 * mixed, or a badge could sit beside another authority's reason.
 */
export function productVerdict(facts: ScanFacts, view: PreflightView | undefined, id: ProductId): ProductVerdict {
  const pre = view?.products.get(id);
  if (pre) {
    return { status: pre.status, reason: pre.reasons.map((r) => r.message).join(' ') || undefined, preflight: pre };
  }
  const cap = ProcessService.fromFacts([facts]).capability(id);
  return { status: cap?.readiness ?? 'blocked', reason: cap?.reason, preflight: undefined };
}
