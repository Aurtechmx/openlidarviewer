/**
 * streamedClouds.ts: resident snapshots of a streamed scan, so an export of
 * one records that the source digest is not available. Keyed weakly.
 */
const streamed = new WeakSet<object>();

export function markStreamedCloud(cloud: object): void {
  streamed.add(cloud);
}

export function isStreamedCloud(cloud: object): boolean {
  return streamed.has(cloud);
}
