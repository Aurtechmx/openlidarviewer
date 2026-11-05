/**
 * The bare layouts (?embed=1, ?ui=minimal) build no workspace, so commands whose
 * surface is absent leave the palette rather than run with nowhere to show it.
 */
import { describe, expect, it } from 'vitest';
import { actionsForLayout } from '../src/ui/actionRegistry';

const ids = ['tool.measure', 'tool.annotate', 'tool.inspect', 'analyse.run', 'analyse.contours', 'analyse.flowPulse', 'analyse.terrainAccess', 'analyse.observatory', 'story.dataset', 'view.save-state'];
const actions = ids.map((id) => ({ id })) as never[];
const kept = (o: Parameters<typeof actionsForLayout>[1]) => actionsForLayout(actions, o).map((a) => (a as { id: string }).id);

describe('actionsForLayout', () => {
  it('keeps everything in the full layout', () => {
    expect(kept({ bare: false, measurements: false, annotations: false })).toEqual(ids);
  });
  it('drops commands with no surface in a bare layout', () => {
    expect(kept({ bare: true, measurements: false, annotations: false })).toEqual(['story.dataset', 'view.save-state']);
  });
  it('keeps a tool a link surfaced', () => {
    expect(kept({ bare: true, measurements: true, annotations: false })).toContain('tool.measure');
    expect(kept({ bare: true, measurements: false, annotations: true })).toContain('tool.annotate');
    expect(kept({ bare: true, measurements: true, annotations: true })).not.toContain('tool.inspect');
  });
});
