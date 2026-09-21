/**
 * stockpileBandInputs.ts — what the stockpile toast band needs, as data.
 *
 * A TYPE-ONLY seam, and that is the whole point. `Viewer.computeLassoVolume`
 * used to call `stockpileToastSuffix` itself, which pulled the area-grid
 * estimator, the presenter and the uncertainty model into the eagerly-loaded
 * Viewer chunk — to produce a band that cannot appear until a user has drawn
 * a lasso. Handing back the ingredients instead lets the caller `import()`
 * the estimator at the moment it has something to measure, and nothing
 * downloads it before then.
 *
 * Nothing here runs: a type-only module contributes no bytes to any chunk.
 */
import type { Vec3 } from '../navMath';
import type { StockpileToastOptions } from './stockpilePresenter';

export interface StockpileBandInputs {
  /** The convex-hull footprint, lifted to the integration reference plane. */
  readonly polygon: ReadonlyArray<Vec3>;
  /** The selected points the volume was integrated over. */
  readonly positions: Float32Array;
  /** Metres per source linear unit, horizontal. */
  readonly lin: number;
  /** Scope and unit facts the band's honesty rules read. */
  readonly options: StockpileToastOptions;
}
