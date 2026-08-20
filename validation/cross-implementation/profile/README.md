# Section-profile cross-implementation fixtures

Point clouds and independent references for `MEAS-PROFILE`, the corridor profile
`src/render/measure/profileSampler.ts` samples along a section line.

A corridor profile is two operations: place every point on the line (chainage and
perpendicular distance in the map plane), then reduce each station's corridor to
one elevation with a type-7 quantile. The reference does neither in this
repository. Chainage and distance come from OGR's SpatiaLite functions
(`ST_Line_Locate_Point`, `ST_Distance`), and the quantile from R's
`quantile(type = 7)`, the implementation the type numbering comes from.

## Fixtures

- `profile-ramp.csv` — 257 stations at 1 m over an axis-aligned line, ten
  corridor points per station whose elevations form an exact arithmetic
  progression across the corridor, plus returns outside the corridor and beyond
  both ends that the gates must drop. The progression is what gives the type-7
  quantile a closed form: `q(p) = first + step · (p/100) · (n − 1)`, so the
  expected series is read off the surface equation rather than recomputed by a
  second copy of the reduction. Every coordinate is a multiple of 1/2048 and
  exactly representable in Float32, so both sides read identical numbers.
- `profile-scatter.csv` — an oblique line, irregular corridor populations
  including single-point and empty stations, classified vegetation, building and
  noise returns above the ground, and ground returns outside the corridor. No
  closed form applies here; this is the fixture the external reference is for.

Both are written by `scripts/make-profile-fixture.mjs`. The parameters, and why
each was chosen, are in `scripts/profile-fixture-params.mjs`.

## References

- `profile-quantile.R` — the reduction stage: R's type-7 quantile per station.
- `profile-ramp__corridor.csv`, `profile-scatter__corridor.csv` — the corridor
  tables SpatiaLite produced: one row per point that passed the corridor and
  classification gates, carrying its station and its elevation **verbatim** from
  the fixture. Nothing re-prints an elevation, so no agreement here can be an
  artefact of a shared formatter.
- `profile-ramp__profile.csv`, `profile-scatter__profile.csv` — the reference
  series: station, corridor count, and one column per percentile.

Exact commands, tool versions and resolved paths are in
`reference-runs-profile.json`, written by `scripts/run-profile-reference.mjs`.
The comparison is `tests/profileCrossCheck.test.ts`; the study record is
`validation/cross-implementation/studies/MEAS-PROFILE-OGR-R-CORRIDOR.study.json`
and the protocol it runs under is
`validation/protocols/PROTO-PROFILE-OGR-R-CORRIDOR.protocol.json`.
