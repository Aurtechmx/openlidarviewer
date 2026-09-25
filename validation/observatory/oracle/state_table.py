#!/usr/bin/env python3
"""OB-ST-01 state table, written independently of the viewer (analytic-truth).

This is a second implementation of docs/observatory/SPEC.md SS2.2-SS2.4 and of
validation/protocols/observatory/OB-ST-THRESHOLDS.protocol.json's boundary
rules, derived from those documents rather than from
src/observation/stateTable.ts. It enumerates the bounded lattice described in
state-table-lattice.json and freezes, for every row, the full input alongside
the state this implementation assigns it.

tests/observatoryStateTable.test.ts does not re-enumerate the lattice: it
reads the frozen rows this script writes and replays each one through the
TypeScript function, so the two implementations are compared on results, never
on enumeration order.

WHAT THIS IS AND IS NOT. Agreement with the TypeScript function catches a
transcription slip in either one. It is not external validation: the rules
being mirrored are this project's own SPEC, not a published external
reference, so a shared misreading of SPEC SS2.4 would survive. Registered in
validation/external-oracles/oracle-registry.json with role analytic-truth: a
closed-form value, over a bounded and fully-explicit input space.

Nothing here imports OpenLiDARViewer code and nothing here reads its output.
Standard library only.

Usage:
  state_table.py --write   regenerate the frozen expectations
  state_table.py --check   recompute and compare against them, plus a set of
                            direct invariant checks (OB-INV-01, OB-INV-02)
                            that do not depend on the lattice at all.
"""
import argparse
import json
import sys
from itertools import product
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "state-table-lattice.json"
EXPECTED = HERE.parent / "expected" / "state-table-lattice.expected.json"

STATES = (
    "SURFACE", "PARTIAL", "OBSERVED_EMPTY", "CONFLICT", "SHADOWED",
    "NO_RETURN_PATH", "UNADDRESSED", "NOT_READ", "OUTSIDE_DOMAIN",
)


def hit_fraction(hit, pas):
    n = hit + pas
    return None if n == 0 else hit / n


def is_solid_source(src, p_solid, n_min):
    n = src["hit"] + src["pass"]
    if n < n_min:
        return False
    f = hit_fraction(src["hit"], src["pass"])
    return f is not None and f >= p_solid


def is_conflict_empty_source(src, p_empty, n_min):
    n = src["hit"] + src["pass"]
    if n < n_min:
        return False
    f = hit_fraction(src["hit"], src["pass"])
    return f is not None and f <= p_empty


def is_shadowed_source(src):
    return src["addressed"] and src["behind"] > 0 and src["hit"] == 0 and src["pass"] == 0


def derive_state(sources, inside_domain, p_solid, p_empty, n_min):
    """OB-ST-01, independently of stateTable.ts. Returns (state, ruleId)."""
    if not inside_domain:
        return "OUTSIDE_DOMAIN", "OUTSIDE_DOMAIN"

    total_hit = sum(s["hit"] for s in sources)
    total_pass = sum(s["pass"] for s in sources)
    total_no_return = sum(s["noReturn"] for s in sources)
    any_not_decoded = any(s["notDecoded"] for s in sources)

    # Rule 1: NOT_READ.
    if any_not_decoded and total_hit == 0 and total_pass == 0:
        return "NOT_READ", "NOT_READ"

    # Rule 2: CONFLICT, two DISTINCT sources (OB-INV-02).
    for i, a in enumerate(sources):
        if not is_solid_source(a, p_solid, n_min):
            continue
        for j, b in enumerate(sources):
            if i == j:
                continue
            if is_conflict_empty_source(b, p_empty, n_min):
                return "CONFLICT", "CONFLICT"

    n = total_hit + total_pass
    if n > 0:
        f = total_hit / n
        # Rule 3: SURFACE.
        if f >= p_solid and n >= n_min:
            return "SURFACE", "SURFACE"
        # Rule 5: OBSERVED_EMPTY (hit == 0 exactly).
        if total_hit == 0 and total_pass >= n_min:
            return "OBSERVED_EMPTY", "OBSERVED_EMPTY"
        # Rule 4: PARTIAL, the total complement of the two above.
        return "PARTIAL", "PARTIAL"

    # total_hit == 0 and total_pass == 0 from here.

    # Rule 6: SHADOWED.
    if any(is_shadowed_source(s) for s in sources):
        return "SHADOWED", "SHADOWED"

    # Rule 7: NO_RETURN_PATH.
    if total_no_return > 0:
        return "NO_RETURN_PATH", "NO_RETURN_PATH"

    # Rule 8: UNADDRESSED, the residual default.
    return "UNADDRESSED", "UNADDRESSED"


