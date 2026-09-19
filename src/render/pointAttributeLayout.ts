/**
 * pointAttributeLayout.ts — what a rendered point actually costs on the GPU.
 *
 * The render-memory estimate was a single constant covering an instanced
 * position and an instanced colour, 24 bytes. The mesh builder uploads more
 * than that: a classified cloud also carries `aClass`, and one with intensity
 * carries `aIntensity`. Both are uploaded as Float32 per point, so a cloud with
 * either was reported at three quarters of what it used, and a cloud with both
 * at three quarters exactly.
 *
 * A fixed number cannot follow a layout that varies per cloud. This describes
 * the layout instead, so the estimate is derived from the attributes actually
 * uploaded rather than from a figure someone has to remember to update.
 *
 * These are the bytes the renderer uploads, which is the question the memory
 * readout answers. They are deliberately NOT the bytes the source carries: a
 * colour is one byte per channel in the file and four in the buffer, and the
 * gap between those two is the subject of attribute packing rather than of
 * this module.
 */

/** One uploaded vertex attribute. */
export interface PointAttributeSpec {
  /** The name the geometry binds it under. */
  readonly name: string;
  /** Components per point. */
  readonly components: number;
  /** Bytes per component as uploaded. */
  readonly bytesPerComponent: number;
  /** Why it is present, for the readout that prints the breakdown. */
  readonly note: string;
}

/** Bytes one point costs for this attribute. */
export const attributeBytesPerPoint = (a: PointAttributeSpec): number =>
  a.components * a.bytesPerComponent;

/** The instanced position every point mesh uploads. */
export const POSITION_ATTRIBUTE: PointAttributeSpec = {
  name: 'aPos',
  components: 3,
  bytesPerComponent: 4,
  note: 'instanced position, Float32 relative to the render origin',
};

/** The instanced colour every point mesh uploads. */
export const COLOR_ATTRIBUTE: PointAttributeSpec = {
  name: 'aColor',
  components: 3,
  bytesPerComponent: 4,
  note: 'instanced colour, Float32 expanded from the source byte triple',
};

/** Present when the cloud carries a classification channel. */
export const CLASS_ATTRIBUTE: PointAttributeSpec = {
  name: 'aClass',
  components: 1,
  bytesPerComponent: 4,
  note: 'classification code, Float32 expanded from a source byte',
};

/** Present when the cloud carries intensity. */
export const INTENSITY_ATTRIBUTE: PointAttributeSpec = {
  name: 'aIntensity',
  components: 1,
  bytesPerComponent: 4,
  note: 'intensity, Float32 expanded from a source 16-bit value',
};

/** Which optional channels a cloud uploads. */
export interface UploadedAttributes {
  readonly classification: boolean;
  readonly intensity: boolean;
}

/** The attributes a cloud uploads, in upload order. */
export function pointAttributeLayout(present: UploadedAttributes): PointAttributeSpec[] {
  const layout = [POSITION_ATTRIBUTE, COLOR_ATTRIBUTE];
  if (present.classification) layout.push(CLASS_ATTRIBUTE);
  if (present.intensity) layout.push(INTENSITY_ATTRIBUTE);
  return layout;
}

/** Bytes one point costs under this layout. */
export function bytesPerPoint(present: UploadedAttributes): number {
  return pointAttributeLayout(present).reduce((n, a) => n + attributeBytesPerPoint(a), 0);
}

/** GPU attribute bytes for a point count under this layout. */
export function gpuAttributeBytes(pointCount: number, present: UploadedAttributes): number {
  return Math.max(0, Math.trunc(pointCount)) * bytesPerPoint(present);
}

/** A per-attribute breakdown, for a readout that shows where the bytes went. */
export function attributeBreakdown(
  pointCount: number,
  present: UploadedAttributes,
): ReadonlyArray<{ name: string; bytes: number; note: string }> {
  const n = Math.max(0, Math.trunc(pointCount));
  return pointAttributeLayout(present).map((a) => ({
    name: a.name,
    bytes: n * attributeBytesPerPoint(a),
    note: a.note,
  }));
}
