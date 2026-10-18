/**
 * lazPerfWasmEmbed.test.ts: the base64 WASM compiled into src/io/lazPerfWasm.ts
 * is the exact laz-perf binary the lockfile installs, and the script that
 * regenerates it works with the base64 that ships on macOS as well as GNU's.
 *
 * The decoder runs whatever bytes are in that constant. If it drifted from the
 * installed package (a dependency bump nobody re-embedded, or a regeneration
 * that mangled the encoding), the LAZ path would run code nobody reviewed.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAZ_PERF_WASM_BASE64 } from '../src/io/lazPerfWasm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_WASM = join(ROOT, 'node_modules/laz-perf/lib/web/laz-perf.wasm');
const SCRIPT = join(ROOT, 'scripts/embed-laz-perf-wasm.sh');

/** SHA-256 of laz-perf's web WASM at the version the lockfile pins. */
const EXPECTED_SHA256 = '9c1802bc31b567dd4aa1ce9ab010e7e51e095dc42af8379b474ae6f221a9327f';

const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const havePkg = existsSync(PKG_WASM);
if (!havePkg) {
  // Skipped visibly, never silently: the reason is in the test names below.
  console.warn(`lazPerfWasmEmbed: ${PKG_WASM} is absent; the package comparison is skipped.`);
}

describe('embedded laz-perf WASM', () => {
  it('is a single base64 string with no whitespace', () => {
    expect(LAZ_PERF_WASM_BASE64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('decodes to the pinned laz-perf binary', () => {
    const bytes = Buffer.from(LAZ_PERF_WASM_BASE64, 'base64');
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]); // \0asm
    expect(sha256(bytes)).toBe(EXPECTED_SHA256);
  });

  it.skipIf(!havePkg)('matches node_modules/laz-perf/lib/web/laz-perf.wasm byte for byte', () => {
    const embedded = Buffer.from(LAZ_PERF_WASM_BASE64, 'base64');
    const installed = readFileSync(PKG_WASM);
    expect(sha256(installed)).toBe(sha256(embedded));
    expect(installed.equals(embedded)).toBe(true);
  });
});

describe('scripts/embed-laz-perf-wasm.sh', () => {
  it('uses no GNU-only base64 flag', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).not.toMatch(/base64\s+-w/);
  });

  it.skipIf(!havePkg)('regenerates src/io/lazPerfWasm.ts identically with this platform\'s base64', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-embed-'));
    try {
      // The script cds to its own parent directory, so give it a scratch tree
      // laid out the same way and leave the real one untouched.
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'src/io'), { recursive: true });
      mkdirSync(join(dir, 'node_modules/laz-perf/lib/web'), { recursive: true });
      copyFileSync(SCRIPT, join(dir, 'scripts/embed-laz-perf-wasm.sh'));
      copyFileSync(PKG_WASM, join(dir, 'node_modules/laz-perf/lib/web/laz-perf.wasm'));

      const r = spawnSync('bash', [join(dir, 'scripts/embed-laz-perf-wasm.sh')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);

      const generated = readFileSync(join(dir, 'src/io/lazPerfWasm.ts'), 'utf8');
      const committed = readFileSync(join(ROOT, 'src/io/lazPerfWasm.ts'), 'utf8');
      expect(generated).toBe(committed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
