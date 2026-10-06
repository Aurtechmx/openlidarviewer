import { describe, it, expect } from 'vitest';
import { parseWorkplaneSettings, WORKPLANE_DEFAULTS, type WorkplaneSettings } from '../src/model/workplaneSettings';
import { parseSession, serializeSession, type InspectionSession } from '../src/io/session';

const session = (extra: Partial<InspectionSession> = {}): Omit<InspectionSession, 'app' | 'kind' | 'version'> => ({
  upAxis: 'z',
  origin: [500000, 4100000, 1000],
  unitSystem: 'metric',
  views: [],
  measurements: [],
  annotations: [],
  ...extra,
});

const placed: WorkplaneSettings = {
  enabled: true,
  orientation: 'three-point',
  originH: [500010.25, 4100020.5],
  elevation: 1234.567,
  elevationSource: 'plane',
  fixedSpacing: 2.5,
  points: [
    [500010.25, 4100020.5, 1234.567],
    [500050, 4100020.5, 1238],
    [500010.25, 4100060, 1232],
  ],
};

describe('reference plane settings in the session file', () => {
  it('round-trips exactly', () => {
    const back = parseSession(serializeSession(session({ referencePlane: placed })));
    expect(back.referencePlane).toEqual(placed);
  });

  it('a session that never used the plane keeps its byte-shape', () => {
    const json = serializeSession(session());
    expect(JSON.parse(json)).not.toHaveProperty('referencePlane');
    expect(parseSession(json).referencePlane).toBeUndefined();
  });

  it('a damaged block falls back field by field, and never throws the import', () => {
    const doc = JSON.parse(serializeSession(session())) as Record<string, unknown>;
    doc.referencePlane = { enabled: 'yes', orientation: 'sideways', originH: [1, 'x'], elevation: '__HUGE__', fixedSpacing: -3, points: 'none' };
    // 1e999 is not representable: JSON.parse reads it as Infinity, which the
    // parser must refuse. Written raw, since JSON.stringify would emit null.
    const raw = JSON.stringify(doc).replace('"__HUGE__"', '1e999');
    expect(raw).toContain('"elevation":1e999');
    const back = parseSession(raw);
    expect(back.referencePlane).toEqual(WORKPLANE_DEFAULTS);
    doc.referencePlane = 42;
    expect(parseSession(JSON.stringify(doc)).referencePlane).toBeUndefined();
  });
});

describe('parseWorkplaneSettings', () => {
  it('is off by default', () => {
    expect(WORKPLANE_DEFAULTS.enabled).toBe(false);
    expect(parseWorkplaneSettings({})).toEqual(WORKPLANE_DEFAULTS);
  });

  it('drops a three-point orientation that carries no valid points', () => {
    const s = parseWorkplaneSettings({ orientation: 'three-point', points: [[0, 0, 0], [1, 1, 1]] });
    expect(s?.orientation).toBe('horizontal');
    expect(s?.points).toBeNull();
  });

  it('never invents a ground source for an elevation', () => {
    expect(parseWorkplaneSettings({ elevation: 12, elevationSource: 'ground' })?.elevationSource).toBe('typed');
    expect(parseWorkplaneSettings({ elevationSource: 'scan-minimum' })?.elevationSource).toBeNull();
  });
});

describe('hostile values', () => {
  it('a session block that would put the lattice past exact integers is refused field by field', () => {
    const doc = JSON.parse(serializeSession(session())) as Record<string, unknown>;
    doc.referencePlane = { enabled: true, orientation: 'horizontal', originH: [1e17, 1e17], elevation: 1e17, fixedSpacing: 1e-20 };
    const back = parseSession(JSON.stringify(doc)).referencePlane!;
    expect(back.enabled).toBe(true);
    expect(back.originH).toBeNull(); // falls back to the scan centre
    expect(back.elevation).toBeNull(); // not drawn until set
    expect(back.fixedSpacing).toBe(1e-20); // in range; the controller floors it to the scan size
  });

  it('accepts values up to the bound and refuses past it', () => {
    expect(parseWorkplaneSettings({ originH: [1e9, -1e9] })?.originH).toEqual([1e9, -1e9]);
    expect(parseWorkplaneSettings({ originH: [1e9 * 1.0001, 0] })?.originH).toBeNull();
    expect(parseWorkplaneSettings({ fixedSpacing: 2e9 })?.fixedSpacing).toBeNull();
  });
});
