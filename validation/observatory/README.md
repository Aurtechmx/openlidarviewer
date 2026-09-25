# Observatory: analytic fixtures and oracles

Standard-library Python oracles for `src/observation/` (`docs/observatory/SPEC.md`
OB-INT-09), registered in `validation/external-oracles/oracle-registry.json`
under the `olv-observatory-analytic-oracle` lineage, roles `analytic-truth`
and `generator-truth` only.

## Layout

| Path | Content |
| --- | --- |
| `oracle/state_table.py` | OB-ST-01's precedence rules, written independently of `src/observation/stateTable.ts`. `--write` freezes the lattice in `state-table-lattice.json` to `expected/`; `--check` recomputes, compares, and runs two direct invariant checks (OB-INV-01, OB-INV-02). |
| `oracle/ray_aabb_traversal.py` | Ray-AABB clipping and Amanatides & Woo (1987) voxel traversal in exact rational arithmetic, for F8's four DDA cases. Reads `fixtures/f8-dda-cases.json`. |
| `oracle/coverage_gain.py` | OB-GAIN-03/04 Coverage Gain terms and the greedy station pass, for F11 and F12. Reads `fixtures/f11-coverage-gain.json` (a declared classified field and three candidates), traverses planning rays with `ray_aabb_traversal.py`'s clip and traversal in exact rational arithmetic, and freezes every term to `expected/f11-coverage-gain.expected.json`. |
| `oracle/state-table-lattice.json` | The bounded lattice `state_table.py` enumerates: shared thresholds, curated (hit, pass) pairs, and the per-source-count tiers. |
| `fixtures/` | Written by `scripts/generate-observatory-fixtures.mjs --write`: `f1-wall-room.json` (F1's geometry) and `f8-dda-cases.json` (F8's four cases, on exactly representable coordinates). |
| `expected/` | Frozen oracle output: `state-table-lattice.expected.json` (7,504 rows) and `f8-dda-cases.expected.json`. |

## What agreement does and does not establish

Both oracles are written from `docs/observatory/SPEC.md` and this project's
own preregistered protocol, not from a published external reference or from
the TypeScript they are compared against. Agreement catches a transcription
slip on either side; it is not external validation, since a shared
misreading of SPEC would survive it. `state_table.py`'s lattice is bounded
and explicit (see its own header), not a claim of universal coverage beyond
what it enumerates.

The TypeScript DDA that F8's traversal will eventually be checked against
does not exist yet (`docs/observatory/SPEC.md` phase O4). Phase O1's own
TypeScript test (`tests/observatoryFixtureF8.test.ts`) checks a narrower,
prior thing: that the fixture generator's inputs and this directory's frozen
records agree with each other.

## Running the oracles

```
python3 validation/observatory/oracle/state_table.py --check
python3 validation/observatory/oracle/ray_aabb_traversal.py --check
python3 validation/observatory/oracle/coverage_gain.py --check
```

Regenerate after a deliberate change to the thresholds, the boundary rules, or
the fixtures (in that order: fixtures, then oracle `--write`):

```
node scripts/generate-observatory-fixtures.mjs --write
python3 validation/observatory/oracle/state_table.py --write
python3 validation/observatory/oracle/ray_aabb_traversal.py --write
python3 validation/observatory/oracle/coverage_gain.py --write
```

The release gate does not run either oracle: it executes no Python, and
agreement is already enforced by the TypeScript tests that read the committed
records, which need no interpreter.
