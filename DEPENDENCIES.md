# Dependency audit — v0.6.1

This is the committed dependency baseline for OpenLiDARViewer v0.6.1, recorded
2026-07-25 (UTC) from the committed `package-lock.json`. It is a baseline, not
the per-release record: the exact commit, toolchain, and lockfile hash for a
published release live in the release manifest and the exact-tag evidence
attached to that release. A committed document cannot name the commit it ships
in; those generated records can.

Since v0.6.0 the three bundled font packages moved from 5.2.8 to 5.3.0. No
package was added or removed, and no other bundled package changed.

The development toolchain moved after that baseline was taken: TypeScript to
7.0.2, Vite to 8.1.5, and Playwright to 1.62.0. All three are development-only
and none reaches the deployed app, so the runtime dependency set above is
unaffected.

| Field | Value |
|---|---|
| Release line | v0.6.1 |
| Baseline date (UTC) | 2026-07-25 |
| Canonical Node | 22.17.1 (`.nvmrc`) |
| Canonical npm | 10.9.2 (`package.json` `packageManager`) |
| `package-lock` lockfileVersion | 3 |
| SBOM | CycloneDX 1.6, root `openlidarviewer@0.6.1`, 59 components |

The CycloneDX bill of materials for the production dependency set is in
[sbom.json](sbom.json). Licences are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Direct runtime dependencies

These ship in the deploy archive.

| Package | Declared range | Resolved | License |
|---|---|---|---|
| @fontsource-variable/inter | ^5.3.0 | 5.3.0 | OFL-1.1 |
| @fontsource/jetbrains-mono | ^5.3.0 | 5.3.0 | OFL-1.1 |
| @fontsource/manrope | ^5.3.0 | 5.3.0 | OFL-1.1 |
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
| @playwright/test | ^1.60.0 | 1.62.0 | Apache-2.0 |
| @stryker-mutator/core | ^9.6.1 | 9.6.1 | Apache-2.0 |
| @stryker-mutator/vitest-runner | ^9.6.1 | 9.6.1 | Apache-2.0 |
| @types/proj4 | ^2.19.0 | 2.19.0 | MIT |
| @types/three | ^0.184.1 | 0.184.1 | MIT |
| @vitest/coverage-v8 | ^4.1.10 | 4.1.10 | MIT |
| rollup-plugin-visualizer | ^7.0.1 | 7.0.1 | MIT |
| typescript | ~7.0.2 | 7.0.2 | Apache-2.0 |
| vite | ^8.1.5 | 8.1.5 | MIT |
| vite-plugin-javascript-obfuscator | ^3.1.0 | 3.1.0 | MIT |
| vitepress | 1.6.4 | 1.6.4 | MIT |
| vitest | ^4.1.7 | 4.1.10 | MIT |

## Production security status

```
npm audit --omit=dev --audit-level=high
found 0 vulnerabilities
```

Run under Node 22.17.1 / npm 10.9.2 on the baseline date. The deploy archive
carries no known advisories. This audit describes the artifact users receive;
the release workflow repeats it on the exact tagged commit and records the
result in the attached evidence.

## Development-tooling advisories

```
npm audit
7 vulnerabilities (4 moderate, 3 high)
```

Every advisory sits in build or docs tooling that never ships:

| Root package | Severity | Reached through | Reaches the deployed app? |
|---|---|---|---|
| brace-expansion | high | dev tooling | No |
| fast-uri | high | dev tooling | No |
| esbuild | moderate | vitepress → vite | No, docs site build only |
| qs | moderate | typed-rest-client | No, dev tooling only |

These affect a developer running the dev server, the VitePress docs server, or
the mutation runner on their own machine. The static production build is not
exposed to any of them.

## Deferred upgrades

Clearing the remaining dev-tooling advisories and open Dependabot bumps means
major-version migrations: `vitepress` and its bundled `vite`, the `actions/*`
bumps, Three.js 0.185. Each would invalidate the build and test contract this
release line was validated against, so they wait for a dedicated update.
Deferred, with their tracking PRs:

- `vitepress` / bundled `vite` / `esbuild`: the docs-tooling advisory chain.
- `brace-expansion`, `fast-uri`, `qs` (via `typed-rest-client`): dev tree only.
- Dependabot #10, #27, #28, #29, #30 (GitHub Actions), #33 (Three.js 0.185.x):
  not merged into this release line.

The TypeScript 7 / Vite 8.1.5 toolchain bump is no longer deferred. Dependabot
#40 landed as a dedicated toolchain update: TypeScript 7.0.2, Vite 8.1.5, and
Playwright 1.62.0, with no application source change. It was taken on its own
rather than alongside the migrations above so the build and test contract could
be re-validated against one variable.

## How to reproduce

```
nvm use          # 22.17.1, from .nvmrc
npm ci
npm audit --omit=dev --audit-level=high   # production set: expect 0
npm audit                                 # full dev tree: expect the advisories above
```
