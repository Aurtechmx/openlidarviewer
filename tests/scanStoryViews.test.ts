/**
 * scanStoryViews.test.ts
 *
 * Structure coverage for the Dataset Story card + Export Health summary
 * renderers, via the project's recording DOM stub (same style as
 * analysePanelReportButton.test.ts). Pixels are e2e's job; here we pin that the
 * synthesised facts actually reach the rendered tree.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { buildScanStory, buildExportHealth, type ScanStoryInputs } from '../src/intelligence/scanStory';

beforeAll(installRecordingDom);

// Import AFTER the stub is installed (el() touches document at call time only).
const { renderDatasetStoryCard, renderExportHealthPanel, exportHealthHeader } = await import('../src/ui/scanStoryViews');

const GOOD: ScanStoryInputs = {
  captureLabel: 'Aerial / airborne ALS',
  pointCount: 15_700_000,
  areaM2: 1_000_000,
  surfaceTier: 'Good',
  products: [
    { label: 'Profiles', status: 'Ready' },
    { label: 'DTM/DEM export', status: 'Preview' },
  ],
  density: 'dense',
  groundVisibility: 'good',
  coverageMode: 'full',
  crsKnown: true,
  datumKnown: true,
  classification: 'source',
};

describe('renderDatasetStoryCard', () => {
  it('surfaces the headline, assessment, limiter, best-for and next step', () => {
    const node = renderDatasetStoryCard(buildScanStory(GOOD)) as unknown as RecordingEl;
    const text = node.textContent;
    expect(text).toContain('Aerial / airborne ALS');
    expect(text).toContain('Good');
    expect(text).toContain('Primary limiter');
    expect(text).toContain('Profiles');
    expect(text).toContain('→'); // next-step marker
    expect(node.allClasses()).toContain('is-good');
  });

  it('omits the caution / not-recommended rows when nothing is held back', () => {
    const allReady = buildScanStory({
      ...GOOD,
      products: [
        { label: 'Profiles', status: 'Ready' },
        { label: 'DTM/DEM export', status: 'Ready' },
      ],
    });
    const node = renderDatasetStoryCard(allReady) as unknown as RecordingEl;
    expect(node.textContent).not.toContain('Use with caution');
    expect(node.textContent).not.toContain('Not recommended');
  });

  it('shows the caution + not-recommended rows when products are held back', () => {
    const story = buildScanStory({
      ...GOOD,
      surfaceTier: 'Limited',
      products: [
        { label: 'Profiles', status: 'Ready' },
        { label: 'DTM/DEM export', status: 'Preview' },
        { label: 'Contours', status: 'Blocked' },
      ],
    });
    const text = (renderDatasetStoryCard(story) as unknown as RecordingEl).textContent;
    expect(text).toContain('Use with caution');
    expect(text).toContain('DTM/DEM export');
    expect(text).toContain('Not recommended');
    expect(text).toContain('Contours');
  });
});

describe('renderExportHealthPanel', () => {
  it('renders the verdict, every row, and no blocker list when ready', () => {
    const node = renderExportHealthPanel(buildExportHealth(GOOD)) as unknown as RecordingEl;
    const text = node.textContent;
    expect(text).toContain('Ready to export');
    expect(text).toContain('Scan scope');
    expect(text).toContain('Classification');
    expect(node.textContent).not.toContain('Review before hand-off');
    expect(node.allClasses()).toContain('is-ready');
  });

  it('renders blockers + a caution verdict for a derived, ungeoreferenced preview', () => {
    const health = buildExportHealth({
      ...GOOD,
      coverageMode: 'resident-only',
      classification: 'derived',
      classConfidence: 0.42,
      crsKnown: false,
    });
    const node = renderExportHealthPanel(health) as unknown as RecordingEl;
    const text = node.textContent;
    expect(text).toContain('Review before hand-off · 3 items');
    expect(text).not.toContain('Export with caution');
    expect(text).toContain('heuristic');
    expect(text).toContain('support 0.42');
    expect(node.allClasses()).toContain('is-caution');
  });
});

describe('export readiness tone', () => {
  const sample = { ...GOOD, coverageMode: 'display-sample' as const };

  it('a limit reads as calm review, amber, never red', () => {
    const h = buildExportHealth({ ...sample, crsKnown: false, datumKnown: false });
    expect(exportHealthHeader(h)).toEqual({ text: 'Review before hand-off · 3 items', tone: 'review' });
    expect(h.items.every((i) => !i.wrong)).toBe(true);
    const node = renderExportHealthPanel(h) as unknown as RecordingEl;
    expect(node.allClasses()).toContain('is-tone-review');
    expect(node.allClasses()).not.toContain('is-wrong');
  });

  it('a display sample names Convert at full resolution as its fix', () => {
    const h = buildExportHealth(sample);
    expect(h.blockers).toEqual(['Display sample: tick Convert at full resolution to write every point.']);
    expect(exportHealthHeader(h).text).toBe('Review before hand-off · 1 item');
    expect(h.items[0].remedy).toBe('full-resolution');
    const withFix = renderExportHealthPanel(h, { fullResolution: () => undefined }) as unknown as RecordingEl;
    expect(withFix.textContent).toContain('Use full resolution');
    const without = renderExportHealthPanel(h) as unknown as RecordingEl;
    expect(without.textContent).not.toContain('Use full resolution');
  });

  it('only a streaming source says streamed', () => {
    expect(buildExportHealth({ ...GOOD, coverageMode: 'resident-only' }).blockers[0]).toMatch(/Streamed-in/);
    expect(buildExportHealth(sample).blockers[0]).not.toMatch(/stream/i);
    expect(buildExportHealth({ ...GOOD, coverageMode: 'sampled' }).blockers[0]).not.toMatch(/stream/i);
  });

  it('a failed gate is the one red item', () => {
    const h = buildExportHealth({ ...GOOD, surfaceTier: 'Blocked', crsKnown: false });
    expect(exportHealthHeader(h).tone).toBe('wrong');
    expect(h.items.filter((i) => i.wrong).map((i) => i.text)).toEqual([
      'Surface quality gate failed: terrain products cannot be exported.',
    ]);
  });

  it('a clean scan is simply ready', () => {
    expect(exportHealthHeader(buildExportHealth(GOOD))).toEqual({ text: 'Ready to export', tone: 'ready' });
  });
});
