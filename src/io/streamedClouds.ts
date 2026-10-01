/**
 * streamedClouds.ts: resident snapshots of a streamed scan, and the inputs a
 * terrain sample was drawn from, so an export can say which source files it
 * describes. Keyed weakly.
 */
const streamed = new WeakSet<object>();

export function markStreamedCloud(cloud: object): void {
  streamed.add(cloud);
}

export function isStreamedCloud(cloud: object): boolean {
  return streamed.has(cloud);
}

/**
 * What a terrain sample was drawn from: each static cloud's positions array
 * and whether streamed nodes joined. Keyed weakly by the sample, the core
 * computed from it and the result built from that core, so an export can name
 * its source files.
 */
export interface AnalysisInputs {
  readonly files: readonly object[];
  readonly streamed: boolean;
}

const inputs = new WeakMap<object, AnalysisInputs>();

export function recordAnalysisInputs(key: object, value: AnalysisInputs | undefined): void {
  if (value) inputs.set(key, value);
}

export function analysisInputsOf(key: object): AnalysisInputs | undefined {
  return inputs.get(key);
}
