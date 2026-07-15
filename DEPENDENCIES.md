# Dependency audit — v0.5.9

Recorded 2026-07-15 at commit `c8e4ef0`, Node v26.0.0, npm 11.12.1, from the
committed `package-lock.json`.

A CycloneDX 1.6 software bill of materials for the production dependency set is in
[sbom.json](sbom.json) (61 components). Third-party licences are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Production dependencies

```
npm audit --omit=dev
found 0 vulnerabilities
```

The shipped application — everything in the deploy archive — carries no known
advisories.

## Development dependencies

```
npm audit
3 vulnerabilities (2 moderate, 1 high)
```

All three are in **build- and docs-tooling that never ships**:

| Severity | Package  | Advisory (summary)                                                                                   | Reaches the deployed app? |
|----------|----------|------------------------------------------------------------------------------------------------------|---------------------------|
| high     | vite     | dev-server path traversal in optimised-deps `.map` handling; `server.fs.deny` bypass on Windows alternate paths; bundled `launch-editor` / `esbuild` | No — dev server only      |
| moderate | esbuild  | dev server allows any site to send requests and read responses                                       | No — dev server only      |
| moderate | vitepress| inherits the `vite` advisory (docs site build)                                                       | No — docs tooling only    |

These affect a developer running `npm run dev` or the VitePress docs server on
their own machine, not the static production build. The production audit above is
the one that describes the artifact users receive.

### Remediation status

Clearing the dev-tooling advisories requires a major-version bump of `vite`
(and the matching `vitepress`), which is a toolchain migration beyond the scope of
a v0.5.9 hygiene pass and would risk the build/test contract this release was
validated against. It is recorded here as a known, non-shipping limitation and is
tracked for a future toolchain update. Developers who want to clear them locally
can run `npm audit fix --force`, understanding it may change the build toolchain.

## How to reproduce

```
npm ci
npm audit --omit=dev     # production set — expect 0
npm audit                # full dev set — expect the dev-tooling advisories above
npx @cyclonedx/cyclonedx-npm@2 --omit dev --output-format JSON --output-file sbom.json
```
