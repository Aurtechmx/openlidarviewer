import { describe, expect, it } from 'vitest';
import { parseSession, serializeSession } from '../src/io/session';
import type { ColorMode } from '../src/render/colorModes';

const modes: ColorMode[] = ['density', 'gpsTime', 'returnNumber', 'coverage', 'confidence'];
const camera = { position: [0, 0, 10], target: [0, 0, 0] } as const;
const clip = { enabled: true, mode: 'keep-inside' as const, box: { min: [1, 1, 1], max: [2, 2, 2] } };

describe('inspection recipes preserve the displayed attribute', () => {
  it.each(modes)('keeps %s in the live state and named clipped view', (mode) => {
    const session = parseSession(serializeSession({
      upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', colorMode: mode,
      views: [{ name: 'Area', camera: { position: [...camera.position], target: [...camera.target] }, colorMode: mode,
        clip: { ...clip, box: { min: [1, 1, 1], max: [2, 2, 2] } } }], measurements: [], annotations: [],
    }));
    expect(session.colorMode).toBe(mode);
    expect(session.views[0]).toMatchObject({ colorMode: mode, clip });
  });
});
