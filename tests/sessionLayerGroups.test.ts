/**
 * sessionLayerGroups.test.ts
 *
 * `layerGroups` is additive WITHIN schema v8 and carries no version bump, on
 * the same terms as `annotation.issue`: it adds one optional field, changes the
 * meaning of none, and is emitted only when a group exists. These tests pin
 * both halves of that claim — a session with no groups keeps the byte-shape it
 * had before the field existed, and a v8 (or older) file that never heard of
 * groups still parses, unchanged, into a session with none.
 *
 * The rest pins what the sanitiser refuses. A `.olvsession` is untrusted input,
 * so a malformed group is dropped rather than thrown, a repeated group id keeps
 * its first occurrence (two groups sharing an id would merge on import), and
 * membership stays EXCLUSIVE across the whole list the way `LayerGroupStore`
 * enforces it — otherwise a hand-edited file could produce two groups issuing
 * contradicting visibility plans for one layer.
 */

import { describe, it, expect } from 'vitest';
import { serializeSession, parseSession, SESSION_VERSION } from '../src/io/session';
import type { InspectionSession, SessionLayerGroup } from '../src/io/session';
import type { Vec3 } from '../src/render/measure/types';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

function baseSession(): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  return {
    upAxis: 'z',
    origin: p(0, 0, 0),
    unitSystem: 'metric',
    views: [],
    measurements: [],
    annotations: [],
  };
}

/** Parse a hand-built document, bypassing the writer's own sanitiser. */
function parseRaw(layerGroups: unknown): InspectionSession {
  return parseSession(
    JSON.stringify({
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 8,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      layerGroups,
    }),
  );
}

describe('session layerGroups — additive within v8', () => {
  it('does not bump the schema version', () => {
    const json = serializeSession({
      ...baseSession(),
      layerGroups: [{ id: 'g1', name: 'Flight 1', memberIds: ['layer-a'] }],
    });
    expect(JSON.parse(json).version).toBe(8);
    expect(SESSION_VERSION).toBe(8);
  });

  it('keeps the no-groups byte-shape exactly', () => {
    const without = serializeSession(baseSession());
    const empty = serializeSession({ ...baseSession(), layerGroups: [] });
    expect(empty).toBe(without);
    expect(without).not.toContain('layerGroups');
  });

  it('leaves a session that predates the field untouched', () => {
    const parsed = parseRaw(undefined);
    expect(parsed.layerGroups).toBeUndefined();
    expect(parsed.version).toBe(SESSION_VERSION);
    // Re-writing it must not invent a field the source never had.
    expect(serializeSession({ ...baseSession(), layerGroups: parsed.layerGroups })).not.toContain(
      'layerGroups',
    );
  });

  it('round-trips names, membership and the collapsed flag', () => {
    const groups: SessionLayerGroup[] = [
      { id: 'g1', name: 'Flight 1', memberIds: ['layer-a', 'layer-b'], collapsed: true },
      { id: 'g2', name: 'Flight 2', memberIds: [] },
    ];
    const parsed = parseSession(serializeSession({ ...baseSession(), layerGroups: groups }));
    expect(parsed.layerGroups).toEqual(groups);
  });

  it('omits the collapsed key for an expanded group', () => {
    const json = serializeSession({
      ...baseSession(),
      layerGroups: [{ id: 'g1', name: 'Flight 1', memberIds: [] }],
    });
    expect(JSON.parse(json).layerGroups[0]).toEqual({ id: 'g1', name: 'Flight 1', memberIds: [] });
  });

  it('writes an empty group, because it is still a container the user made', () => {
    const parsed = parseSession(
      serializeSession({ ...baseSession(), layerGroups: [{ id: 'g', name: 'Empty', memberIds: [] }] }),
    );
    expect(parsed.layerGroups).toEqual([{ id: 'g', name: 'Empty', memberIds: [] }]);
  });
});

describe('session layerGroups — untrusted input', () => {
  it('drops a non-array field instead of throwing', () => {
    expect(parseRaw('flight-1').layerGroups).toBeUndefined();
    expect(parseRaw({ id: 'g' }).layerGroups).toBeUndefined();
  });

  it('drops an entry with no id or a blank name', () => {
    const parsed = parseRaw([
      { name: 'No id', memberIds: [] },
      { id: 'g2', name: '   ', memberIds: [] },
      { id: 'g3', name: 'Kept', memberIds: [] },
      'not an object',
    ]);
    expect(parsed.layerGroups).toEqual([{ id: 'g3', name: 'Kept', memberIds: [] }]);
  });

  it('trims a name and keeps duplicates apart by id', () => {
    const parsed = parseRaw([
      { id: 'g1', name: '  Flight 2  ', memberIds: [] },
      { id: 'g2', name: 'Flight 2', memberIds: [] },
    ]);
    expect(parsed.layerGroups?.map((g) => g.name)).toEqual(['Flight 2', 'Flight 2']);
    expect(parsed.layerGroups?.map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  it('keeps the first of two groups sharing one id', () => {
    const parsed = parseRaw([
      { id: 'g1', name: 'First', memberIds: ['layer-a'] },
      { id: 'g1', name: 'Second', memberIds: ['layer-b'] },
    ]);
    expect(parsed.layerGroups).toEqual([{ id: 'g1', name: 'First', memberIds: ['layer-a'] }]);
  });

  it('holds membership exclusive across the whole list', () => {
    const parsed = parseRaw([
      { id: 'g1', name: 'First', memberIds: ['layer-a', 'layer-b'] },
      { id: 'g2', name: 'Second', memberIds: ['layer-b', 'layer-c'] },
    ]);
    expect(parsed.layerGroups?.map((g) => g.memberIds)).toEqual([
      ['layer-a', 'layer-b'],
      ['layer-c'],
    ]);
  });

  it('drops malformed member ids and a malformed member list', () => {
    const parsed = parseRaw([
      { id: 'g1', name: 'First', memberIds: ['layer-a', '', 7, null, 'layer-a'] },
      { id: 'g2', name: 'Second', memberIds: 'layer-b' },
    ]);
    expect(parsed.layerGroups).toEqual([
      { id: 'g1', name: 'First', memberIds: ['layer-a'] },
      { id: 'g2', name: 'Second', memberIds: [] },
    ]);
  });

  it('refuses to write an arrangement it would drop on the way back in', () => {
    const json = serializeSession({
      ...baseSession(),
      layerGroups: [
        { id: 'g1', name: 'First', memberIds: ['layer-a'] },
        { id: 'g1', name: 'Clash', memberIds: ['layer-a'] },
        { id: 'g3', name: '  ', memberIds: [] },
      ],
    });
    expect(JSON.parse(json).layerGroups).toEqual([
      { id: 'g1', name: 'First', memberIds: ['layer-a'] },
    ]);
  });
});
