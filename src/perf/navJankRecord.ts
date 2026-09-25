/**
 * Navigation jank run record: built from probe summaries plus the run
 * environment, in the shape of validation/performance/nav-jank.schema.json.
 *
 * Also carries a small JSON Schema validator covering the keywords that schema
 * uses (type, enum, required, properties, additionalProperties, items,
 * minItems, minimum, exclusiveMinimum, minLength, pattern), so the browser
 * runner and the tests check a record the same way without a dependency.
 */
import type { NavProbeSummary } from './navProbe';

export interface NavJankEnv {
  commit: string;
  browser: string;
  os: string;
  /** Backend and renderer string, e.g. "webgpu / ANGLE (Apple M2)". */
  renderer: string;
  dpr: number;
  refreshEstimateHz: number;
  datasetSha256: string;
  trajectoryDigest: string;
  flags: string[];
  cache: 'cold' | 'warm';
}

export interface NavJankRun { name: string; summary: NavProbeSummary }

export interface NavJankRecord {
  schemaVersion: 2;
  env: NavJankEnv;
  runs: NavJankRun[];
  summary: {
    runs: number;
    frames: number;
    medianFrameP95Ms: number;
    medianFrameP99Ms: number;
    worstFrameP99Ms: number;
    jankEvents: number;
    jankBursts: number;
    worstStarvationMs: number;
    medianInputToDrawP95Ms: number;
    longTasks: number;
    medianActiveFrameP95Ms: number;
    medianActiveFrameP99Ms: number;
    worstActiveStarvationMs: number;
    postInputEdlFlaps: number;
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Build a record from one or more named probe summaries and the environment. */
export function buildNavJankRecord(env: NavJankEnv, runs: readonly NavJankRun[]): NavJankRecord {
  if (runs.length === 0) throw new Error('a nav jank record needs at least one run');
  const s = runs.map((r) => r.summary);
  return {
    schemaVersion: 2,
    env: { ...env, flags: [...env.flags] },
    runs: runs.map((r) => ({ name: r.name, summary: r.summary })),
    summary: {
      runs: runs.length,
      frames: s.reduce((a, x) => a + x.frames, 0),
      medianFrameP95Ms: median(s.map((x) => x.frameMs.p95)),
      medianFrameP99Ms: median(s.map((x) => x.frameMs.p99)),
      worstFrameP99Ms: Math.max(...s.map((x) => x.frameMs.p99)),
      jankEvents: s.reduce((a, x) => a + x.jank.events, 0),
      jankBursts: s.reduce((a, x) => a + x.jank.bursts, 0),
      worstStarvationMs: Math.max(...s.map((x) => x.longestStarvationMs)),
      medianInputToDrawP95Ms: median(s.map((x) => x.inputToDrawMs.p95)),
      longTasks: s.reduce((a, x) => a + x.longTasks.count, 0),
      medianActiveFrameP95Ms: median(s.map((x) => x.active.frameMs.p95)),
      medianActiveFrameP99Ms: median(s.map((x) => x.active.frameMs.p99)),
      worstActiveStarvationMs: Math.max(...s.map((x) => x.active.longestStarvationMs)),
      postInputEdlFlaps: s.reduce((a, x) => a + x.settle.postInputEdlFlaps, 0),
    },
  };
}

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  pattern?: string;
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Validate `value` against `schema`; returns one message per violation (empty = valid). */
export function validateJsonSchema(schema: unknown, value: unknown, path = '$'): string[] {
  const s = schema as Schema;
  const errors: string[] = [];
  const t = typeOf(value);
  if (s.type !== undefined) {
    const allowed = Array.isArray(s.type) ? s.type : [s.type];
    const ok = allowed.some((a) => a === t || (a === 'number' && t === 'integer'));
    if (!ok) return [`${path}: expected ${allowed.join('|')}, got ${t}`];
  }
  if (t === 'number' && !Number.isFinite(value as number)) errors.push(`${path}: not finite`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below ${s.minimum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errors.push(`${path}: not above ${s.exclusiveMinimum}`);
  }
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) errors.push(`${path}: does not match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (s.items) value.forEach((v, i) => errors.push(...validateJsonSchema(s.items, v, `${path}[${i}]`)));
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in obj)) errors.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = s.properties?.[k];
      if (sub) errors.push(...validateJsonSchema(sub, v, `${path}.${k}`));
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected ${k}`);
    }
  }
  return errors;
}
