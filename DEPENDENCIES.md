# Dependency audit — v0.6.0-alpha.3

Recorded 2026-07-22 (UTC) against the `v0.6.0-alpha.3` candidate at commit
`0fcdfd4`, from the committed `package-lock.json`. The dependency graph is
unchanged through the alpha.3 release-integrity pass — no package was added,
removed, or upgraded.

| Field | Value |
|---|---|
| Release version | 0.6.0-alpha.3 |
| Candidate commit | `0fcdfd4` |
| Audit date (UTC) | 2026-07-22 |
| Node | v26.0.0 |
| npm | 11.12.1 |
| `package-lock` lockfileVersion | 3 |
| SBOM | CycloneDX 1.6, root `openlidarviewer@0.6.0-alpha.3`, 59 components |

The CycloneDX software bill of materials for the production dependency set is in
[sbom.json](sbom.json). Third-party licences are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Direct runtime dependencies

These ship in the deploy archive.

| Package | Declared range | Resolved | License |
|---|---|---|---|
| @fontsource-variable/inter | ^5.2.8 | 5.2.8 | OFL-1.1 |
| @fontsource/jetbrains-mono | ^5.2.8 | 5.2.8 | OFL-1.1 |
| @fontsource/manrope | ^5.2.8 | 5.2.8 | OFL-1.1 |
| @loaders.gl/core | ^4.4.2 | 4.4.3 | MIT |
| @loaders.gl/gltf | ^4.4.2 | 4.4.3 | MIT |
| @loaders.gl/obj | ^4.4.2 | 4.4.3 | MIT |
| @loaders.gl/ply | ^4.4.2 | 4.4.3 | MIT |
| laz-perf | ^0.0.7 | 0.0.7 | Apache-2.0 |
| pdf-lib | ^1.17.1 | 1.17.1 | MIT |
| proj4 | ^2.20.8 | 2.20.9 | MIT |
| three | ^0.184.0 | 0.184.0 | MIT |

## Direct development dependencies

Build, test, docs, and mutation tooling. None reaches the deployed app.

| Package | Declared range | Resolved | License |
|---|---|---|---|
| @playwright/test | ^1.60.0 | 1.61.1 | Apache-2.0 |
| @stryker-mutator/core | ^9.6.1 | 9.6.1 | Apache-2.0 |
| @stryker-mutator/vitest-runner | ^9.6.1 | 9.6.1 | Apache-2.0 |
| @types/proj4 | ^2.19.0 | 2.19.0 | MIT |
| @types/three | ^0.184.1 | 0.184.1 | MIT |
| @vitest/coverage-v8 | ^4.1.10 | 4.1.10 | MIT |
| rollup-plugin-visualizer | ^7.0.1 | 7.0.1 | MIT |
| typescript | ~6.0.2 | 6.0.3 | Apache-2.0 |
| vite | ^8.0.12 | 8.1.3 | MIT |
| vite-plugin-javascript-obfuscator | ^3.1.0 | 3.1.0 | MIT |
| vitepress | 1.6.4 | 1.6.4 | MIT |
| vitest | ^4.1.7 | 4.1.10 | MIT |

## Production / runtime security status

```
npm audit --omit=dev --audit-level=high
found 0 vulnerabilities
```

The shipped application — everything in the deploy archive — carries no known
advisories. This is the audit that describes the artifact users receive.

## Development-tooling advisories

```
npm audit --audit-level=high
7 vulnerabilities (4 moderate, 3 high)
```

Every advisory sits in build- or docs-tooling that never ships. The roots:

| Root package | Severity | Reached through | Reaches deployed app? |
|---|---|---|---|
| brace-expansion | high | dev tooling | No |
| fast-uri | high | dev tooling | No |
| esbuild | moderate | vitepress → vite | No — docs site build |
| qs | moderate | typed-rest-client | No — dev tooling |

These affect a developer running the dev server, the VitePress docs server, or
the mutation runner on their own machine, not the static production build.

## Intentionally deferred maintenance upgrades

Clearing the dev-tooling advisories, and the open Dependabot bumps, would require
major-version toolchain migrations (`vitepress`/`vite`, and the
`actions/*` / TypeScript 7 / Three.js 0.185 PRs) beyond the scope of this
release-integrity pass and would risk the build/test contract this candidate was
validated against. They are recorded as known, non-shipping items and tracked for
a future toolchain update. Deferred:

- `vitepress` / bundled `vite` / `esbuild` — docs tooling advisory chain.
- `brace-expansion`, `fast-uri`, `qs` (via `typed-rest-client`) — dev-tree only.
- Dependabot PRs #10, #27, #28, #29, #30 (GitHub Actions), #33 (Three.js 0.185.x),
  #34 (TypeScript 7 / Vite 8.1.5) — not merged into this release.

No dependency version was changed to produce this audit.

## How to reproduce

```
npm ci
npm audit --omit=dev --audit-level=high   # production set — expect 0
npm audit --audit-level=high              # full dev set — expect the tooling advisories above
```
