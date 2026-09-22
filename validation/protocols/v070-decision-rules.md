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

## Held

Release notes and the changelog for the Field Simulation Lab are held until
the release is finalized.
