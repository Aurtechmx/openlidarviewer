# Release checklist

Run through this before tagging a release. It exists because a version bump on
its own leaves siblings stale (the lockfile and README), and because two of the
hardening steps are deliberately staged and easy to forget.

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
- [ ] `npm run test:unit && npm run test:terrain && npm run test:ui && npm run test:slow`
- [ ] `npm run test:smoke`, then `npm run test:smoke:live` (boots the obfuscated artifact users actually get), and `npm run test:e2e` (need a browser/GPU; run where available)
- [ ] `npm audit --omit=dev --audit-level=high` clean

## 3. Local-first / security gates

- [ ] No new third-party origins in the shipped bundle. After `npm run build`,
      grep `dist/` for unexpected hosts (`unpkg`, `cdn`, `jsdelivr`, `googleapis`,
      `analytics`); the only outbound calls should be user-initiated dataset/
      catalog fetches. The `loaderConfig.test.ts` guard keeps loaders.gl workers
      off — keep it passing.
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

## 5. Tag + push

- [ ] Commit, tag `v<X.Y.Z>`, push branch + tag, publish the release notes.
