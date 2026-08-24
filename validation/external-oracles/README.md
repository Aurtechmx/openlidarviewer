# External oracles

An oracle is a program this project compares itself against. This directory
records which ones are allowed to be cited, what each is entitled to say, and
what they said.

## Why a registry

Two programs are not two independent implementations when they wrap the same
library. GDAL links PROJ, so a GDAL reprojection result and a PROJ result are
one answer reported twice. Counting them as two legs claims a corroboration
that does not exist, and nothing in a study manifest shows it: both entries
look identical.

`oracle-registry.json` gives every oracle a `lineageGroup`, and
`scripts/lint-oracle-registry.mjs` fails a record that counts two of the same
lineage as separate legs. It also fails a record naming an unregistered oracle,
and one that uses an oracle in a role the registry does not grant it, which is
what stops a format validator from being cited for numerical accuracy.

Run it with `npm run lint:oracle-registry`.

## Roles

The registry defines the roles and which oracle may play which. They are not
interchangeable. An alternative algorithm can be excellent at the same problem
and still be useless as a conformance reference, because a disagreement between
two different algorithms is expected rather than informative. Where exact truth
exists, every implementation is scored against truth and mutual agreement is
secondary: three wrong implementations can agree.

## Layout

```
oracle-registry.json     which oracles exist, their lineage, roles and limits
geodesy/                 UTM against PROJ and GeographicLib
  protocol.json          quantity, tolerance, decision rule, scope limits
  fixtures.json          the frozen input matrix
  run-oracles.mjs        oracle-generation job, writes references/
  references/            what the oracles said, committed
```

## Generation is separate from verification

`run-oracles.mjs` invokes external programs and writes `references/`. The tests
read those committed references, so ordinary CI verifies the candidate on a
machine with none of the tools installed. That split is deliberate: a developer
running unit tests should not need GRASS, and a reference that regenerated
itself on every run would not be a reference.

Regenerating is a manual step:

```bash
node validation/external-oracles/geodesy/run-oracles.mjs
```

The reference records the executable path and version output for each oracle,
and the fixture file's SHA-256. A test fails if the fixtures are edited without
regenerating, because a reference whose inputs have moved is measuring
something the repository no longer contains.

## What the geodesy leg found

OLV's `latLonToUtm` agrees with both PROJ 9.8.1 and GeographicLib 2.7 to under
1 mm across 36 fixtures spanning both hemispheres, both latitude limits, the
antimeridian, and every UTM exception zone. Zone selection matches
GeographicLib exactly on all 36, including Norway 32V and Svalbard
31X/33X/35X/37X, which are in the UTM definition rather than local convention
and which a longitude-only formula gets wrong by a whole six degrees of grid.

The two oracles agree with each other to 2.0e-9 m. That number is the reason
the candidate's residual can be attributed: it is five orders of magnitude
below the residual, so what OLV shows is OLV's own series truncation and not
disagreement between the references. The residual reaches 4.5e-4 m in easting
and 9.5e-4 m in northing, both on Svalbard fixtures, and takes both signs.

This is E4 evidence for coordinate conversion, which previously had none. It
does not touch datum transformation or vertical reference, neither of which
`latLonToUtm` performs.
