/**
 * terrainLaneKindSync.test.ts: AnalysePanel restates ExportPanel's terrain
 * lane kinds to keep its module fan-out; the two must stay the same type.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { TerrainLaneKind as PanelKind } from '../src/ui/AnalysePanel';
import type { TerrainLaneKind as ExportKind } from '../src/ui/ExportPanel';

describe('terrain lane kinds', () => {
  it('AnalysePanel and ExportPanel name the same products', () => {
    expectTypeOf<PanelKind>().toEqualTypeOf<ExportKind>();
  });
});
