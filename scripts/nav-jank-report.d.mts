/** Types for nav-jank-report.mjs, which its unit test imports. */
import type { NavJankResults } from './lib/navJankResults.mjs';

export interface MetricDiff { base: number; head: number; diff: number; noise: number; beyondNoise: boolean }

export declare function assertResults(f: unknown, label?: string): void;
export declare function formatTable(f: NavJankResults): string;
export declare function compareRefusals(a: NavJankResults, b: NavJankResults): string[];
export type Refuse = (a: NavJankResults, b: NavJankResults) => string[];
export declare const GOVERNOR_FLAG: 'governor=on';
export declare function abRefusals(off: NavJankResults, on: NavJankResults): string[];
export declare function compareResults(a: NavJankResults, b: NavJankResults, refuse?: Refuse): Record<string, Record<string, MetricDiff>>;
export declare function formatComparison(a: NavJankResults, b: NavJankResults, refuse?: Refuse): string;
