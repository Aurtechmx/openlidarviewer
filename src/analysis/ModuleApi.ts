import type { PointCloud } from '../model/PointCloud';

export type AnalysisStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface AnalysisRow {
  label: string;
  value: string;
  status: AnalysisStatus;
  /** When true, the row is a diagnostic shown under "Advanced report". */
  advanced?: boolean;
}

export interface AnalysisResult {
  rows: AnalysisRow[];
}

export interface Selection {
  pointIndices: number[];
}

export interface AnalysisModule {
  id: string;
  label: string;
  run(cloud: PointCloud, selection?: Selection): AnalysisResult;
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
