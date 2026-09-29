/**
 * observatoryLiveDeps.ts — the live app's Observatory runner dependencies,
 * kept out of `main.ts` and free of runtime imports so the entry chunk does
 * not pull the Observatory pipeline in.
 */
import type { ObservatoryCloudInput } from './observatoryFromCloud';
import type { ObservatoryRunnerDeps } from './observatoryRunner';

/** The file name's last path segment: a run record never carries a directory. */
function baseName(name: string | undefined): string | null {
  const base = name?.split(/[\\/]/).pop() ?? '';
  return base === '' ? null : base;
}

/**
 * The live app's runner dependencies: the active scan, its base file name, and
 * the resolved CRS's metres per linear unit (null when the unit is not known,
 * so planning distances stay in source units, OB-INV-10).
 */
export interface ObservatoryLiveScans {
  activeCloud(): (ObservatoryCloudInput & { readonly name?: string }) | null;
  readonly activeId: string | null;
}

export interface ObservatoryLiveCrs {
  crsRevision(): number;
  context(): { readonly linearUnitToMetres: number; readonly linearUnitKnown: boolean };
}

export function observatoryLiveDeps(scans: ObservatoryLiveScans, crs: ObservatoryLiveCrs, buildTag: string): ObservatoryRunnerDeps {
  return {
    getActiveCloud: () => scans.activeCloud(),
    getDatasetId: () => scans.activeId,
    getCrsRevision: () => crs.crsRevision(),
    buildOptions: () => {
      const ctx = crs.context();
      return { filename: baseName(scans.activeCloud()?.name), metresPerUnit: ctx.linearUnitKnown ? ctx.linearUnitToMetres : null, buildTag };
    },
  };
}
