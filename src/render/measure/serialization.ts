/**
 * serialization.ts
 *
 * The measurement-session file format — a single JSON document carrying both
 * saved camera views and placed measurements, so a working session can be
 * exported to a file and imported again later. Pure — unit-tested in Node.
 *
 * `CameraPose` is imported as a type only, so this module pulls in no
 * three.js at runtime and stays Node-testable.
 */

import type { CameraPose } from '../NavController';
import type { Measurement, MeasurementKind, UnitSystem, Vec3 } from './types';
import { MIN_POINTS } from './types';

/** Current session-file schema version. */
export const SESSION_VERSION = 1;

/** A serialised OpenLiDARViewer measurement session. */
export interface MeasurementSession {
  app: 'OpenLiDARViewer';
  kind: 'measurement-session';
  version: number;
  /** Vertical axis of the scan the measurements were taken in. */
  upAxis: 'y' | 'z';
  /** The cloud origin, so local coordinates can be made absolute on import. */
  origin: Vec3;
  /** Unit system that was active at export time. */
  unitSystem: UnitSystem;
  /** Saved camera viewpoints. */
  views: CameraPose[];
  /** Placed measurements (vertices in local coordinates). */
  measurements: Measurement[];
}

const KINDS: readonly MeasurementKind[] = [
  'distance',
  'polyline',
  'area',
  'height',
  'angle',
  'slope',
];

/** Serialise a session to a pretty-printed JSON string. */
export function serializeSession(
  session: Omit<MeasurementSession, 'app' | 'kind' | 'version'>,
): string {
  const doc: MeasurementSession = {
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: SESSION_VERSION,
    upAxis: session.upAxis,
    origin: session.origin,
    unitSystem: session.unitSystem,
    views: session.views,
    measurements: session.measurements,
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse and validate a session JSON string. Throws an `Error` with a clear,
 * user-facing message on anything structurally wrong; individual malformed
 * measurements are dropped rather than failing the whole import.
 */
export function parseSession(text: string): MeasurementSession {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isRecord(raw)) {
    throw new Error('Session file is empty or malformed.');
  }
  if (raw.app !== 'OpenLiDARViewer' || raw.kind !== 'measurement-session') {
    throw new Error('This file is not an OpenLiDARViewer measurement session.');
  }
  if (raw.version !== SESSION_VERSION) {
    throw new Error(`Unsupported session version: ${String(raw.version)}.`);
  }
  return {
    app: 'OpenLiDARViewer',
    kind: 'measurement-session',
    version: SESSION_VERSION,
    upAxis: raw.upAxis === 'z' ? 'z' : 'y',
    origin: parseVec3(raw.origin),
    unitSystem: raw.unitSystem === 'imperial' ? 'imperial' : 'metric',
    views: parseViews(raw.views),
    measurements: parseMeasurements(raw.measurements),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isVec3(p: unknown): p is Vec3 {
  return (
    Array.isArray(p) &&
    p.length === 3 &&
    p.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function parseVec3(v: unknown): Vec3 {
  return isVec3(v) ? [v[0], v[1], v[2]] : [0, 0, 0];
}

function parseViews(v: unknown): CameraPose[] {
  if (!Array.isArray(v)) return [];
  const out: CameraPose[] = [];
  for (const item of v) {
    if (isRecord(item)) {
      out.push({ position: parseVec3(item.position), target: parseVec3(item.target) });
    }
  }
  return out;
}

function parseMeasurements(v: unknown): Measurement[] {
  if (!Array.isArray(v)) return [];
  const out: Measurement[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const kind = item.kind;
    if (typeof kind !== 'string' || !KINDS.includes(kind as MeasurementKind)) continue;
    const k = kind as MeasurementKind;
    const points = Array.isArray(item.points)
      ? item.points.filter(isVec3).map((p): Vec3 => [p[0], p[1], p[2]])
      : [];
    if (points.length < MIN_POINTS[k]) continue;
    out.push({
      id: typeof item.id === 'string' ? item.id : freshId(),
      kind: k,
      name: typeof item.name === 'string' ? item.name : k,
      points,
      closed: item.closed === true ? true : undefined,
    });
  }
  return out;
}

/** A reasonably unique id — `crypto.randomUUID` when available, else a fallback. */
function freshId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `m_${Math.random().toString(36).slice(2, 11)}`;
}
