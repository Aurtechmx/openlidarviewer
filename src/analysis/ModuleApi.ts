import type { PointCloud } from '../model/PointCloud';
import type { ClassScope } from '../render/class/classScope';
import type { SpatialContext } from '../geo/SpatialContext';

export type AnalysisStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface AnalysisRow {
  label: string;
  value: string;
  status: AnalysisStatus;
  /** When true, the row is a diagnostic shown under "Advanced report". */
  advanced?: boolean;
  /**
   * Declared source-metadata grouping. `src-std` rows render inside the
   * collapsible "Source metadata" section; `src-ext` rows go in its
   * "Extended metadata (file-declared)" subsection. Both carry verbatim
   * file declarations — declared, not verified — so the Inspector renders
   * them under that disclosure and truncates long values with a tooltip.
   * (Tokens kept short deliberately: they ride the eager index bundle.)
   */
  group?: 'src-std' | 'src-ext';
  /**
   * Honesty stamp: the class scope this metric was computed under. Set only
   * on rows whose value changes with the class filter (count, density,
   * coverage, …). Absent or `{kind:'full'}` means the metric reflects the
   * whole cloud and renders exactly as it did before class scoping existed.
   */
  scope?: ClassScope;
}

export interface AnalysisResult {
  rows: AnalysisRow[];
  /** Optional result-level scope; rows may also carry their own. */
  scope?: ClassScope;
}

export interface Selection {
  pointIndices: number[];
}

/** Options threaded into a module run. Optional so existing callers compile unchanged. */
export interface RunOptions {
  /**
   * Restrict class-dependent metrics to the visible subset of classes. When
   * absent or `{kind:'full'}`, every module behaves byte-identically to before
   * class scoping existed.
   */
  scope?: ClassScope;
  /**
   * The RESOLVED active spatial context (`crsService.context()`), threaded from
   * the composition root so a module's unit gate and metric frame honour a user
   * CRS/unit override rather than re-deriving them from `cloud.metadata.crs`.
   * Absent only for pure-module callers/tests, which fall back to the cloud's
   * declared CRS — byte-identical to before for a same-unit no-override scan.
   * This changes the SOURCE of unit/frame truth, never a metric formula.
   */
  spatialContext?: SpatialContext;
}

export interface AnalysisModule {
  id: string;
  label: string;
  run(cloud: PointCloud, selection?: Selection, options?: RunOptions): AnalysisResult;
}

export class ModuleRegistry {
  private readonly _modules: Map<string, AnalysisModule> = new Map();

  register(m: AnalysisModule): void {
    if (this._modules.has(m.id)) {
      throw new Error(`Module with id "${m.id}" is already registered.`);
    }
    this._modules.set(m.id, m);
  }

  list(): AnalysisModule[] {
    return Array.from(this._modules.values());
  }

  get(id: string): AnalysisModule | undefined {
    return this._modules.get(id);
  }
}
