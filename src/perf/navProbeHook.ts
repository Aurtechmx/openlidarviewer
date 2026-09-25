/**
 * The seam between the render loop and the navigation frame probe.
 *
 * The probe itself lives in a lazy chunk (`navProbe.ts`) that loads only under
 * `?benchmark=nav`. The render path imports this module instead: with no sink
 * installed every call below is a null check and nothing else, so a normal
 * session pays one branch per hook.
 */

/** Hot sections a long task can be attributed to. */
export type NavSpanName = 'olv:upload' | 'olv:stream' | 'olv:edl' | 'olv:cull';

/** Upload pass fields the probe reads (a structural subset of `UploadProcessResult`). */
export interface NavUploadSample {
  readonly uploaded: number;
  readonly uploadedBytes: number;
  readonly stoppedBy: 'drained' | 'time' | 'bytes' | 'nodes';
}

/** What the render loop reports into. Implemented by `NavProbe`. */
export interface NavProbeSink {
  now(): number;
  /** Clock delta of the frame, in ms, as the viewer's frame recorder accepted it. */
  frameMs(ms: number): void;
  frameBegin(t: number): void;
  upload(sample: NavUploadSample | null | undefined, ms: number): void;
  lodChange(added: number, removed: number): void;
  span(name: NavSpanName, start: number, end: number): void;
  frameEnd(t: number, drawn: boolean, edl: boolean, dpr: number, phase: string): void;
}

/** The installed sink, or null when no probe is recording. */
export let navSink: NavProbeSink | null = null;

export function setNavSink(sink: NavProbeSink | null): void {
  navSink = sink;
}

/** Feed one accepted frame time to the streaming benchmark and the probe. */
export function feedFrameMs(bench: { recordFrameMs(ms: number): void } | null | undefined, ms: number): void {
  bench?.recordFrameMs(ms);
  navSink?.frameMs(ms);
}
