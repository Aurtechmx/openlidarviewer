# Release checklist

Run through this before tagging a release. It exists because a version bump on
its own leaves siblings stale (the lockfile and README), and because two of the
hardening steps are deliberately staged and easy to forget.


## Version bump

`sbom.json` records the version in its root component, `bom-ref` and `purl`, so
a bump leaves it stale and `lint:sbom` fails. Regenerate it in the same change:

```bash
npx @cyclonedx/cyclonedx-npm@6.0.1 --omit dev --output-file sbom.json
```

The generator version is pinned to `6.0.1`, the version the SBOM's own
`metadata.tools` records, so an unpinned `npx` cannot pick up a newer release
between regenerations. Run it with the pinned toolchain (Node from `.nvmrc`,
npm from `packageManager`, currently Node 22 and npm 10): the SBOM records the
npm that produced it, and the current `sbom.json` metadata names npm 11.19.0,
which is not the pinned npm. That is noted here and not corrected; the next
regeneration should come from the pinned toolchain.

While the bump lives on a branch and `main` is still on the old version, every
merge from `main` resolves `sbom.json` backwards and the gate fails again. That
stops once the bump lands. Until then, regenerate after each merge rather than
assuming the working tree is right: `package.sh` builds the archive from
`git archive HEAD`, so an uncommitted fix never reaches the zip.

## 1. Version sync (do these together)

- [ ] `package.json` `version` bumped.
- [ ] `package-lock.json` regenerated so its version matches:
      `npm install --package-lock-only`
      then confirm: `node -e "const l=require('./package-lock.json'); console.log(l.version, l.packages[''].version)"` → both the new version.
- [ ] `README.md` "current release" line and the version-history section updated.
- [ ] `CHANGELOG.md` has a dated section for this version.
- [ ] `RELEASE_NOTES_v<X.Y.Z>.md` written.

## 2. Gate battery (must be green)

- [ ] `npm run typecheck`
- [ ] `npm run lint:main-deferral`
- [ ] `npm run build`
- [ ] `npm run build:live` (the obfuscated bundle the deploy ships)
- [ ] `npm run check:bundle` (bundle budget)
- [ ] `npm run test:build` (plain-build chunk-isolation contract + orbit smoke)
- [ ] `npm run test:buckets:verify`
- [ ] `npm run test:unit && npm run test:export && npm run test:terrain && npm run test:ui && npm run test:slow`
- [ ] `npm run test:smoke`, then `npm run test:smoke:live` (boots the obfuscated artifact users actually get), and `npm run test:e2e` (need a browser/GPU; run where available)
- [ ] `npm audit --omit=dev --audit-level=high` clean
- [ ] No embed allow-list in the archive. `OLV_EMBED_ORIGINS` is compiled into the build, so one left exported in the packaging shell would make every archive trust those origins to frame the viewer. `scripts/package.sh` and `scripts/smoke-deploy-zip.mjs` fail when the pages carry a list; `OLV_ALLOW_EMBED_ORIGINS=1` acknowledges a list that is intended (a host that cannot send `frame-ancestors`). Unset `OLV_EMBED_ORIGINS` for a general release.

## 3. Local-first / security gates

- [ ] No new third-party origins in the shipped bundle. After `npm run build`,
      grep `dist/` for unexpected hosts (`unpkg`, `cdn`, `jsdelivr`, `googleapis`,
      `analytics`); the only outbound calls should be user-initiated dataset/
      catalog fetches. The `loaderConfig.test.ts` guard keeps loaders.gl workers
      off: keep it passing.
- [ ] No secrets added: skim the diff for credentials/tokens before pushing
      (the repo ships local-first, with no keys or backend).
- [ ] CSP: the deploy ships an ENFORCING `Content-Security-Policy` (`.htaccess`
      and `_headers`): `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'
      'unsafe-inline'`, `connect-src 'self' https:`. Confirm the headers are at the
      deploy-zip root and the console stays clean on a real deploy.

## 4. Package + verify the artifact

- [ ] `npm run package` produces the deploy + source zips with web-safe modes
      (644 files / 755 dirs) and passes its own integrity check.
- [ ] Spot-check the deploy zip: `index.html`, `assets/`, `.htaccess`, `_headers`
      at the archive root.

## 5. Release asset set (attach all to the prerelease)

Every asset must be produced from the exact final tagged commit, and the
staged set must contain all of:

- [ ] source ZIP (`openlidarviewer-v<X.Y.Z>-source-<timestamp>.zip`)
- [ ] deploy ZIP (`openlidarviewer-v<X.Y.Z>-deploy-root-<timestamp>.zip`)
- [ ] `sbom.json`
- [ ] release manifest (`release-manifest-v<X.Y.Z>.json`)
- [ ] `SHA256SUMS`
- [ ] `gate.log`
- [ ] `gate.log.sha256`
- [ ] `test-evidence.json`
- [ ] `RELEASE_NOTES_v<X.Y.Z>.md`

Assertions before publishing:

- [ ] `test-evidence.json` records the same commit as the tag.
- [ ] The `gate.log` hash recorded in evidence/manifest matches the attached log
      (`shasum -a 256 -c gate.log.sha256`).
- [ ] The SBOM root version equals `package.json` `version`.
- [ ] Source and deploy ZIP checksums verify against `SHA256SUMS`.
- [ ] The source archive may exclude generated `release/` output, but the GitHub
      prerelease attaches the evidence files (`sbom.json`, manifest,
      `test-evidence.json`, `gate.log`, `gate.log.sha256`, `SHA256SUMS`)
      separately.
- [ ] No pre-release working notes or private readiness files are published
      (`*READINESS*` files and private notes stay out of the repository).

## 6. Tag + push

- [ ] Commit, tag `v<X.Y.Z>`, push branch + tag, publish the release notes.

The tag push starts both the CI workflow and the release workflow at the same
commit. The release workflow's gate installs Chromium only, so its `ci-at-tag`
job (`scripts/check-ci-for-sha.mjs`) reads the CI runs for the tagged commit
through the GitHub API and waits for them. `release-ready` needs it: a CI run
that is missing after 15 minutes, still pending after 120 minutes, or has
`ci-green` or any job `ci-green` needs cancelled, skipped or failed keeps the
release not ready, and the draft release is not created. Publishing the draft
stays a manual step.
