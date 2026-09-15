/**
 * analysePanelReportButton.test.ts
 *
 * v0.5.9 architecture: the contour / DEM / map / report export buttons no longer
 * live in the always-visible AnalysePanel flow. They are built as DETACHED
 * backing actions and surfaced through the Contour Studio workspace (mounted
 * lazily after analysis), which dispatches to them. This test locks that move:
 * the raw export buttons must NOT appear in the static panel tree, and the panel
 * must lead with the Terrain Products surface instead. Runs in the node
 * environment via a small recording DOM stub.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';

beforeAll(installRecordingDom);

describe('AnalysePanel — export area (Contour Studio architecture)', () => {
  it('does not mount the raw contour / DEM / map / report export buttons in the panel tree', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const root = panel.element as unknown as RecordingEl;
    // These moved out of the always-visible flow: the panel builds them only as
    // detached backing actions the Contour Studio workspace dispatches to, so
    // none must appear in the static panel tree.
    expect(root.findByText('Intelligence report (PDF)')).toHaveLength(0);
    expect(root.findByText('DEM (ZIP)')).toHaveLength(0);
    expect(root.findByText('Export Contours')).toHaveLength(0);
    expect(root.findByText('GEOJSON')).toHaveLength(0);
  });

  it('leads the results with the Terrain Products surface (launcher + gated deliverable)', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const root = panel.element as unknown as RecordingEl;
    // The Contour Studio launcher slot + gated deliverable container exist even
    // before analysis (the workspace mounts into them lazily on a result).
    expect(root.hasClass('olv-analyse-products')).toBe(true);
    expect(root.hasClass('olv-analyse-contour-launcher')).toBe(true);
    expect(root.hasClass('olv-analyse-contour-deliverable')).toBe(true);
  });
});
