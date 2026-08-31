/**
 * profileWorkbenchRawFilter.test.ts
 *
 * The raw-scatter filter wired into the section composer: a non-'all' scope
 * narrows the drawn returns to those it keeps and records the choice in the
 * detail rows, while 'all' draws every corridor return exactly as before. The
 * scope→request mapping is the small pure adapter the UI selector drives.
 */

import { describe, it, expect } from 'vitest';
import { prepareWorkbenchSection } from '../src/app/profileWorkbenchSection';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';
import { PROFILE_ATTRIBUTE_BIT } from '../src/render/measure/profileSectionBuilder';
import { rawFilterRequestForScope } from '../src/render/measure/profileRawFilter';

function recordingContext() {
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    setTransform: (): void => {},
    clearRect: (): void => {},
    fillRect: (): void => {},
    beginPath: (): void => {},
    moveTo: (): void => {},
    lineTo: (): void => {},
    stroke: (): void => {},
    fillText: (): void => {},
  };
  return ctx;
}
class FakeCanvas {
  width = 0;
  height = 0;
  readonly ctx = recordingContext();
  readonly clientWidth: number;
  readonly clientHeight: number;
  constructor(clientWidth: number, clientHeight: number) {
    this.clientWidth = clientWidth;
    this.clientHeight = clientHeight;
  }
  getContext(): ReturnType<typeof recordingContext> {
    return this.ctx;
  }
}

/** A section of `count` returns, half ground (class 2), half vegetation (class 5). */
function mixedSection(count: number): ProfileSectionResult {
  const chainage = new Float32Array(count);
  const height = new Float64Array(count);
  const classification = new Uint8Array(count);
  const channelPresence = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    chainage[i] = (i / (count - 1)) * 100;
    height[i] = 1000 + (i / (count - 1)) * 10;
    classification[i] = i % 2 === 0 ? 2 : 5;
    channelPresence[i] = PROFILE_ATTRIBUTE_BIT.classification;
  }
  return {
    points: {
      count,
      chainage,
      height,
      lateralOffset: new Float32Array(count),
      sourceSlot: new Uint16Array(count),
      pointIndex: new Uint32Array(count),
      channelPresence,
      classification,
    },
    frame: null as never,
    band: 2,
    scope: 'static' as never,
    scopeLabel: 'One loaded layer.',
    streamingComplete: null,
    sources: [],
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
  } as unknown as ProfileSectionResult;
}

const rowValue = (
  plot: ReturnType<typeof prepareWorkbenchSection>,
  label: string,
): string | undefined => plot.view.detail?.find((r) => r.label === label)?.value;

describe('rawFilterRequestForScope', () => {
  it('maps each scope to its filter kind', () => {
    expect(rawFilterRequestForScope('all')).toEqual({ filter: { kind: 'all' } });
    expect(rawFilterRequestForScope('ground')).toEqual({ filter: { kind: 'ground' } });
    expect(rawFilterRequestForScope('exclude-non-ground')).toEqual({
      filter: { kind: 'excludeNonGround' },
    });
  });
});

describe('prepareWorkbenchSection raw-scatter filter', () => {
  it('draws every return and shows no filter row for the all scope', () => {
    const plot = prepareWorkbenchSection({
      section: mixedSection(100),
      canvas: new FakeCanvas(640, 320) as never,
      unitSuffix: 'm',
      unitScale: 1,
      rawFilter: rawFilterRequestForScope('all'),
    });
    expect(rowValue(plot, 'Drawn')).toBe('100');
    expect(rowValue(plot, 'Kept (filter)')).toBeUndefined();
  });

  it('narrows the drawn returns to ground and records the choice', () => {
    const plot = prepareWorkbenchSection({
      section: mixedSection(100),
      canvas: new FakeCanvas(640, 320) as never,
      unitSuffix: 'm',
      unitScale: 1,
      rawFilter: rawFilterRequestForScope('ground'),
    });
    // Half the returns are ground; with the whole set under the draw cap, every
    // ground return draws and no vegetation does.
    expect(rowValue(plot, 'Drawn')).toBe('50');
    expect(rowValue(plot, 'Kept (filter)')).toBe('50 of 100');
    expect(rowValue(plot, 'Filter')).toMatch(/ground/i);
  });
});
