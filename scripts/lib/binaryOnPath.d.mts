/**
 * Types for binaryOnPath.mjs, which TypeScript callers in benchmarks/ import.
 * Mirrors the arrangement already used for generate-raster-fixtures.d.mts.
 */
export declare function binaryOnPath(name: string, env?: NodeJS.ProcessEnv): string | null;
export declare function requireBinaryOnPath(name: string, env?: NodeJS.ProcessEnv): string;
