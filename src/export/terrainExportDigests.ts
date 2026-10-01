/**
 * terrainExportDigests.ts: source-file digest and CRS origin for a terrain
 * export of `result`: the file the analysis sampled, or no single digest when
 * it combined several inputs. A newer export cancels a hash still running for
 * an older one; the export button keeps its busy text meanwhile.
 */
import { analysisSourceDigest } from './exportDigests';
import { exportDigests, type ExportDigests } from '../science/exportDigestRecord';
import type { CrsOriginInput } from '../science/crsOrigin';

/** The Analyse panel callbacks this reads. */
export interface TerrainDigestHost {
  getActiveScanId?: () => string | null;
  getFeatureCloud?: (scanId: string) => object | null;
  getMapContext?: () => { readonly crs?: CrsOriginInput | null } | undefined;
}

/** Resolves the record on export, for the Field Simulation packages. */
export type TerrainExportDigests = () => Promise<ExportDigests>;

let running: AbortController | null = null;

export async function terrainExportDigests(host: TerrainDigestHost, result: object): Promise<ExportDigests> {
  running?.abort();
  const abort = (running = new AbortController());
  const id = host.getActiveScanId?.() ?? null;
  const cloud = id ? host.getFeatureCloud?.(id) ?? null : null;
  return exportDigests(await analysisSourceDigest(result, cloud, abort.signal), host.getMapContext?.()?.crs ?? null);
}
