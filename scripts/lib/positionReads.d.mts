/**
 * Types for positionReads.mjs, which tests/positionReads.test.ts imports.
 * Mirrors the arrangement already used for binaryOnPath.d.mts.
 */

export interface PositionReadScope {
  /** `all-src` or `outside-model`; the string the scanners print. */
  id: string;
  /** Human phrasing of the same scope, for a message a reader has to act on. */
  label: string;
  excludeModel: boolean;
}

export declare const SCOPES: Record<string, PositionReadScope>;

export declare function readsOnLine(raw: string): number;
export declare function countPositionReads(text: string): number;
export declare function positionReadLines(
  text: string,
): Array<{ line: number; text: string; count: number }>;
export declare function walkPositionSources(srcDir: string, scope: PositionReadScope): string[];
export declare function scanPositionReads(
  srcDir: string,
  scopeId: string,
): { scope: PositionReadScope; byFile: Map<string, number>; total: number; fileCount: number };
