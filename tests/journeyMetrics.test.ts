import { describe, it, expect } from 'vitest';
import { JourneyLog, surfaceKey, type SurfaceState } from './e2e/journeyMetrics';

const at = (mode: string, page = 'home', extra: Partial<SurfaceState> = {}): SurfaceState => ({
  mode, page, modal: '', workspace: '', palette: false, ...extra,
});

describe('journey metrics', () => {
  it('builds a stable surface key', () => {
    expect(surfaceKey(at('analyse', 'Terrain'))).toBe('analyse / Terrain');
    expect(surfaceKey(at('analyse', 'home', { modal: 'Observatory', palette: true }))).toBe('analyse / home / modal:Observatory / palette');
    expect(surfaceKey(at('', ''))).toBe('- / home');
  });

  it('counts clicks, switches, Back and Escape', () => {
    const log = new JourneyLog('J', 'desktop', at('data'), 1000);
    log.record('click', 'Tools tab', at('work'));
    log.record('click', 'Measure row', at('work', 'Measure'));
    log.record('canvas', 'first point', at('work', 'Measure'));
    log.record('canvas', 'second point', at('work', 'Measure'));
    log.record('back', 'Back', at('work'));
    log.record('escape', 'Escape', at('work'));
    log.record('type', 'a field', at('work'));
    log.succeed(1500);
    log.succeed(9999);
    const r = log.result();
    expect(r.clicks).toBe(5);
    expect(r.surfaceSwitches).toBe(3);
    expect(r.backPresses).toBe(1);
    expect(r.escapePresses).toBe(1);
    expect(r.fieldEntries).toBe(1);
    expect(r.revisits).toBe(1);
    expect(r.success).toBe(true);
    expect(r.timeToSuccessMs).toBe(500);
    expect(r.path).toEqual(['data / home', 'work / home', 'work / Measure', 'work / home']);
  });

  it('reports no success and no time when the signal never came', () => {
    const r = new JourneyLog('J', 'phone', at('data'), 0).result();
    expect(r.success).toBe(false);
    expect(r.timeToSuccessMs).toBeNull();
    expect(r.surfaceSwitches).toBe(0);
  });
});
