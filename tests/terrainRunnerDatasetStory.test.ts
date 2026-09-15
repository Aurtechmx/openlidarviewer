/**
 * terrainRunnerDatasetStory.test.ts
 *
 * The runner mounts the Dataset Story on the Analyse panel as soon as a scan
 * gathers, and again once the result lands, because the analysis is itself one
 * of the story's inputs. It reduces the host's canonical inputs with
 * `buildScanStory` and never derives a fitness of its own. A host that wires no
 * input builder gets the runner it had before: no story, and no failed call.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { terrainRunnerHarness } from './helpers/terrainRunnerHarness';
import type { ScanStoryInputs } from '../src/intelligence/scanStory';

beforeAll(installRecordingDom);

const INPUTS: ScanStoryInputs = {
  captureLabel: 'Aerial / airborne ALS',
  pointCount: 15_700_000,
  areaM2: 1_000_000,
  surfaceTier: 'Good',
  products: [{ label: 'Profiles', status: 'Ready' }],
  density: 'dense',
  groundVisibility: 'good',
  coverageMode: 'full',
  crsKnown: true,
  datumKnown: true,
  classification: 'source',
};

describe('the runner mounts the Dataset Story on the panel', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('renders the card from the host inputs when a scan gathers, and again on the result', async () => {
    const h = terrainRunnerHarness({ buildStoryInputs: () => INPUTS });
    await h.runner.run();
    expect(h.stories.length).toBeGreaterThanOrEqual(2);
    const card = h.stories[0] as RecordingEl;
    expect(card.textContent).toContain('Aerial / airborne ALS');
  });

  it('a host that wires no builder gets no story and no failure', async () => {
    const h = terrainRunnerHarness();
    await h.runner.run();
    expect(h.stories).toHaveLength(0);
  });

  it('a failing input builder costs the analysis nothing', async () => {
    const h = terrainRunnerHarness({
      buildStoryInputs: () => { throw new Error('no facts yet'); },
    });
    await expect(h.runner.run()).resolves.toBeUndefined();
    expect(h.stories).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});
