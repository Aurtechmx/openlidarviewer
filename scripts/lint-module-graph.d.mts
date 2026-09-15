/**
 * Types for the importable surface of `lint-module-graph.mjs`.
 *
 * The gate is plain ESM because it runs under bare `node` in CI with no build
 * step, but the architecture-fingerprint test and the release-manifest builder
 * import its measurement so the enforced graph facts and the published
 * fingerprint cannot drift apart. Only the two pure, side-effect-free exports
 * are declared; the CLI body is guarded behind `isCliEntry` and has no types.
 */

export interface ModuleGraphPairMeasurement {
  readonly runtime: number;
  readonly typeOnly: number;
  readonly dynamic: number;
  readonly edges: readonly string[];
  readonly lines: ReadonlyMap<string, number>;
}

export interface ModuleGraphFanOutMeasurement {
  readonly runtime: number;
  readonly typeOnly: number;
  readonly dynamic: number;
  readonly modules: readonly string[];
  readonly lines: ReadonlyMap<string, number>;
}

export interface ModuleGraphMeasurement {
  readonly graph: ReadonlyMap<string, unknown>;
  readonly problems: readonly string[];
  readonly pairs: ReadonlyMap<string, ModuleGraphPairMeasurement>;
  readonly fanOut: ReadonlyMap<string, ModuleGraphFanOutMeasurement>;
  /** The watched concentration modules; banded, not ratcheted. */
  readonly watchFanOut: ReadonlyMap<string, ModuleGraphFanOutMeasurement>;
  readonly cycles: { readonly count: number; readonly components: readonly string[][] };
  readonly inlineOnlyTotal: number;
  readonly totalEdges: number;
  readonly filesScanned: number;
}

export interface ArchitectureFingerprint {
  readonly moduleCount: number;
  readonly edgeCount: number;
  readonly cycleCount: number;
  readonly mainFanOut: number;
  readonly viewerFanOut: number;
  readonly architectureDigest: string;
}

export function measureModuleGraph(): ModuleGraphMeasurement;

export function computeArchitectureFingerprint(
  measurement?: ModuleGraphMeasurement,
): ArchitectureFingerprint;

/** One row of the concentration table the gate prints. */
export interface ConcentrationRow {
  readonly file: string;
  readonly loc: number;
  readonly fanOut: number;
  readonly rule: 'shrink-only' | 'watch';
}

/** The runtime fan-out a watched module may reach: banked plus 10 %, at least 3. */
export function watchAllowance(banked: number): number;

export function concentrationRows(measurement: ModuleGraphMeasurement): ConcentrationRow[];

export function formatConcentrationTable(rows: readonly ConcentrationRow[]): string;
