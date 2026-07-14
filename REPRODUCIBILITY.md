# Reproducibility

This page is the single entry point for reproducing OpenLiDARViewer's build, tests, and reported analysis figures. It stitches together the pieces that also live in `README.md`, `REVIEWER_QUICKSTART.md`, and `docs/benchmarks.md`.

## Environment

- Node.js 22 (pinned in `.nvmrc` and `package.json` `engines`; CI runs Node 22).
- Install exactly the locked dependency set with `npm ci` (uses `package-lock.json`; do not use `npm install` for a reproducible run).

```bash
nvm use            # picks up .nvmrc (Node 22)
npm ci
```

## Commands

| Purpose | Command |
| --- | --- |
| Type check | `npm run typecheck` |
| Unit + integration tests (partitioned) | `npm run test:unit && npm run test:export && npm run test:terrain && npm run test:ui && npm run test:slow` |
| Plain build + chunk-isolation contract | `npm run test:build` |
| Production (obfuscated) build | `npm run build:live` |
| Bundle budget check | `npm run check:bundle` |
| Full release gate (all of the above + lints + smoke) | `npm run test:release` |
| Regenerate analysis/benchmark figures | `npm run repro` |
| Package source + deploy archives | `npm run package` |

The authoritative gate is `npm run test:release`; `RELEASE_CHECKLIST.md` lists the same battery for a tagged release.

## Determinism

- The analysis reproduction pack (`tests/reproPack.test.ts`, run via `npm run repro`) is fully deterministic: every input is generated from a fixed seed (an LCG plus Box–Muller), so the emitted metrics under `benchmarks/out/` reproduce bit-for-bit on any machine. The report digest is content-addressed (tamper-evident).
- Test fixtures under `tests/` are synthetic and seed-generated (see `scripts/make-*.py` and `tests/fixtures/FIXTURES.md`), or explicitly licensed (see `THIRD_PARTY_NOTICES.md`).
- Build identity is reproducible: the build honours `SOURCE_DATE_EPOCH`, and when git metadata is unavailable the commit is reported as `unknown` rather than fabricated.

## Not deterministic (by nature)

- GPU/browser **performance** figures in `docs/benchmarks.md` depend on hardware, driver, and browser, and are described there as field observations, not a formal benchmark. They are not part of the reproducible metric set above.

## Expected outputs

The committed reference outputs live under `benchmarks/out/` (`metrics.{json,md}`, calibration, and registration-bias files). `npm run repro` regenerates them; a clean run reproduces the committed values.
