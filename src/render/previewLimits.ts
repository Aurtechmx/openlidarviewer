/**
 * previewLimits.ts: the one ceiling on a progressive preview, with no three.js
 * behind it.
 *
 * `previewCloudLayer.ts` sizes its mesh against this, and the page sends the
 * same number to the parse worker so the decode thins its hand-offs to what
 * will actually be drawn. The layer itself carries the renderer, and the page
 * shell loads it lazily, so the constant lives here where the shell can read it
 * without pulling the renderer into its chunk.
 */

/** Records a preview holds at most, whatever the file or the device budget. */
export const PREVIEW_MAX_POINTS = 2_000_000;
