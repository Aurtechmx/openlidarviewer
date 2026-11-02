/**
 * terrainClipScopeNote.test.ts
 *
 * With a clip box active, a three-point scan kept one point for drawing,
 * picking and point export, while terrain analysis read all three. Nothing on
 * the Terrain page said so. The page now states that the run does not use the
 * clip, for as long as one is active; the gather is checked to still ignore the
 * clip, so the note cannot outlive what it describes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({ ns: true });
});

describe('the Terrain page with a clip box active', () => {
  it('states that the run reads every loaded point, only while the clip is on', async () => {
    const { AnalysePanel, CLIP_SCOPE_NOTE } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const note = (panel.element as unknown as FakeEl).findByClass('olv-analyse-clip-scope')[0]!;
    expect(note.textContent).toBe(CLIP_SCOPE_NOTE);
    // The gather reads loaded points, which a reduced load, a stream or the
    // gather's cap can make a sample; the note must not promise the whole file.
    expect(CLIP_SCOPE_NOTE).not.toMatch(/whole scan|whole file|every point/);
    expect(panel.clipScopeNoteShown()).toBe(false);
    panel.setClipScopeNote(true);
    expect(panel.clipScopeNoteShown()).toBe(true);
    panel.setClipScopeNote(true);
    expect(panel.clipScopeNoteShown()).toBe(true);
    panel.setClipScopeNote(false);
    expect(panel.clipScopeNoteShown()).toBe(false);
  });

  it('describes a gather that does not read the clip', () => {
    const viewer = readFileSync(join(import.meta.dirname, '..', 'src', 'render', 'Viewer.ts'), 'utf8');
    const start = viewer.indexOf('  gatherTerrainPositions(');
    expect(start).toBeGreaterThan(-1);
    const body = viewer.slice(start, viewer.indexOf('\n  }\n', start));
    expect(body).not.toMatch(/_clip\b|clipKeepsPoint/);
  });

  it('follows the clip panel, which reports every on/off change, restore and scan close', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/clipPanel\.subscribe\(\s*\(\)\s*=>\s*analysePanel\?\.setClipScopeNote\(clipPanel\.enabled\)\s*\)/);
    expect(main).toMatch(/analysePanel\.setClipScopeNote\(clipPanel\.enabled\)/);
  });
});
