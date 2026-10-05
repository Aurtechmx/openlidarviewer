/** Types for vitestFileList.mjs, which vitest.config.ts and its test import. */
export declare const FILE_LIST_ENV: string;
export declare const WINDOWS_COMMAND_LINE_LIMIT: number;
export declare function writeFileList(files: readonly string[], parent?: string): { path: string; tallyPath: string; dispose(): void };
export declare function readFileList(env?: Record<string, string | undefined>): string[] | null;
export declare function vitestRunArgs(options: {
  prefix?: readonly string[];
  bucketArgs?: readonly string[];
  extra?: readonly string[];
  passthrough?: readonly string[];
  tallyFile: string;
}): string[];
export declare function commandLineLength(command: string, args: readonly string[]): number;
