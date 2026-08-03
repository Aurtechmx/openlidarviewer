/**
 * LayerSpatialState.ts — the destination shape for the Float64 project frame.
 *
 * This is the ON-RAMP scaffold for roadmap item P1 #2 ("Stop writing project
 * offsets into Float32 vertices", docs/architecture/coordinate-integrity-roadmap.md)
 * and the inventory in docs/architecture/float64-frame-migration-plan.md.
 *
 * It is DELIBERATELY UNREFERENCED. Nothing in the app imports it, so the
 * runtime and the deterministic e2e are byte-identical whether it exists or
 * not. Its only consumer is its unit test. It is here so the destination shape
 * — the one every review has named — is spelled out and pinned before any of
 * the ~151 direct `.positions` readers is moved. The migration itself is one
 * atomic change (see the plan doc): a partial migration is worse than none,
 * because render would then see project space while the CPU sees source-local.
 *
 * The shape:
 *   - vertices stay SOURCE-LOCAL, exactly as the loader wrote them (Float32);
 *   - the layer's placement in the shared project frame is a Float64
 *     translation held BESIDE the buffer, never baked INTO it;
 *   - CPU work recovers a world/project-frame coordinate by applying that
 *     translation in Float64 at read time.
 *
 * The field is named `sourceLocal` rather than `positions` on purpose: it is a
 * source-local residual buffer, not an already-placed one, and the name keeps
 * the two impossible to confuse at a call site. It is also why this scaffold
 * does not add to the `lint:position-access` surface — there is no new
 * `.positions` read to hold.
 *
 * Pure: no DOM, no three.js, no imports. Fully unit-testable in Node. This
 * mirrors the pure-transform posture of src/geo/ProjectSpatialFrame.ts, which
 * already ships the frame value types; LayerSpatialState is the per-layer
 * container that binds those Float64 translations to a concrete vertex buffer.
 */

/** A mutable output tuple, reused across a hot loop to avoid per-point allocation. */
type Vec3Out = [number, number, number];
/** An immutable coordinate triple. */
type Vec3 = readonly [number, number, number];

/** Construction inputs for {@link LayerSpatialState}. */
export interface LayerSpatialStateOptions {
  /**
   * The layer's source-local vertex positions as flat x,y,z triples — exactly
   * the buffer the loader produced, never rewritten. Length must be a multiple
   * of 3.
   */
  readonly sourceLocal: Float32Array;
  /**
   * source-local → project-local, a Float64 translation. In v0.6 the layers
   * share a CRS, so this is `sourceOrigin − projectOrigin` (see
   * src/geo/ProjectSpatialFrame.ts). All three components must be finite.
   */
  readonly sourceToProject: Vec3;
}

/**
 * A layer's source-local vertices bound to the Float64 translation that places
 * them in the shared project frame.
 *
 * The buffer is held by reference and never written here — immutability of the
 * source geometry is the whole point (float64-transform.md invariant 1). The
 * translation is held as two Float64 tuples, `sourceToProject` and its exact
 * negation `projectToSource`, so a project-space result maps back to a
 * source-space index without recomputing the inverse at every call site.
 */
export class LayerSpatialState {
  /** Source-local vertex positions (flat x,y,z), immutable, as loaded. */
  readonly sourceLocal: Float32Array;
  /** source-local → project-local, Float64. */
  readonly sourceToProject: Vec3;
  /** project-local → source-local — the exact negation of {@link sourceToProject}. */
  readonly projectToSource: Vec3;

  constructor(options: LayerSpatialStateOptions) {
    const len = options.sourceLocal.length;
    if (len % 3 !== 0) {
      throw new Error(
        `LayerSpatialState: sourceLocal length ${len} is not divisible by 3 — ` +
          'vertices must be flat x,y,z triples.',
      );
    }
    const [dx, dy, dz] = options.sourceToProject;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
      throw new Error(
        `LayerSpatialState: sourceToProject [${dx}, ${dy}, ${dz}] must be finite — ` +
          'a non-finite translation would place every point at infinity.',
      );
    }
    this.sourceLocal = options.sourceLocal;
    // Copy the components so the caller's array cannot mutate the translation
    // through the reference it still holds, and derive the inverse once.
    this.sourceToProject = [dx, dy, dz];
    this.projectToSource = [-dx, -dy, -dz];
  }

  /** Number of points: three position components per point. */
  get pointCount(): number {
    return this.sourceLocal.length / 3;
  }
}

/**
 * The project-frame ("world") coordinate of point `index`: its source-local
 * position plus the Float64 `sourceToProject` translation, applied at read
 * time.
 *
 * This is THE accessor every CPU consumer moves to. Two properties make the
 * migration safe:
 *   1. With the identity translation ([0,0,0] — the single-layer case shipping
 *      today) the result is bit-identical to the raw source-local value, so
 *      moving a consumer onto it is a provable no-op in the current build.
 *   2. The translation is applied in Float64 (JS number arithmetic), so a
 *      survey-scale offset does not spend the Float32 mantissa the residual is
 *      using — unlike baking the offset into the Float32 buffer, which is the
 *      precision loss P1 #2 exists to remove.
 *
 * Pass `out` to avoid allocating a tuple per point in a hot loop.
 */
export function layerWorldPosition(
  state: LayerSpatialState,
  index: number,
  out: Vec3Out = [0, 0, 0],
): Vec3Out {
  const base = index * 3;
  if (index < 0 || base + 2 >= state.sourceLocal.length) {
    throw new RangeError(
      `layerWorldPosition: index ${index} out of range for ${state.pointCount} points`,
    );
  }
  out[0] = state.sourceLocal[base] + state.sourceToProject[0];
  out[1] = state.sourceLocal[base + 1] + state.sourceToProject[1];
  out[2] = state.sourceLocal[base + 2] + state.sourceToProject[2];
  return out;
}

/**
 * The source-local coordinate of a project-frame ("world") position: the exact
 * inverse of {@link layerWorldPosition}, applying `projectToSource` in Float64.
 *
 * This is the picking direction — a hit resolved in the shared frame maps back
 * to a layer-local coordinate without re-quantising anything. Because
 * `projectToSource` is the exact negation of `sourceToProject`, the round trip
 * source → world → source is exact for the realistic (survey-scale, typically
 * integer) translations the frame produces.
 *
 * Pass `out` to avoid allocating a tuple per call in a hot loop.
 */
export function layerSourcePosition(
  state: LayerSpatialState,
  world: Vec3,
  out: Vec3Out = [0, 0, 0],
): Vec3Out {
  out[0] = world[0] + state.projectToSource[0];
  out[1] = world[1] + state.projectToSource[1];
  out[2] = world[2] + state.projectToSource[2];
  return out;
}
