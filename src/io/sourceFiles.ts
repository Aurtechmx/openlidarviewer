/**
 * sourceFiles.ts: the original File behind each loaded static cloud, so an
 * export can hash the source bytes on demand. Keyed weakly by the cloud, so a
 * closed scan releases its File. Streamed snapshots are marked in
 * `streamedClouds.ts`.
 */
const files = new WeakMap<object, File>();

/** `positions`, when given, identifies the cloud inside a terrain sample. */
export function rememberCloudFile(cloud: object, file: File, positions?: object): void {
  files.set(cloud, file);
  if (positions) files.set(positions, file);
}

export function cloudFileOf(cloud: object): File | undefined {
  return files.get(cloud);
}

/** Files whose whole-file digest has settled, so an export will not wait for it. */
const settledDigests = new WeakSet<File>();

/** Record that `file`'s digest has settled (computed or given up). */
export function markSourceDigestSettled(file: File): void {
  settledDigests.add(file);
}

/** True when an export of `cloud` would not wait for a source-file hash. */
export function sourceDigestReady(cloud: object | null | undefined): boolean {
  const file = cloud ? files.get(cloud) : undefined;
  return !file || settledDigests.has(file);
}
