# Reviewer quickstart

Everything below runs offline on commodity hardware. No accounts, no data upload,
no external datasets.

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

- `benchmarks/out/metrics.md` — the evaluation table (also in the paper)
- `benchmarks/out/metrics.json` — the raw numbers
- `benchmarks/out/registration_bias.{png,pdf}` — vertical-change preservation
- `benchmarks/out/calibration.{png,pdf}` — uncertainty-band coverage

The figure step needs Python + matplotlib (`pip install matplotlib`); the metrics
table is written even without it.

What the metrics show:

- **M1** — a full-3D rigid registration absorbs a true uniform vertical change
  into its z-shift (detected-change error grows with the change), while the
  horizontal-only constraint preserves it (≈ 0 error). This is the change-detection
  design choice, measured.
- **M2** — planar alignment recovers a known horizontal misregistration.
- **M3** — the reported stockpile ±1σ band is calibrated: empirical coverage sits
  near the nominal 0.68 over hundreds of noise realisations.
- **M4** — the integrity-report digest is deterministic and tamper-evident.

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
git checkout v0.6.0
nvm use && npm ci
npm run gate
```

If you downloaded the release assets, check the set itself — this rebuilds
nothing:

```bash
npm run release:verify -- --dir <downloaded-assets>
```
