# Project spatial frame — design

Status: **foundation landed, scene wiring deferred.** This document specifies
the shared project coordinate frame. The value types and their pure transform
math ship now, unit-tested, with no change to how the scene mounts clouds. The
live wiring (mounting every layer through the frame, Compare Studio, cross-layer
picking) is deliberately staged behind it, because it is verifiable only in the
browser and it reshapes the project schema.

## The problem

Today each cloud is mounted in **its own** local render space. A cloud picks an
integer origin `floor(min)` over its own points and subtracts it in Float64
before narrowing to Float32 (see [coordinate-precision.md](../coordinate-precision.md)).
That is correct for a single scan — both endpoints of a measurement share one
origin — but there is no authoritative frame *above* the individual clouds.

The consequence, already noted under "Known limits" in the precision contract:
two georeferenced clouds with **different** source origins are each recentred
about their own `floor(min)`, so both land near local zero and appear overlaid
even when they occupy different places in the world. Their true source origins
are recorded per cloud, but the scene has no single frame that all layers are
expressed in. That gap touches every multi-layer surface: Compare Studio,
cross-layer measurement, shared clipping, project cameras, cross-layer picking,
change detection, multi-layer derived products, and project reopening.

## The model

Two value types. One describes the project's authoritative frame; the other
describes how a single layer maps into it.

```ts
interface ProjectSpatialFrame {
  /** The project's authoritative origin, in source CRS units (Float64). */
  projectOrigin: [number, number, number];
  /** The project CRS, when the layers agree on one. */
  crs?: string;
  horizontalUnit: LinearUnit;
  verticalUnit: LinearUnit;
}

interface LayerSpatialTransform {
  /** The layer's own source origin (its floor(min)), Float64. */
  sourceOrigin: [number, number, number];
  /** source-local → project-local. Pure translation today; a full matrix
   *  reserves room for rotation/scale when reprojection lands. */
  sourceToProject: Matrix4Like;
  /** The exact inverse, so a project-space pick maps back to source space. */
  projectToSource: Matrix4Like;
}
```

### Precision contract

The frame does **not** change where Float64 ends and Float32 begins — it makes
the boundary project-wide instead of per-cloud:

- **GPU** receives small Float32 **project-local** coordinates: `source_world −
  projectOrigin`, narrowed once, exactly as a single cloud is narrowed today —
  but every layer shares one `projectOrigin`, so they land in their true
  relative positions.
- **CPU / measurement / export** keep Float64 source and project transforms.
  Absolute coordinates are recovered as `projectLocal + projectOrigin` in
  Float64, the same rule `pointInfo.ts` already follows for a single cloud.

`projectOrigin` is chosen as a `floor(min)` over the union of loaded layers (or
pinned when a project is created), so the residuals every layer feeds the GPU
stay inside Float32's sub-mm range for realistic project extents — the invariant
the precision audit already pins for one cloud, now held across the set.

### Same-frame today, reprojection later

`sourceToProject` is a 4×4 so the seam is stable, but v0.6 populates it as a
**pure translation** `source_world − projectOrigin` and requires the layers to
already share a CRS (the equal-CRS case the viewer supports today). Mixed-CRS
reprojection — rotating/scaling one CRS into another — is out of scope here and
stays the domain of a downstream tool (PDAL/GDAL/proj4); the matrix simply
reserves the room so adding it later doesn't reshape the type.

## Migration from per-cloud origins

The model is a superset of today's behaviour, so the transition is non-breaking:

- A single loaded cloud is the degenerate case: `projectOrigin = sourceOrigin`,
  `sourceToProject = identity`. Its render output is byte-for-byte what it is
  today.
- The first georeferenced layer seeds `projectOrigin`. Each subsequent layer's
  `sourceToProject` is the translation `sourceOrigin − projectOrigin`, so it
  renders at its true offset from the first.
- Existing sessions/annotations stay valid: a stored `localPosition` is a
  scan-space anchor against its layer's `sourceOrigin`, and the session
  source-identity guard (see `matchSessionToScan`) already checks a session is
  being restored onto its own scan before any rebase.

## What lands now vs. what is staged

**Now (foundation, Node-verified):**
- `ProjectSpatialFrame` / `LayerSpatialTransform` value types.
- Pure Float64 transform math: build a layer transform from a project origin and
  a source origin, map source-local ↔ project-local, and recover absolute
  world coordinates — with a unit test pinning the round-trip and the sub-mm
  residual bound.

**Staged (design-gated, browser-verified) — not in this build:**
- Mounting every layer through its `LayerSpatialTransform` at the scene graph.
- Compare Studio, shared clipping, project cameras, and cross-layer picking
  reading the project frame instead of per-cloud origins.
- Persisting the frame in the project/session schema.

Each staged step changes what the user sees and must be validated in the
browser, the same way the streaming dissolve and flicker work is — so it is
called out here as ready-to-wire against a tested foundation, not folded blindly
into a release build.

## Wiring plan (v0.6.0-alpha.2)

Ordered so each step is independently verifiable and the single-layer path stays
byte-identical throughout. Node-gated steps land with a unit test; browser steps
ship behind the existing "experimental" disclosure until confirmed on a
two-scan fixture, and only then does the `KNOWN_LIMITATIONS` entry flip from
"foundation, not an active system" to active.

1. **Frame ownership in `AppContext`** (Node-gated). The composition root from
   alpha.1 (`AppRuntime`/`AppContext`) holds a `ProjectSpatialFrame | null`.
   Null is the single-cloud degenerate case. The first georeferenced layer seeds
   it via `chooseProjectOrigin` over the layers' `sourceOrigin`s; adding or
   removing a layer recomputes it. Pure state, no scene change. Gate: a reducer
   test for seed / recompute / clear.

2. **Per-layer transform at mount** (browser-verified). Each layer applies its
   `LayerSpatialTransform.sourceToProject` (a translation today) to its
   scene-graph group instead of sitting at its own local zero. A single layer
   resolves to `projectOrigin = sourceOrigin` → identity → byte-identical, held
   by a degenerate-case no-op test. Verify: two georeferenced scans with
   different source origins render at their true relative offset instead of
   overlaid at zero.

3. **Camera framing reads the frame** (browser-verified, math Node-gated).
   `frame all` / reset fits the union project bounds in project-local, so it
   frames the whole project rather than one layer. Gate the bounds-union math;
   verify the framing visually.

4. **Cross-layer measurement and picking** (math Node-gated, visual browser).
   A pick resolves to a project-local point; two endpoints on different layers
   share `projectOrigin`, so the distance between them is correct, and the
   coordinate readout recovers absolute as `projectLocal + projectOrigin`. Gate:
   a measurement test with two layers at different origins asserting the true
   distance; verify a cross-layer measurement in the browser.

5. **Shared clipping and Compare Studio** (browser-verified). The clip box and
   Compare operate in project-local, so they apply consistently across layers.

6. **Persist the frame** (Node-gated, schema bump). Store `projectOrigin` and
   each layer's `sourceOrigin` in the session/project schema (v8) so reopening
   restores the same frame; the `matchSessionToScan` source-identity guard
   already validates each layer before rebase. Gate: a v7→v8 round-trip and a
   migration test (a v7 single-layer session opens as the degenerate frame).

**Mixed-CRS safety.** A layer whose CRS disagrees with the frame's CRS is not
reprojected (still out of scope). It mounts in its own frame and is flagged,
rather than silently mislocated — the documented no-reprojection limitation,
made explicit at the seam. Because the frame carries the authoritative up-axis
and units, this step also removes the mixed-format multi-cloud divergence where
the colorbar and inspector read elevation off different axes.
