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
- `profile-caps.csv` — a 33-station section carrying thirteen probes past each
  end: five inside the cap, six in the region where a distance-to-segment
  corridor and a rectangle with square ends disagree (cross-line offset within
  the band, chainage no further past the end than the band, more than the band
  from the endpoint), and two outside on either rule. The six carry an elevation
  40 m below the ground, so admitting one moves the station's p25 by tens of
  metres. This fixture is SUPPLEMENTARY: it is not part of the
  MEAS-PROFILE-OGR-R-CORRIDOR study, whose two fixtures place their
  beyond-the-end returns far enough out that both rules reject them, which that
  study records in its own `scope.unsupported`.
- `profile-endcap.csv` holds eight probes, one per decisive case of the
  corridor's shape at the ends, all at one elevation because the measurement
  here is membership rather than height. `profile-caps.csv` answers the shape
  question through the p25 of two stations and holds every probe at least
  0.125 m clear of the cap boundary; this fixture answers it point by point and
  puts two probes EXACTLY on a threshold, one on the start cap and one on the
  lateral band. The band is 2.5 m so that 1.5² + 2² = 6.25 = 2.5² lands the cap
  probe on the boundary with no rounding on either side. The seven cases are
  tabulated below. This fixture is SUPPLEMENTARY: it belongs to no study and
  promotes nothing.
- `profile-scatter.csv` — an oblique line, irregular corridor populations
  including single-point and empty stations, classified vegetation, building and
  noise returns above the ground, and ground returns outside the corridor. No
  closed form applies here; this is the fixture the external reference is for.

All four are written by `scripts/make-profile-fixture.mjs`. The parameters, and why
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
- `profile-caps__corridor.csv`, `profile-caps__profile.csv` — the same two
  stages over the end-cap fixture.
- `profile-endcap__membership.csv` holds one row per probe, carrying SpatiaLite's
  `ST_Distance` to the section segment at the precision ogrinfo printed it, the
  `ST_Distance <= band` verdict, an `ST_Intersects` verdict against an explicit
  square-ended POLYGON, and whether the distance came back exactly equal to the
  band. The distance is what the reference contributes; the comparison is
  reported next to it rather than in place of it.

Exact commands, tool versions and resolved paths are in
`reference-runs-profile.json`, written by `scripts/run-profile-reference.mjs`.
The end-cap run records to `reference-runs-profile-caps.json` instead, because
`reference-runs-profile.json` is an artifact of the study record below and is
listed there with its sha256; a third run folded into it would change a file
that record is checked against. The membership run records to a third file,
`reference-runs-profile-endcap.json`, written by
`scripts/run-profile-endcap-reference.mjs`, for the same reason.

## The seven end-cap cases

`sampleProfile` admits a point when its distance to the FINITE segment is within
the band, so the corridor is a capsule: a rectangle between the endpoints closed
by a half-disc of radius `band` at each end. The eight probes in
`profile-endcap.csv` are the cases that pin that shape down, on a 32 m section
with a 2.5 m band.

| Case | Probe | Position | In the corridor |
| --- | --- | --- | --- |
| 1 | `c1-start-cap-inside` | (−1, 0.5) | yes, 1.118 m from the start endpoint |
| 2 | `c2-start-cap-boundary` | (−1.5, 2) | yes, exactly 2.5 m from the start endpoint |
| 3 | `c3-square-corner` | (−2.5, 2.5) | no, 3.536 m from the segment |
| 4 | `c4-start-cap-outside` | (−1.5, 2.03125) | no, 2.525 m from the start endpoint |
| 5 | `c5a-end-cap-inside`, `c5b-end-cap-outside` | (33, −0.5), (33.5, −2.03125) | yes, then no; cases 1 and 4 mirrored to the end cap |
| 6 | `c6-body-inside` | (16, 2.46875) | yes, 2.469 m from the line |
| 7 | `c7-body-boundary` | (16, 2.5) | yes, exactly 2.5 m from the line |

Case 3 is the discriminating one. All eight probes lie inside a corridor with
square ends, which the reference states for itself in the `rect` column, so no
agreement anywhere in this set can be coming from the rectangle rule. The square
corner sits at exactly the band on both axes, which a square-ended corridor
admits on both, and 2.5·√2 = 3.536 m from the segment, which the capsule
rejects. It is also 1.036 m clear of the capsule's own boundary, so its verdict
reports which shape the implementation has rather than how it rounds. Cases 4
and 5b say what the rejection is measured from: each sits at a cross-line offset
of 2.03125 m and a chainage 1.5 m past its end, both comfortably inside the
square-ended rule, and each is rejected because its distance to the ENDPOINT is
2.525 m. With cases 1, 2 and 5a admitted, that fixes the end of the corridor as
a circle centred on the endpoint and not any straight cut.

Cases 2 and 7 are the tie. Both sit exactly on a threshold, so each
implementation's verdict is decided by whether its comparison is inclusive.
`sampleProfile` rejects on `nearSq > bandSq`, a strict comparison of squared
distance against squared band, so equality is admitted. The reference query is
`ST_Distance(...) <= band`, so equality is admitted there too. Neither side is
relying on a value that landed just inside: `ST_Distance` returns the band
itself, which the `onBoundary` column records, and moving either probe one
Float32 ulp outward flips the sampler to reject, which
`tests/profileEndcapMembership.test.ts` runs.

The comparison is `tests/profileCrossCheck.test.ts`, with the end caps in
`tests/profileCapsCrossCheck.test.ts` and the seven membership cases in
`tests/profileEndcapMembership.test.ts`; the study record is
`validation/cross-implementation/studies/MEAS-PROFILE-OGR-R-CORRIDOR.study.json`
and the protocol it runs under is
`validation/protocols/PROTO-PROFILE-OGR-R-CORRIDOR.protocol.json`.
