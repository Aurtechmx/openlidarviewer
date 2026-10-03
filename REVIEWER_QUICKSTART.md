# Reviewer quickstart

You need the network once, to bootstrap: `npm ci` fetches the pinned Node
dependencies, and the optional figure step installs matplotlib. After that, the
tests and the evaluation run offline on commodity hardware. You need no account
and no external dataset, and you upload no data.

## 1. Install and test (~2 min)

```bash
npm ci
npm test          # unit + integration suite (deterministic, pure cores)
```

## 2. Reproduce the evaluation (~30 s)

```bash
npm run repro
```

This runs the real analysis cores over deterministic synthetic fixtures with
analytic ground truth and writes:

- `benchmarks/out/metrics.md`: the evaluation table
- `benchmarks/out/metrics.json`: the raw numbers
- `benchmarks/out/registration_bias.{png,pdf}`: vertical-change preservation
- `benchmarks/out/calibration.{png,pdf}`: uncertainty-band coverage

The metrics and the figures are separable, so a missing Python environment never
fails the numbers:

- `npm run repro:metrics`: the evaluation table + JSON. JavaScript only, no Python.
- `npm run repro:figures`: the PNG/PDF figures. Needs Python 3.11 + matplotlib:
  `pip install -r requirements-repro.txt`. It exits with that instruction if
  matplotlib is absent, and never touches the numbers.
- `npm run repro` runs both in order.

The figures visualise the metrics; the scientific values are the JSON from the
metrics step.

The four metrics measure the following.

- M1: a full-3D rigid registration absorbs a true uniform vertical change
  into its z-shift (detected-change error grows with the change), while the
  horizontal-only constraint preserves it (≈ 0 error). M1 measures the effect of
  the horizontal-only design choice in change detection.
- M2: planar alignment recovers a known horizontal misregistration.
- M3: over seeded noise realisations the reported stockpile ±1σ band reaches
  empirical coverage near its nominal 0.68. The coverage is measured against a
  known synthetic noise model; M3 does not calibrate against field data.
- M4: the integrity-report digest is deterministic and tamper-evident.

## 3. Run the application (~1 min)

```bash
npm run build && npm run preview
# open the printed URL, drag in a LAS/LAZ/PLY/E57 scan (or pick a sample),
# place a measurement, export the "Integrity report (JSON)", then run
# the command palette action "Verify integrity report…" on that file.
```

Everything happens on your machine; no data leaves the browser.

## Verifying a published release

```bash
git checkout v0.7.0-alpha.1
nvm use && npm ci
OLV_GATE_MODE=release npm run gate
```

That is the mode the published figures come from. Plain `npm run gate` is the
development default: it runs the static gate only, so it is quicker but does not
reproduce coverage or the e2e counts. Either way, read the verdict from the
`GATE EXIT:` line.

If you downloaded the release assets, check the set itself. This command
rebuilds nothing:

```bash
npm run release:verify -- --dir <downloaded-assets>
```
