# v0.7 decision rules, fixed before the evidence

Three v0.7 decisions wait on measurements that have not been read yet. The
rules below decide each one. They are recorded before the evidence exists so
that the evidence cannot shape the rule. A rule that changes after this commit
records the change and the reason in this file.

## D1. Observatory station sidecar (OB-INT-02)

The sidecar is additive: a new field on `CloudMetadata`, with every existing
field unchanged, including the first-block `scannerOrigin` of PTX.

Approved when all of the following hold in the O0 report:

1. A single-station load produces the same `PointCloud` fields and bytes as
   before, and the sidecar is absent or empty for it.
2. The storage choice follows the contiguity finding:
   - If each E57 scan and each PTX block stays one contiguous record range
     through sanitation, the sidecar stores `[start, end)` ranges and costs
     nothing per point.
   - If any step between decode and `PointCloud` reorders or interleaves
     records, the sidecar stores a `Uint16` station index per record, only
     for sources with more than one station, and the memory cost at 10 and
     50 million points is reported before the change.
3. Station poses are stored in Float64, as declared by the file, and no pose
   is inferred.

Refused, and returned for a different design, when a single-station load
would change, or when a per-record index would be allocated for sources with
one station.

## D2. Stockpile canonical estimator (L05)

Candidates: the point-sample cut and fill integration (`volumeCutFill`) and
the area-weighted grid (`stockpileAreaGrid`).

Primary outcome: the median absolute relative error against the analytic
volume, over every analytic case in the measurement (shapes, densities,
uniform and clustered sampling), counting only the cases where the grid
reports `MEASURED`.

Secondary outcomes: the worst-case relative error for each estimator, and
how many cases the grid withholds.

Decision:

1. The area grid becomes the canonical stored figure when its primary
   outcome is lower than the cut and fill one, and its worst case on uniform
   sampling is no more than 1.5 times the cut and fill worst case there.
2. When the grid withholds (coverage below its threshold), the stored record
   says the figure is withheld. It does not fall back to the cut and fill
   number under the grid's name.
3. Otherwise the cut and fill integration stays canonical, and the toast
   labels the grid figure as a cross-check.
4. Either outcome moves an exported value or its label, so the switch lands
   as a method version change with the unit handling and coverage verdict
   that L05 names, and the stored records keep their `id@version` tag.

No threshold in this rule is adjusted after the measurement is read.

## D3. Real-device cloud for iOS

Sign-up is recommended to the maintainer only when all of the following are
confirmed from the vendor's own documentation:

1. Free access for a public open source repository.
2. Real iPhones running Safari, not simulators.
3. Two-finger touch through W3C WebDriver actions in mobile Safari.
4. WebGL available on those devices.
5. A way to reach a preview build: a tunnel, or a public preview URL.

It is also required that neither of the other two routes already verifies
iOS gestures: replaying traces recorded on iOS, or a hosted runner image and
iOS runtime that renders WebGL without the Metal crash.

Creating the account and adding secrets is done by the maintainer.

## D4. Percentile convention in contourGeometryProduct (audit analysis-F1)

Recorded before the consumer trace and the measurement were read.
`contourGeometryProduct.ts` computes `p95DisplacementSource` by nearest rank;
`terrain/quantile.ts` and the other percentiles in the application use type 7.

1. If the value is used as a bound or an acceptance guarantee (a tolerance a
   generalized contour must meet, or a statement that 95 per cent of
   displacements are at most the value), nearest rank stays. It returns an
   observed displacement and covers at least 95 per cent at every n, where
   type 7 interpolates and covers 80 per cent at n = 5. The function then
   documents why it differs from the canonical quantile.
2. Otherwise, if the value decides nothing a user, export, persisted record,
   digest or claim can see, it moves to the canonical type 7 through
   `terrain/quantile.ts`.
3. If it is not a bound but does reach one of those outputs, it moves to
   type 7 as a recorded method version change, with the value before and
   after on the repository's own fixtures.

## D5. Double-precision PLY and PCD (audit io-F1)

Recorded before the measurements were read. Two parts, decided separately.

