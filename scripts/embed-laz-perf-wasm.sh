#!/usr/bin/env bash
# Regenerate src/io/lazPerfWasm.ts — embeds the laz-perf WASM as base64 so the
# LAZ decoder is fully self-contained: no separate .wasm file to host, no
# network fetch, identical behaviour in the browser, a Web Worker, and Node.
set -euo pipefail
cd "$(dirname "$0")/.."
WASM=node_modules/laz-perf/lib/web/laz-perf.wasm
{
  echo "// AUTO-GENERATED — do not edit. Regenerate with scripts/embed-laz-perf-wasm.sh"
  echo "// Source: laz-perf/lib/web/laz-perf.wasm — the LAZ decompression WASM module."
  printf 'export const LAZ_PERF_WASM_BASE64 =\n  "'
  base64 -w0 "$WASM"
  printf '";\n'
} > src/io/lazPerfWasm.ts
echo "wrote src/io/lazPerfWasm.ts ($(wc -c < src/io/lazPerfWasm.ts) bytes)"