def source_axis_product(tier, shared_pairs):
    """Every (hit, pass, behind, noReturn, addressed, notDecoded) combo one source in this tier can take, in a fixed nested order: pair, behind, noReturn, addressed, notDecoded."""
    pairs = tier.get("hitPassPairs", shared_pairs)
    return list(product(pairs, tier["behind"], tier["noReturn"], tier["addressed"], tier["notDecoded"]))


def enumerate_rows(config):
    """Every lattice row, in tier order then insideDomain order then source-tuple order (source 1 varies slowest)."""
    shared_pairs = config["sharedHitPassPairs"]
    p = config["params"]
    rows = []
    for tier in config["tiers"]:
        k = tier["sourceCount"]
        axis_combos = source_axis_product(tier, shared_pairs)
        for inside_domain in tier["insideDomain"]:
            for combo_tuple in product(axis_combos, repeat=k):
                sources = []
                for idx, ((hit, pas), behind, no_return, addressed, not_decoded) in enumerate(combo_tuple):
                    sources.append({
                        "sourceIndex": idx,
                        "hit": hit,
                        "pass": pas,
                        "behind": behind,
                        "noReturn": no_return,
                        "saturated": False,
                        "addressed": addressed,
                        "notDecoded": not_decoded,
                    })
                state, rule_id = derive_state(sources, inside_domain, p["p_solid"], p["p_empty"], p["n_min"])
                rows.append({
                    "insideDomain": inside_domain,
                    "sources": sources,
                    "expected": {"state": state, "ruleId": rule_id},
                })
    return rows


def self_check_invariants(rows, config):
    """OB-INV checks that do not depend on any particular row: run once per --check, independent of the lattice's specific coverage."""
    problems = []
    p = config["params"]

    # OB-INV-02: CONFLICT never fires for a single source.
    for row in rows:
        if len(row["sources"]) == 1 and row["expected"]["state"] == "CONFLICT":
            problems.append("OB-INV-02: a single-source row produced CONFLICT")
            break

    # OB-INV-01: no state other than OBSERVED_EMPTY may be produced by an
    # all-zero-counter, unaddressed, non-decoded voxel with no domain membership
    # issue -- i.e. UNADDRESSED/NO_RETURN_PATH/NOT_READ never equal OBSERVED_EMPTY.
    for row in rows:
        st = row["expected"]["state"]
        if st == "OBSERVED_EMPTY":
            total_hit = sum(s["hit"] for s in row["sources"])
            if total_hit != 0:
                problems.append(f"OB-INV-01: OBSERVED_EMPTY row has nonzero aggregate hit ({total_hit})")

    # Every row's state is one this table defines.
    for row in rows:
        if row["expected"]["state"] not in STATES:
            problems.append(f"row produced an undefined state: {row['expected']['state']}")

    return problems


def write_frozen(payload):
    """Write the frozen expectations to the fixed EXPECTED path inside this oracle tree."""
    target = EXPECTED.resolve()
    if not target.is_relative_to(HERE.parent.resolve()):
        raise SystemExit(f"refusing to write outside {HERE.parent}: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="regenerate the frozen expectations")
    group.add_argument("--check", action="store_true", help="recompute and compare against them")
    args = parser.parse_args()

    config = json.loads(CONFIG.read_text())
    rows = enumerate_rows(config)

    if args.write:
        write_frozen({"schemaVersion": 1, "rowCount": len(rows), "rows": rows})
        print(f"state_table.py --write: wrote {len(rows)} row(s) to {EXPECTED.relative_to(HERE.parent.parent.parent)}")
        return 0

    problems = self_check_invariants(rows, config)
    if not EXPECTED.exists():
        print("state_table.py --check: FAILED — no frozen expectations. Run --write first.", file=sys.stderr)
        return 1
    frozen = json.loads(EXPECTED.read_text())
    if frozen.get("rows") != rows:
        frozen_rows = frozen.get("rows", [])
        n = min(len(frozen_rows), len(rows))
        first_diff = next((i for i in range(n) if frozen_rows[i] != rows[i]), n)
        print(
            f"state_table.py --check: FAILED — recomputed rows differ from the frozen file "
            f"(frozen has {len(frozen_rows)}, recomputed {len(rows)}; first difference at row {first_diff}).",
            file=sys.stderr,
        )
        return 1
    if problems:
        print(f"state_table.py --check: FAILED — {len(problems)} invariant problem(s):", file=sys.stderr)
        for prob in problems:
            print(f"  - {prob}", file=sys.stderr)
        return 1

    print(f"state_table.py --check: OK — {len(rows)} row(s) match the frozen file; invariants hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