1. Precision. Double-typed coordinates are decoded as Float64 if the
   measured world-coordinate error on the current path exceeds 1e-6 m for
   coordinates at projected-CRS magnitudes (easting near 500 km, northing
   near 4,000 km), and if float-typed files load byte-identically after the
   change. Otherwise the documented limitation stays. PCD waits for the
   Observatory branch that owns `loadPcd.ts` to merge.
2. Memory ceiling. A per-format transient-memory ceiling like E57's is added
   only if a measured peak for an ASCII body is at least 1.5 times the file
   size on pure-ASCII content. Otherwise no file that loads today is newly
   refused, and only the overstated cost in the code comments is corrected.

## Held

Release notes and the changelog for the Field Simulation Lab are held until
the release is finalized.

## Amendment 1 to D2, recorded after the measurement was read

D2 names the primary outcome as the median absolute relative error but not
how the error of one case is formed from its seeded runs. The two readings
give opposite answers, and this amendment was written after both were seen.

- Per run: the absolute error of each run, averaged within a case, then the
  median over cases. On the 21 cases where every run is MEASURED, cut and
  fill reads 6.71% and the grid 1.44%; with MEASURED runs from 24 cases,
  7.57% and 1.82%; pooled over the 327 MEASURED runs, 10.27% and 2.46%.
- Per case mean: the absolute value of the mean signed error, which lets
  errors of opposite sign cancel across seeds. On the same 21 cases, cut and
  fill reads 0.90% and the grid 1.40%.

D2 applies the per run reading. A saved record holds one run's figure, so
its error is one run's error; a user cannot average seeds. The per case
mean measures estimator bias, which is reported beside it, not substituted
for it. Both readings pass the uniform worst case guard: 18.3% for the grid
against 31.9% for cut and fill.

Outcome under D2 clause 1: the area grid becomes the canonical stored figure
for the lasso record. The conclusion depends on the per run reading, and
this amendment says so rather than presenting it as settled in advance.

## Amendment 2 to D1, recorded after O2 was built

D1's approval condition 1 asks that the sidecar be absent or empty for a
single-station load. O2 records a one-entry sidecar when a file declares one
station: a single PTX block, a single E57 scan, or an organized PCD file with a
VIEWPOINT line. Sources with no declared station leave it absent: LAS, LAZ,
unorganized PCD, and organized PCD without a VIEWPOINT.

The clause conflicts with what the rest of D1 protects. Before O2, an E57
scan's declared pose was applied to the points and then discarded: structured
or not, nothing on the loaded cloud kept it. PTX blocks and organized PCD keep
a pose on their organized frame. An absent sidecar would leave a single-scan
E57 with no station pose, so the ray builder (OB-RAY-02) and the per-station
rejection test (OB-LED-02) could not run on it, and both would need a
per-format fallback for one station beside the sidecar for several.

Condition 1 now reads: a single-station load keeps every existing
`PointCloud` field and byte, allocates nothing per record, and may carry a
one-entry sidecar holding the station's declared pose. The refusal clause is
unchanged, and neither of its triggers fires: the existing fields are
byte-identical against the pinned single-block and single-scan fixtures, and
no per-record index exists for any source.

This amendment was written after the implementation and its review had been
read. It changes a pre-registered condition, and says so here rather than
reading the original wording as having meant this.

## Outcome of D3

D3's second requirement is not met, so sign-up is not recommended. Both
other routes verify iOS gestures:

- Trace replay. Touch streams recorded by XCUITest on the iOS Simulator
  (iPhone 17e, iOS 26.4) cover six of seven gesture families. Replayed into
  the full application, they drive the camera on Chromium and WebKit. The
  seventh, double tap, is refused because WebDriverAgent synthesizes
  overlapping contacts.
- A hosted runner that does not crash. On `macos-26-intel` with iOS 26.5
  (iPhone 17e), `scripts/ios-touch-check.mjs` passed all 13 of its
  assertions in mobile Safari, including a two-finger pinch dispatched by
  iOS, in run 35823332517. That is one run. The iOS leg stays advisory until
  it has passed 20 consecutive runs, as recorded against L13.

Neither route exercises a physical device's digitizer, which stays
unverified.
