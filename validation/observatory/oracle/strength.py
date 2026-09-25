#!/usr/bin/env python3
"""OB-STR-01 observation-strength components, written independently of the
viewer (analytic-truth).

A second implementation of docs/observatory/SPEC.md §2.5's five bounded
components, derived from that prose directly rather than from
src/observation/strength.ts:

  - sources: distinct sources with hit > 0.
  - angularSpread: 1 - ||mean of unit ray directions of hitting rays||.
  - incidence: median cos(i) between hitting rays and the local surface
    normal (this oracle takes |cos i|, same as the TypeScript, since a
    covariance-fit normal has no intrinsic sign).
  - rangeFit: fraction of hits inside the declared useful range band.
  - consistency: f = hit / (hit + pass).

tests/observatoryStrength.test.ts does not re-enumerate the lattice: it
reads the frozen cases this script writes and replays each one through
computeStrengthComponents, so the two implementations are compared on
results, not on how the case list was built.

WHAT THIS IS AND IS NOT. Agreement with the TypeScript function catches a
transcription slip in either one. It is not external validation: both mirror
this project's own SPEC, so a shared misreading of SPEC §2.5 would survive
agreement between the two. Registered in
validation/external-oracles/oracle-registry.json with role analytic-truth.

Nothing here imports OpenLiDARViewer code. Standard library only.

Usage:
  strength.py --write   regenerate the frozen expectations
  strength.py --check   recompute and compare against them
"""
import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "strength-lattice.json"
EXPECTED = HERE.parent / "expected" / "strength-lattice.expected.json"


def compute_case(case):
    counters = case["counters"]
    hit, pas = counters["hit"], counters["pass"]
    n = hit + pas
    consistency = (hit / n) if n > 0 else None  # None == NaN, JSON has no NaN

    sources = sum(1 for s in case["perSource"] if s["hit"] > 0)

    samples = case["samples"]
    if not samples:
        return {
            "sources": sources,
            "angularSpread": None,
            "incidence": None,
            "rangeFit": None,
            "consistency": consistency,
        }

    sx = sy = sz = 0.0
    in_band = 0
    band = case["rangeBand"]
    normal = case["normal"]
    cosines = []
    for s in samples:
        dx, dy, dz = s["direction"]
        sx += dx
        sy += dy
        sz += dz
        r = s["range"]
        lo = band.get("minRange")
        hi = band.get("maxRange")
        if (lo is None or r >= lo) and (hi is None or r <= hi):
            in_band += 1
        if normal is not None:
            dot = dx * normal[0] + dy * normal[1] + dz * normal[2]
            cosines.append(min(1.0, max(0.0, abs(dot))))

    n_samples = len(samples)
    mean_norm = math.hypot(sx / n_samples, sy / n_samples, sz / n_samples)
    angular_spread = min(1.0, max(0.0, 1.0 - mean_norm))
    range_fit = in_band / n_samples

    if normal is None:
        incidence = None
    else:
        cosines_sorted = sorted(cosines)
        m = len(cosines_sorted)
        mid = m // 2
        incidence = cosines_sorted[mid] if m % 2 == 1 else (cosines_sorted[mid - 1] + cosines_sorted[mid]) / 2.0

    return {
        "sources": sources,
        "angularSpread": angular_spread,
        "incidence": incidence,
        "rangeFit": range_fit,
        "consistency": consistency,
    }


def compute_all(config):
    return [{"id": case["id"], "expected": compute_case(case)} for case in config["cases"]]


def approx_equal(a, b, tol=1e-9):
    if a is None or b is None:
        return a == b
    return abs(a - b) <= tol


def write_frozen(payload):
    """Write the frozen expectations to the fixed EXPECTED path inside this oracle tree."""
    target = EXPECTED.resolve()
    if not target.is_relative_to(HERE.parent.resolve()):
        raise SystemExit(f"refusing to write outside {HERE.parent}: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="regenerate the frozen expectations")
    group.add_argument("--check", action="store_true", help="recompute and compare against them")
    args = parser.parse_args()

    config = json.loads(CONFIG.read_text())
    results = compute_all(config)

    if args.write:
        write_frozen({"schemaVersion": 1, "caseCount": len(results), "results": results})
        print(f"strength.py --write: wrote {len(results)} case(s) to {EXPECTED.relative_to(HERE.parent.parent.parent)}")
        return 0

    if not EXPECTED.exists():
        print("strength.py --check: FAILED — no frozen expectations. Run --write first.", file=sys.stderr)
        return 1
    frozen = json.loads(EXPECTED.read_text())
    frozen_results = frozen.get("results", [])
    if len(frozen_results) != len(results):
        print(
            f"strength.py --check: FAILED — case count differs (frozen {len(frozen_results)}, recomputed {len(results)}).",
            file=sys.stderr,
        )
        return 1
    problems = []
    for frozen_case, recomputed in zip(frozen_results, results):
        if frozen_case["id"] != recomputed["id"]:
            problems.append(f"id mismatch: {frozen_case['id']} != {recomputed['id']}")
            continue
        for key in ("sources", "angularSpread", "incidence", "rangeFit", "consistency"):
            fv = frozen_case["expected"][key]
            rv = recomputed["expected"][key]
            if key == "sources":
                if fv != rv:
                    problems.append(f"{frozen_case['id']}.{key}: frozen {fv} != recomputed {rv}")
            elif not approx_equal(fv, rv):
                problems.append(f"{frozen_case['id']}.{key}: frozen {fv} != recomputed {rv}")
    if problems:
        print(f"strength.py --check: FAILED — {len(problems)} problem(s):", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print(f"strength.py --check: OK — {len(results)} case(s) match the frozen file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
