/**
 * heavyLasHarness.ts: the heavy LAS fakes as the preview-first and the
 * sample-fallback tests use them.
 *
 * A LAS spread over a wide XY grid, so a stratified sample across file order is
 * a spread across the footprint, a File whose whole-file read is observable, and
 * deps whose viewer records every attached source in order.
 */
import { lasBytes as gridLas, makeDeps as baseDeps, spyFile as baseFile } from './heavyLasFakes';

export function lasBytes(n: number): ArrayBuffer {
  return gridLas(n, 1000);
}

export function spyFile(name: string, size: number) {
  const file = baseFile(name, size);
  return { file, arrayBuffer: file.arrayBuffer };
}

export function makeDeps() {
  const { deps, viewer } = baseDeps();
  const attached: unknown[] = [];
  viewer.attachStreamingCloud.mockImplementation((source: unknown) => {
    attached.push(source);
    return Promise.resolve();
  });
  return {
    deps,
    viewer,
    attached,
    attachStreamingCloud: viewer.attachStreamingCloud,
    detachStreamingCloud: viewer.detachStreamingCloud,
  };
}
