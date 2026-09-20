import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  OPEN_STAGE_LABEL,
  OPEN_STAGE_ORDER,
  mayBlockWithOverlay,
  openStage,
  respondsToInput,
  type OpenStage,
  type OpenStageFacts,
} from '../src/app/openStage';
import { REFINEMENT_PHASE_ORDER } from '../src/render/refinementPhase';

function facts(over: Partial<OpenStageFacts> = {}): OpenStageFacts {
  return {
    previewMounted: false,
    cloudAttached: false,
    streamingBusy: false,
    refinement: null,
    ...over,
  };
}

describe('the stage a load is at', () => {
  it('is opening while nothing is drawn', () => {
    expect(openStage(facts())).toBe('opening');
  });

  it('is preview while part of the file is on screen and the rest is not', () => {
    expect(openStage(facts({ previewMounted: true }))).toBe('preview');
  });

  it('is interactive the moment the whole cloud is attached', () => {
    expect(openStage(facts({ cloudAttached: true }))).toBe('interactive');
  });

  it('is refining while the streamer still has work', () => {
    expect(openStage(facts({ cloudAttached: true, streamingBusy: true }))).toBe('refining');
    expect(openStage(facts({
      cloudAttached: true, streamingBusy: true, refinement: 'full-refine',
    }))).toBe('refining');
  });

  it('is refining while the renderer has not finished refining', () => {
    for (const phase of REFINEMENT_PHASE_ORDER.filter((p) => p !== 'full-refine')) {
      expect(openStage(facts({ cloudAttached: true, refinement: phase })), phase).toBe('refining');
    }
  });

  it('is ready once the picture has stopped changing', () => {
    expect(openStage(facts({ cloudAttached: true, refinement: 'full-refine' }))).toBe('ready');
  });

  it('prefers the attached cloud over a preview still standing', () => {
    // The preview is taken down after the cloud attaches; until it is, the
    // stage should describe the better picture rather than the older one.
    expect(openStage(facts({ previewMounted: true, cloudAttached: true }))).toBe('interactive');
  });

  it('reads an unassessed refinement as not-yet-judged, never as motion', () => {
    // Null and `moving` mean different things: one is nothing assessed, the
    // other is a camera in motion. Confusing them reports a still scan as
    // refining forever.
    expect(openStage(facts({ cloudAttached: true, refinement: null }))).toBe('interactive');
    expect(openStage(facts({ cloudAttached: true, refinement: 'moving' }))).toBe('refining');
  });

  it('names a stage in the ladder for every combination of facts', () => {
    for (const previewMounted of [true, false]) {
      for (const cloudAttached of [true, false]) {
        for (const streamingBusy of [true, false]) {
          for (const refinement of [null, ...REFINEMENT_PHASE_ORDER]) {
            const stage = openStage({ previewMounted, cloudAttached, streamingBusy, refinement });
            expect(OPEN_STAGE_ORDER).toContain(stage);
          }
        }
      }
    }
  });
});

describe('what the stage permits', () => {
  it('responds to input everywhere but opening', () => {
    const responding = OPEN_STAGE_ORDER.filter(respondsToInput);
    expect(responding).toEqual(['preview', 'interactive', 'refining', 'ready']);
  });

  it('allows a blocking overlay only while nothing is drawn', () => {
    // Once there is something to look at, an overlay covering it takes away
    // the thing the viewer waited for.
    const blocking = OPEN_STAGE_ORDER.filter(mayBlockWithOverlay);
    expect(blocking).toEqual(['opening']);
  });

  it('treats a preview as a smaller picture rather than a lesser one to drive', () => {
    expect(respondsToInput('preview')).toBe(true);
    expect(mayBlockWithOverlay('preview')).toBe(false);
  });

  it('labels every stage', () => {
    for (const stage of OPEN_STAGE_ORDER) {
      expect(OPEN_STAGE_LABEL[stage as OpenStage]).toBeTruthy();
    }
  });
});

describe('what these stages must not claim', () => {
  it('says nothing about completeness or validation', () => {
    // `ready` means the picture has stopped changing. A stage name implying
    // the source is complete or a measurement sound would be the most easily
    // believed false claim in the application: it appears while somebody is
    // waiting and reads as permission to trust what they see.
    const source = readFileSync(new URL('../src/app/openStage.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/complete|valid|verified|accurate|trust/i);
    expect(code).toMatch(/export function openStage/);
  });

  it('keeps its labels free of a claim about the data', () => {
    for (const label of Object.values(OPEN_STAGE_LABEL)) {
      expect(label).not.toMatch(/complete|valid|verified|accurate/i);
    }
  });

  it('does not overlap the pipeline vocabulary', async () => {
    // Decoding is a pipeline stage and says nothing about whether a camera
    // responds. One word with two meanings is how a surface picks the wrong
    // one.
    const { loadStageLabel } = await import('../src/io/loadProgress');
    const pipeline = new Set([
      'detecting-format', 'reading-file', 'parsing-metadata',
      'decoding', 'optimizing', 'uploading', 'rendering',
    ].map((s) => loadStageLabel(s as Parameters<typeof loadStageLabel>[0])));
    for (const label of Object.values(OPEN_STAGE_LABEL)) {
      expect(pipeline.has(label), label).toBe(false);
    }
  });
});
