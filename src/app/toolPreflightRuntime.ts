/**
 * toolPreflightRuntime.ts — the tool preflight as ONE lazily-loaded chunk.
 *
 * The preflight model, its live-input builder and its action bindings are only
 * needed once a scan is open and the Process Studio is on screen, so they ride a
 * chunk of their own rather than the startup shell (the same split the
 * Measurements panel and the Contour Studio use). This module is the whole
 * boundary: `processStudioMount` reaches it through `loadToolPreflight()` in
 * `lazyChunks.ts` and imports nothing from it eagerly except types, which erase.
 *
 * It also shapes the model's answer for the panel — the per-product lookup and
 * the measurement-tool list — so the view never has to ask the model which tool
 * makes which product, and the panel keeps no runtime dependency on the model.
 */

import type { ProductId } from '../process/ProcessPlan';
import { toolProduct, type ToolPreflight } from '../process/toolPreflight';
import { preflightSnapshot, type PreflightLiveReads } from './toolPreflightInput';

export { createPreflightActionRunner } from './preflightActions';
export type { PreflightActionHost, PreflightActionRunner } from './preflightActions';

/**
 * One preflight pass, arranged the way a panel reads it: each product's verdict
 * by product id, and the interactive measurements in the model's own order.
 */
export interface PreflightView {
  readonly products: ReadonlyMap<ProductId, ToolPreflight>;
  readonly measureTools: readonly ToolPreflight[];
}

/**
 * Evaluate the preflight over live state and arrange it for the panel. The
 * binding says which family a tool belongs to, so neither this function nor the
 * panel keeps a list of which tools are products.
 */
export function preflightView(reads: PreflightLiveReads): PreflightView {
  const products = new Map<ProductId, ToolPreflight>();
  const measureTools: ToolPreflight[] = [];
  for (const entry of preflightSnapshot(reads)) {
    const product = toolProduct(entry.tool);
    if (product === null) measureTools.push(entry);
    else products.set(product, entry);
  }
  return { products, measureTools };
}
