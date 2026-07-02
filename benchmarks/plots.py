#!/usr/bin/env python3
"""
Render reliability figures for the OpenLiDARViewer evaluation from the metrics
emitted by `npm run repro` (benchmarks/out/metrics.json). Colourblind-safe
(Okabe-Ito), 300 dpi PNG + vector PDF. Pure-stdlib + matplotlib.
"""
import json
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({"font.family": "sans-serif",
                     "font.sans-serif": ["DejaVu Sans", "Arial"], "font.size": 9})
OI = {"blue": "#0072B2", "orange": "#E69F00", "green": "#009E73", "grey": "#666666"}

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
with open(os.path.join(OUT, "metrics.json")) as fh:
    M = json.load(fh)


def save(fig, name):
    fig.savefig(os.path.join(OUT, name + ".png"), dpi=300, bbox_inches="tight")
    fig.savefig(os.path.join(OUT, name + ".pdf"), bbox_inches="tight")


# --- Figure 1: registration vertical bias vs true vertical change -------------
rows = M["M1_registration_vertical_bias"]
dz = [r["dz"] for r in rows]
bh = [r["biasHorizontalM"] for r in rows]
bf = [r["biasFull3dM"] for r in rows]
fig, ax = plt.subplots(figsize=(4.2, 3.0))
ax.plot(dz, bf, "-o", color=OI["orange"], label="full-3D registration")
ax.plot(dz, bh, "-s", color=OI["blue"], label="horizontal-only (yaw + x/y)")
ax.plot(dz, dz, "--", color=OI["grey"], linewidth=1, label="y = x (change fully lost)")
ax.set_xlabel("True uniform vertical change (m)")
ax.set_ylabel("Detected-change error (m)")
ax.set_title("Registration preserves vs. absorbs vertical change")
ax.legend(frameon=False, fontsize=7.5)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
save(fig, "registration_bias")

# --- Figure 2: uncertainty-band calibration -----------------------------------
cov = M["M3_stockpile_band_coverage"]
fig2, ax2 = plt.subplots(figsize=(3.4, 3.0))
bars = ax2.bar(["nominal", "empirical"],
               [cov["nominal1sigma"], cov["empirical1sigma"]],
               color=[OI["grey"], OI["green"]], width=0.6)
ax2.axhline(cov["nominal1sigma"], color=OI["grey"], linestyle="--", linewidth=1)
ax2.set_ylim(0, 1)
ax2.set_ylabel("±1σ coverage")
ax2.set_title(f"Stockpile band calibration ({cov['trials']} trials)")
for b, v in zip(bars, [cov["nominal1sigma"], cov["empirical1sigma"]]):
    ax2.text(b.get_x() + b.get_width() / 2, v + 0.02, f"{v:.2f}", ha="center", fontsize=9)
ax2.spines["top"].set_visible(False)
ax2.spines["right"].set_visible(False)
save(fig2, "calibration")

print("wrote registration_bias.{png,pdf} + calibration.{png,pdf} to benchmarks/out/")
