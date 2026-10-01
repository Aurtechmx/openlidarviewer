/**
 * sourceFiles.ts: the original File behind each loaded static cloud, so an
 * export can hash the source bytes on demand. Keyed weakly by the cloud, so a
 * closed scan releases its File. Streamed snapshots are marked in
 * `streamedClouds.ts`.
 */
const files = new WeakMap<object, File>();

export function rememberCloudFile(cloud: object, file: File): void {
  files.set(cloud, file);
}

export function cloudFileOf(cloud: object): File | undefined {
  return files.get(cloud);
}
