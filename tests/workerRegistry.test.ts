/**
 * tests/workerRegistry.test.ts
 *
 * Completeness contract for the worker single source of truth
 * (src/workers/workerRegistry.ts). Imports the registry natively (no textual
 * parsing) and asserts that every worker on disk is declared, that the
 * declarations point at real files, and that the derived helpers cover the set
 * vite.config.ts consumes.
 *
 * This is the vitest counterpart of scripts/lint-worker-registry.mjs — two
 * guards, one contract. It fails the suite if a worker module exists under
 * `src/` but is missing from the registry, the defect class behind #266.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  WORKER_REGISTRY,
  workerExcludeModules,
  workerExcludePatterns,
  workerChunkPins,
} from '../src/workers/workerRegistry';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function listSrcTs(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listSrcTs(abs));
    else if (entry.endsWith('.ts')) out.push(relative(ROOT, abs).split('\\').join('/'));
  }
  return out;
}

describe('worker registry single source', () => {
  const allTs = listSrcTs();
  const declaredWorkerModules = new Set(WORKER_REGISTRY.map((w) => w.workerModule));
  const declaredClientModules = new Set(WORKER_REGISTRY.map((w) => w.clientModule));

  it('declares every worker module that exists under src/', () => {
    const diskWorkerModules = allTs.filter(
      (p) => /Worker\.ts$/.test(p) && !/WorkerClient\.ts$/.test(p),
    );
    const undeclared = diskWorkerModules.filter((p) => !declaredWorkerModules.has(p));
    expect(undeclared, `undeclared worker modules: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('declares every module that constructs a Worker as a clientModule', () => {
    const undeclared: string[] = [];
    for (const mod of allTs) {
      if (mod.endsWith('workerRegistry.ts')) continue;
      const text = readFileSync(join(ROOT, mod), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/new Worker\(\s*new URL\(/.test(text) && !declaredClientModules.has(mod)) {
        undeclared.push(mod);
      }
    }
    expect(undeclared, `worker-constructing modules missing from registry: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('points every declared module at a file that exists', () => {
    const missing: string[] = [];
    for (const w of WORKER_REGISTRY) {
      for (const p of [w.workerModule, w.clientModule, w.asyncBridgeModule]) {
        if (p && !existsSync(join(ROOT, p))) missing.push(p);
      }
    }
    expect(missing, `declared but missing files: ${missing.join(', ')}`).toEqual([]);
  });

  it('derives an exclude pattern for every client and async bridge', () => {
    const expected = workerExcludeModules().map((m) => m.split('/').pop());
    const patterns = workerExcludePatterns();
    expect(patterns).toHaveLength(expected.length);
    for (const base of expected) {
      const hit = patterns.some((re) => re.test(`src/x/${base}`));
      expect(hit, `no exclude pattern matches ${base}`).toBe(true);
    }
  });

  it('pins every worker chunk plus each dynamically-imported client chunk', () => {
    const pins = workerChunkPins();
    for (const w of WORKER_REGISTRY) {
      expect(pins, `missing chunk pin for ${w.workerChunk}`).toContain(w.workerChunk);
      if (w.pinClientChunk) {
        const clientChunk = w.clientModule.split('/').pop()!.replace(/\.ts$/, '');
        expect(pins, `missing client chunk pin for ${clientChunk}`).toContain(clientChunk);
      }
    }
  });

  it('vite.config.ts derives its worker lists from the registry helpers', () => {
    const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/workerExcludePatterns\(\)/);
    expect(vite).toMatch(/workerChunkPins\(\)/);
  });
});
