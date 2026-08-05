#!/usr/bin/env node
/**
 * lint-worker-registry.mjs — completeness guard for the worker single source.
 *
 * Every Web Worker the app ships is declared once in
 * `src/workers/workerRegistry.ts`. `vite.config.ts` derives BOTH the
 * live-transform exclude patterns and the chunk-emission pins from that
 * registry, so no worker name is copied by hand into two lists. This is the
 * structural fix for the #266 crash class, where a worker missing from a
 * hand-maintained list shipped a chunk that 404s at runtime.
 *
 * This lint fails when that single source is incomplete or bypassed:
 *
 *   1. A worker module exists under `src/` (a `*Worker.ts` that is not a
 *      `*WorkerClient.ts`) but is not declared in the registry.
 *   2. A module holds `new Worker(new URL(...))` (a worker client) but its
 *      path is not declared as a registry `clientModule`.
 *   3. A declared `workerModule` / `clientModule` / `asyncBridgeModule` file
 *      does not exist on disk.
 *   4. `vite.config.ts` hand-lists a worker chunk name or a worker client/bridge
 *      basename as a literal instead of deriving it from the registry helpers.
 *
 * Pairs with tests/workerRegistry.test.ts (which imports the registry natively
 * and asserts the same completeness) and the chunk-emission assertions in
 * tests/chunkIsolation.test.ts (which prove every registered worker chunk
 * emits in the build output).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const REGISTRY = resolve(SRC, 'workers/workerRegistry.ts');
const VITE_CONFIG = resolve(ROOT, 'vite.config.ts');

const errors = [];
const fail = (msg) => errors.push(msg);

/** Strip block and line comments so documented examples never trip a scan. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Recursively list every `.ts` file under `src/`, as `src/...` POSIX paths. */
function listSrcTs(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listSrcTs(abs));
    else if (entry.endsWith('.ts')) out.push(relative(ROOT, abs).split('\\').join('/'));
  }
  return out;
}

/**
 * Parse the registry's declared entries out of the TS source. The registry is
 * a flat array of object literals with string fields, so a field-scoped regex
 * sweep is enough and avoids needing a TS loader in a plain-node script. The
 * native-import counterpart lives in tests/workerRegistry.test.ts.
 */
function parseRegistry() {
  const src = readFileSync(REGISTRY, 'utf8');
  // Isolate the array body so helper-function string literals never leak in.
  const arrayMatch = src.match(/WORKER_REGISTRY[^=]*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!arrayMatch) {
    fail('lint-worker-registry: could not locate the WORKER_REGISTRY array literal.');
    return [];
  }
  const body = arrayMatch[1];
  const blocks = body.split(/\},\s*\{/);
  const field = (block, name) => {
    const m = block.match(new RegExp(`${name}:\\s*'([^']+)'`));
    return m ? m[1] : undefined;
  };
  return blocks.map((block) => ({
    workerModule: field(block, 'workerModule'),
    workerChunk: field(block, 'workerChunk'),
    clientModule: field(block, 'clientModule'),
    asyncBridgeModule: field(block, 'asyncBridgeModule'),
    pinClientChunk: /pinClientChunk:\s*true/.test(block),
  }));
}

const registry = parseRegistry();
const declaredWorkerModules = new Set(registry.map((r) => r.workerModule).filter(Boolean));
const declaredClientModules = new Set(registry.map((r) => r.clientModule).filter(Boolean));

const allTs = listSrcTs();

// 1. Every on-disk worker module is declared.
const diskWorkerModules = allTs.filter(
  (p) => /Worker\.ts$/.test(p) && !/WorkerClient\.ts$/.test(p),
);
for (const mod of diskWorkerModules) {
  if (!declaredWorkerModules.has(mod)) {
    fail(
      `lint-worker-registry: worker module '${mod}' is not declared in src/workers/workerRegistry.ts. ` +
        'Add an entry so its obfuscation-exclude and chunk pin follow automatically.',
    );
  }
}

// 2. Every module that constructs a worker is declared as a clientModule.
for (const mod of allTs) {
  if (mod.endsWith('workerRegistry.ts')) continue;
  const text = stripComments(readFileSync(resolve(ROOT, mod), 'utf8'));
  if (/new Worker\(\s*new URL\(/.test(text) && !declaredClientModules.has(mod)) {
    fail(
      `lint-worker-registry: '${mod}' constructs a Worker but is not a registry clientModule. ` +
        'Declare it so the live transform excludes it.',
    );
  }
}

// 3. Every declared module file exists.
for (const r of registry) {
  for (const key of ['workerModule', 'clientModule', 'asyncBridgeModule']) {
    const p = r[key];
    if (p && !existsSync(resolve(ROOT, p))) {
      fail(`lint-worker-registry: declared ${key} '${p}' does not exist on disk.`);
    }
  }
}

// 4. vite.config.ts derives from the registry and hand-lists nothing.
const viteSrc = readFileSync(VITE_CONFIG, 'utf8');
if (!/workerExcludePatterns\(\)/.test(viteSrc) || !/workerChunkPins\(\)/.test(viteSrc)) {
  fail(
    'lint-worker-registry: vite.config.ts must derive its worker exclude and chunk lists via ' +
      'workerExcludePatterns() and workerChunkPins() from the registry.',
  );
}
// Strip comments so documentation of the old approach never trips the scan.
const viteCode = viteSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
for (const r of registry) {
  const clientBase = (r.clientModule ?? '').split('/').pop()?.replace(/\.ts$/, '');
  const bridgeBase = (r.asyncBridgeModule ?? '').split('/').pop()?.replace(/\.ts$/, '');
  for (const [label, name] of [
    ['worker chunk', r.workerChunk],
    ['client basename', clientBase],
    ['async-bridge basename', bridgeBase],
  ]) {
    if (!name) continue;
    // A quoted string or an explicit `<name>.ts` regex literal counts as a
    // hand-listed copy that the registry is meant to eliminate.
    const quoted = new RegExp(`['\`]${name}['\`]`);
    const regexLit = new RegExp(`/${name}\\\\?\\.ts/`);
    if (quoted.test(viteCode) || regexLit.test(viteCode)) {
      fail(
        `lint-worker-registry: vite.config.ts hand-lists the ${label} '${name}'. ` +
          'Remove the literal; it must come from the registry helpers.',
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`\nlint-worker-registry: ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `lint-worker-registry: OK — ${registry.length} workers declared, ` +
    `${diskWorkerModules.length} on-disk worker modules all covered, vite.config.ts derives both lists.`,
);
