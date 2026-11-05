#!/usr/bin/env python3
"""
make-profile-paired-fixture.py: corridor points for the paired test of the
profile ground-first rule (validation/protocols/profile-ground-first-paired-v1.md).

The scene generator and the SMRF labels come from the study archive named in the
protocol; pass its src/ folder. Each scene is labelled whole, with and without
the feature, and only the points in the section's corridor are written.

    python3 scripts/make-profile-paired-fixture.py <archive>/src tests/fixtures/profile-paired
"""
import csv
import hashlib
import json
import pathlib
import sys

if len(sys.argv) != 3 or not (pathlib.Path(sys.argv[1]) / "core.py").is_file():
    sys.exit("usage: make-profile-paired-fixture.py <archive>/src <out-dir>\n"
             "<archive>/src must hold core.py from the archive the protocol names.")

import numpy as np

core_dir, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
sys.path.insert(0, core_dir)
import core  # noqa: E402  (the archive's module, found through the path above)

BACKGROUNDS = ["flat", "rampx10", "rampx30", "hill"]
SEEDS = [101, 202]
PHASES = [("0", 0.0), ("pi", float(np.pi))]
AMP, LAM = 0.6, 6.0
A, B, Y0 = 40.0, 88.0, 54.0
BAND = 0.05 * (B - A)  # the app's automatic corridor half-width

out_dir.mkdir(parents=True, exist_ok=True)
files = {}
for bg in BACKGROUNDS:
    for seed in SEEDS:
        for pname, phase in PHASES:
            x, y, z0, g = core.sample_scene(bg, phase, seed, False, amp=AMP, lam=LAM)
            _, _, z1, g1 = core.sample_scene(bg, phase, seed, True, amp=AMP, lam=LAM)
            assert np.array_equal(g, g1)
            s0, _ = core.smrf(x, y, z0)
            s1, _ = core.smrf(x, y, z1)
            keep = (x >= A - BAND) & (x <= B + BAND) & (np.abs(y - Y0) <= BAND)
            roof = np.zeros_like(g)
            for bx, by, w, h, _ in core.OBJECTS[0]:
                roof |= (x > bx) & (x < bx + w) & (y > by) & (y < by + h)
            cls = np.where(g, 2, np.where(roof, 6, 5))
            name = f"{bg}_s{seed}_p{pname}.csv"
            with (out_dir / name).open("w", newline="\n") as f:
                w = csv.writer(f, lineterminator="\n")
                w.writerow(["x", "y", "z0", "z1", "cls", "smrf0", "smrf1"])
                for i in np.flatnonzero(keep):
                    w.writerow([f"{x[i]:.4f}", f"{y[i]:.4f}", f"{z0[i]:.4f}", f"{z1[i]:.4f}", int(cls[i]), int(s0[i]), int(s1[i])])
            files[name] = {
                "background": bg, "seed": seed, "phase": phase,
                "points": int(keep.sum()),
                "groundKeptOfTrue": [round(float(s0[keep & g].mean()), 4), round(float(s1[keep & g].mean()), 4)],
                "sha256": hashlib.sha256((out_dir / name).read_bytes()).hexdigest(),
            }
            print(name, files[name]["points"], files[name]["groundKeptOfTrue"], flush=True)

(out_dir / "manifest.json").write_text(json.dumps({
    "protocol": "validation/protocols/profile-ground-first-paired-v1.md",
    "amplitude": AMP, "wavelength": LAM,
    "line": {"a": [A, Y0], "b": [B, Y0]},
    "numpy": np.__version__,
    "files": files,
}, indent=2) + "\n")
