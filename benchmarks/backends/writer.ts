/**
 * writer.ts
 *
 * The backend-equivalence output tree: one JSON per leg, plus the comparison
 * and its report built from whichever legs are present.
 *
 * A LEG IS A FILE BECAUSE THE TWO LEGS ARE PRODUCED BY DIFFERENT RUNNERS. The
 * CPU control comes from vitest; the GPU leg comes from a Playwright spec in a
 * browser, which is the only place a WebGPU adapter exists. They never share a
 * process, so what passes between them is a file, and the comparator reads
 * files rather than in-memory state.
 *
 * A LEG THAT IS ABSENT IS ABSENT, NOT DEFAULTED. `readLeg` returns null for a
 * missing file and the comparator turns that into `backend-unavailable`. There
 * is no code path that substitutes a CPU leg for a missing GPU one.
 *
 * The clock is an argument, never read here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareBackends, type BackendComparison } from './compare';
import { comparisonMarkdown } from './render';
import { BACKEND_SCHEMA_VERSION, type BackendLegRecord } from './record';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const BACKENDS_DIR = join(REPO_ROOT, 'benchmark-results', 'backends');

export const CPU_LEG_FILE = 'leg-cpu.json';
export const GPU_LEG_FILE = 'leg-gpu.json';
export const COMPARISON_FILE = 'comparison.json';
export const REPORT_FILE = 'comparison.md';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Write one leg under an explicitly named file.
 *
 * The name is an argument rather than derived from the record, because the two
 * runners write the same slot: the Node command records what a host without an
 * adapter got, and the browser command replaces it with what a real device got.
 * Deriving the name from `executedBackend` would send a fallen-back GPU leg to
 * the CPU slot and overwrite the reference with a second copy of itself.
 */
export function writeLeg(
  leg: BackendLegRecord,
  fileName: string,
  dir: string = BACKENDS_DIR,
): string {
  ensureDir(dir);
  const file = join(dir, fileName);
  writeFileSync(file, `${JSON.stringify(leg, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Read a leg, or null when it is not there.
 *
 * A file whose schema version does not match is treated as absent rather than
 * parsed leniently: fields whose meaning changed would be compared under the
 * wrong interpretation, and that is a silent wrong answer rather than a missing
 * one.
 */
export function readLeg(fileName: string, dir: string = BACKENDS_DIR): BackendLegRecord | null {
  const file = join(dir, fileName);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as BackendLegRecord;
  if (parsed.backendSchemaVersion !== BACKEND_SCHEMA_VERSION) return null;
  return parsed;
}

export interface WrittenComparison {
  readonly comparison: BackendComparison;
  readonly comparisonPath: string;
  readonly reportPath: string;
}

/** Compare whatever legs are on disk and write the verdict and its report. */
export function writeComparison(dir: string = BACKENDS_DIR): WrittenComparison {
  const cpu = readLeg(CPU_LEG_FILE, dir);
  const gpu = readLeg(GPU_LEG_FILE, dir);
  const comparison = compareBackends(cpu, gpu);
  const legs = [cpu, gpu].filter((l): l is BackendLegRecord => l !== null);
  ensureDir(dir);
  const comparisonPath = join(dir, COMPARISON_FILE);
  const reportPath = join(dir, REPORT_FILE);
  writeFileSync(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  writeFileSync(reportPath, comparisonMarkdown(comparison, legs), 'utf8');
  return { comparison, comparisonPath, reportPath };
}
