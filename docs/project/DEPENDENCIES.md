# Dependency audit (v0.6.7)

This is the committed dependency baseline for OpenLiDARViewer, re-verified for
v0.6.7 on 2026-08-28 (UTC) from the committed `package-lock.json`. The v0.6.7
cycle added and removed no runtime or development package, so the resolved set
below is unchanged from v0.6.3. It is a baseline, not
the per-release record: the exact commit, toolchain, and lockfile hash for a
published release live in the release manifest and the exact-tag evidence
attached to that release. A committed document cannot name the commit it ships
in; those generated records can.

Since v0.6.0 the three bundled font packages moved from 5.2.8 to 5.3.0. No
package was added or removed, and no other bundled package changed.

The development toolchain moved after that baseline was taken: TypeScript to
7.0.2, Vite to 8.2.1, and Playwright to 1.62.1. All three are development-only
and none reaches the deployed app, so the runtime dependency set above is
unaffected.

| Field | Value |
|---|---|
| Release line | v0.6.7 |
| Baseline date (UTC) | 2026-07-25 |
| Canonical Node | 22.17.1 (`.nvmrc`) |
| Canonical npm | 10.9.2 (`package.json` `packageManager`) |
| `package-lock` lockfileVersion | 3 |
| SBOM | CycloneDX 1.6, root `openlidarviewer@0.6.7`, 56 components |

The CycloneDX bill of materials for the production dependency set is in
[sbom.json](../../sbom.json). Licences are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Direct runtime dependencies

These ship in the deploy archive.

| Package | Declared range | Resolved | License |
|---|---|---|---|
| @fontsource-variable/inter | ^5.3.0 | 5.3.0 | OFL-1.1 |
| @fontsource/jetbrains-mono | ^5.3.0 | 5.3.0 | OFL-1.1 |
| @fontsource/manrope | ^5.3.0 | 5.3.0 | OFL-1.1 |
| @loaders.gl/core | ^4.4.4 | 4.4.4 | MIT |
| @loaders.gl/gltf | ^4.4.2 | 4.4.3 | MIT |
| @loaders.gl/obj | ^4.4.5 | 4.4.5 | MIT |
| @loaders.gl/ply | ^4.4.4 | 4.4.4 | MIT |
| laz-perf | ^0.0.7 | 0.0.7 | Apache-2.0 |
| pdf-lib | ^1.17.1 | 1.17.1 | MIT |
| proj4 | ^2.21.0 | 2.21.0 | MIT |
| three | ^0.184.0 | 0.184.0 | MIT |

## Direct development dependencies

Build, test, docs, and mutation tooling. None reaches the deployed app.

| Package | Declared range | Resolved | License |
|---|---|---|---|
| @loaders.gl/las | ^4.4.4 | 4.4.4 | MIT |
| @playwright/test | ^1.62.1 | 1.62.1 | Apache-2.0 |
| @stryker-mutator/core | ^9.6.1 | 9.6.1 | Apache-2.0 |
| @stryker-mutator/vitest-runner | ^9.6.1 | 9.6.1 | Apache-2.0 |
| @types/proj4 | ^2.19.0 | 2.19.0 | MIT |
| @types/three | ^0.184.1 | 0.184.1 | MIT |
| @vitest/coverage-v8 | ^4.1.10 | 4.1.10 | MIT |
| rollup-plugin-visualizer | ^7.1.1 | 7.1.1 | MIT |
| typescript | ~7.0.2 | 7.0.2 | Apache-2.0 |
| vite | ^8.2.1 | 8.2.1 | MIT |
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
5 vulnerabilities (5 high)
```

All five are one package reached by four paths:

| Root package | Severity | Reached through | Reaches the deployed app? |
|---|---|---|---|
| brace-expansion | high | minimatch, multimatch, javascript-obfuscator, the obfuscator Vite plugin | No |

The advisory is GHSA-mh99-v99m-4gvg, an out-of-memory crash on unbounded brace
expansion. It covers every published version up to and including 5.0.7, so
there is no version to move to; `npm audit` reports `fixAvailable: false`. The
input in each of these paths is a glob pattern written in this repository, not
anything a user supplies, and the code runs at build time on a developer
machine or a CI runner. It will be picked up when upstream publishes a fix.

The production dependency set is clean: `npm audit --omit=dev` reports zero.

## Resolved by override

Four advisories that previously sat here are closed. `package.json` pins them
through `overrides` rather than waiting on the packages that depend on them:

| Package | Was | Now | Advisory |
|---|---|---|---|
| vite (under vitepress) | 5.4.21 | 6.4.3 | dev-server path traversal, `server.fs.deny` bypass, launch-editor NTLM disclosure |
| esbuild (under vitepress) | 0.21.5 | 0.25.12 | dev-server permissive CORS |
| qs (under typed-rest-client) | 6.15.1 | 6.15.3 | `qs.stringify` denial of service |
| brace-expansion | 1.1.15 | 1.1.16 | CVE-2026-13149, exponential-time expansion |

The `vite` override is scoped to `vitepress` alone. The application builds on
Vite 8.2.1 and is not affected by it. `npm run docs:build` passes on the
overridden tree.

## Stubbed to prune

`texture-compressor` is replaced by a local empty stub through a
`file:vendor-stubs/texture-compressor` override. It sits under
`@loaders.gl/textures` on the encode path only, which shells out to `npx
texture-compressor`. OLV decodes glTF and never encodes, so it never invokes
that CLI, and there are zero references to it in the built `dist`. The real
package pulls `image-size@0.7.5`, which carries CVE-2025-71329 and
CVE-2025-71330 (HIGH, denial of service) with no fixed upstream version. The
stub removes `image-size` and its own transitives (`argparse`, `sprintf-js`)
from the installed tree rather than accepting an advisory with no available fix.

## Deferred upgrades

Remaining open Dependabot bumps are major-version migrations that would
invalidate the build and test contract this release line was validated
against, so they wait for a dedicated update:

- Dependabot #10, #27, #28, #29, #30 (GitHub Actions), #33 (Three.js 0.185.x):
  not merged into this release line.

VitePress itself stays at 1.6.4, which is the latest stable release; 2.0.0 has
only alpha builds.

The TypeScript 7 / Vite 8.2.1 toolchain bump is no longer deferred. Dependabot
#40 landed as a dedicated toolchain update: TypeScript 7.0.2, Vite 8.2.1, and
Playwright 1.62.1, with no application source change. It was taken on its own
rather than alongside the migrations above so the build and test contract could
be re-validated against one variable.

## How to reproduce

```
nvm use          # 22.17.1, from .nvmrc
npm ci
npm audit --omit=dev --audit-level=high   # production set: expect 0
npm audit                                 # full dev tree: expect the advisory above
```
