# E57 ↔ LAS cross-format fidelity

OLV decodes E57 and LAS through wholly independent paths: E57 reads IEEE-754
float columns out of a CompressedVector section; LAS reads scaled-integer point
records. When the same scan is exported to both formats, the two paths must
reconstruct the same world-space geometry. This leg checks that invariant.

## What runs where

- `tests/e57LasCrossFormat.test.ts` — the committed, CI-runnable guard. It reads
  the project's own `synthetic-normals.e57` fixture through the E57 path, writes
  the same six points to LAS with the real LAS writer, reads them back through
  the LAS path, and asserts the two agree within the LAS quantisation scale.
  Committed fixture; runs in CI on every change.
- `tests/e57LasFidelityExternal.test.ts` — the real-data leg. It runs only when
  `OLV_E57_FIDELITY_DIR` points at a directory of paired `<stem>.e57` /
  `<stem>.las` exports, decoding each pair and comparing point count, bounds, and
  centroid. The raw files are public, CC BY 4.0, and registered as
  `OLV-DS-051` to `054` (Zenodo 10.5281/zenodo.11518223). They run to 1.3 GB
  each, so they are not vendored and CI skips this leg; the synthetic guard
  covers the same invariant at fixture scale.

## Why this is not circular

The two readers share no decode code. E57 reconstructs positions from float
columns and an origin-subtracted local frame; LAS reconstructs them from
`scale · int + offset`, floored-min origin. Agreement means both independently
recover the same coordinates from different on-disk encodings of one scan — it
would catch an axis swap, a unit or scale error, or an origin-handling drift in
either path.

## Real-data result

Two paired scanner exports, decoded by OLV's own readers headless:

| Scan (role) | Points | Δ count | Δ centroid | Δ bounds |
|---|---|---|---|---|
| bare-earth terrain scan (no colour) | 14,328,664 | 0 | < 1 mm | ≤ 1 mm |
| urban colour scan (RGB) | 37,274,709 | 0 | < 1 mm | ≤ 1 mm |

Both pairs reconstruct the identical valid-point population, with bounds and
centroid agreeing to within the LAS 1 mm quantisation scale (0.001 m) — the only
lossy step in the round trip. Colour, where present, decodes on both sides.

### Source provenance

The raw files are not redistributed. The exact inputs behind the numbers above,
by role and SHA-256:

```
bare-earth terrain scan  e57  3c95bae9279fda6be03d662f948c140def1e56ab5bcb77233f1d2e1952b05389
bare-earth terrain scan  las  8f15870ee7b6062fa383f9b8b9187fe9c250456427f20c7cbe867df815221fa0
urban colour scan        e57  83af8dda4c54f9f2b8ce5ccbd5991ff450875364b7a6ae5157950fa6c5beac56
urban colour scan        las  70234ee10bd2bb4efdb1d335d6feb271d347dbefca6b736d41a4f463ce4ba556
```

## Reproducing

```
OLV_E57_FIDELITY_DIR=/path/to/paired/exports \
  NODE_OPTIONS=--max-old-space-size=8192 \
  npx vitest run tests/e57LasFidelityExternal.test.ts --no-file-parallelism
```
