# Contributing to OpenLiDARViewer

Thanks for your interest in improving OpenLiDARViewer.

## Getting started

```bash
npm install
npm run dev
```

## Project layout

- `src/io/` — one file per format or per IO concern (sniffer, LAS header, coordinate bridge, loaders).
- `src/model/` — the normalized `PointCloud` model.
- `src/process/` — voxel downsampling.
- `src/render/` — the three.js viewer and color modes.
- `src/analysis/` — the analysis-module API and the validation modules.
- `src/ui/` — the DOM shell (stage, drop zone, Inspector, tool dock).
- `tests/` — Vitest unit tests; `tests/e2e/` — Playwright end-to-end tests.

## Working style

- The algorithmic core is test-first. Each IO, processing, and analysis module has a matching `tests/*.test.ts`. Add a failing test, then the implementation.
- TypeScript runs strict (`verbatimModuleSyntax`, `erasableSyntaxOnly`). Use `import type` for type-only imports; no `enum` or `namespace`.
- Analysis modules consume `PointCloud` only — they must not import three.js.

## Before opening a pull request

```bash
npm run typecheck   # tsc --noEmit
npm test            # Vitest unit suite
npm run build       # production build
npm run test:e2e    # Playwright (run `npx playwright install --with-deps chromium` once)
```

All four must pass. CI runs the same checks.

## Scope

v1 is intentionally small — see `docs/implementation-plan.md` for what is in scope and what is deferred to v2. New formats, the compute-rasterization core, and additional analysis modules are welcome as v2 work.

Licensed under MIT — by contributing you agree your contributions are licensed the same way.
