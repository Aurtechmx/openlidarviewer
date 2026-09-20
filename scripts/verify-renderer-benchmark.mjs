#!/usr/bin/env node
/**
 * verify-renderer-benchmark.mjs
 *
 * Validates every renderer benchmark record in validation/renderer-benchmark/
 * against manifest.schema.json, and adds the checks a schema cannot express.
 *
 * The check that matters most is the one about scenes. A benchmark of a
 * display feature is trivially favourable if the person running it chooses
 * which scenes to show, and the scenes that flatter gap closure are the flat
 * dense ones. So the corpus is the required set: a record that omits a scene
 * fails, and the difficult scenes are named in that set rather than left to
 * whoever writes the record. Vegetation, the silhouette edge, the roof ridge
 * and the near/far range are all in it.
 *
 * There is no record yet, and with none present this exits 0 while saying so.
 * The reason is that the field is not wired into the renderer rather than that
 * no GPU is reachable: the browser this project previews in does expose a
 * WebGPU adapter, which a capability probe in validation/renderer-capability
 * records. What is missing is a frame drawn through the field.
 * That is deliberate: the absence of a measurement is not a failure to
 * validate, it is the state the programme is in, and a gate that went red for
 * it would have to be disabled rather than satisfied.
 *
 * Implements the subset of JSON Schema the manifest uses, without a runtime
 * dependency, in the manner of verify-cross-implementation-study.mjs.
 *
 * Exit 0 = every record valid, or none present. Exit 1 = a record is wrong.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'validation', 'renderer-benchmark');
const SCHEMA_FILE = 'manifest.schema.json';

/**
 * Every scene a record must cover, from tests/fixtures/continuityScenes.ts.
 * Duplicated here on purpose: this script must not import a test fixture, and
 * a mismatch is caught by tests/rendererBenchmarkSchema.test.ts, which reads
 * both and compares them.
 */
const REQUIRED_SCENES = [
  'sparse flat plane',
  'two overlapping depth planes',
  'silhouette edge',
  'vertical facade',
  'thin pole',
  'vegetation',
  'roof edge',
  'mixed-density terrain',
  'near/far depth range',
  'classification boundary',
];

/**
 * Every rung a record must measure.
 *
 * The phase asks for a sizing, a closure and a full figure, so a record that
 * measured one rung and left the others out cannot answer whether the ladder
 * is worth climbing. Each scene has to appear once per rung, against its own
 * source baseline.
 */
const REQUIRED_TIERS = ['sizing', 'closure', 'full'];

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

/** The subset of JSON Schema the manifest uses. */
function validate(value, schema, path, root) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/');
    let resolved = root;
    for (const key of target) resolved = resolved?.[key];
    if (!resolved) return fail(path, `unresolvable $ref ${schema.$ref}`);
    return validate(value, resolved, path, root);
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(path, 'expected an object');
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) fail(path, `missing required property "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) fail(path, `unexpected property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(value[key], sub, `${path}.${key}`, root);
    }
    return undefined;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return fail(path, 'expected an array');
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(path, `expected at least ${schema.minItems} item(s)`);
    }
    value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, root));
    return undefined;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return fail(path, 'expected an integer');
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(path, 'expected a finite number');
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return fail(path, 'expected a string');
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(path, `expected at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      fail(path, `does not match ${schema.pattern}`);
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    fail(path, `expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    fail(path, `expected one of ${schema.enum.join(', ')}`);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    fail(path, `expected >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    fail(path, `expected <= ${schema.maximum}`);
  }
  if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) {
    fail(path, `expected > ${schema.exclusiveMinimum}`);
  }
  return undefined;
}

/** The checks the schema cannot express. */
function crossCheck(record, where) {
  const seen = new Set((record.cases ?? []).map((c) => c.scene));
  for (const scene of REQUIRED_SCENES) {
    if (!seen.has(scene)) fail(where, `no case for the required scene "${scene}"`);
  }
  for (const scene of seen) {
    if (!REQUIRED_SCENES.includes(scene)) fail(where, `unknown scene "${scene}"`);
  }
  // Each scene at each rung. A record covering every scene at one rung says
  // nothing about whether the rung above it was worth the cost.
  const measured = new Set(
    (record.cases ?? []).map((c) => `${c.scene}\u0000${c.continuity?.mode}`),
  );
  for (const scene of REQUIRED_SCENES) {
    for (const tier of REQUIRED_TIERS) {
      if (!measured.has(`${scene}\u0000${tier}`)) {
        fail(where, `no ${tier} case for the scene "${scene}"`);
      }
    }
  }
  (record.cases ?? []).forEach((c, i) => {
    const at = `${where}.cases[${i}]`;
    if (c.baseline?.mode !== 'source') {
      fail(at, 'the baseline mode must be source, or it is not a baseline');
    }
    if (c.continuity?.mode === 'source') {
      fail(at, 'the continuity mode must not be source, or the two sides are the same run');
    }
    if (c.baseline && c.baseline.edgeLeakage !== 0) {
      fail(at, 'a source render reconstructs nothing, so its edge leakage is 0');
    }
    if (c.baseline && c.baseline.reconstructedCoverage !== 0) {
      fail(at, 'a source render reconstructs nothing, so its reconstructed share is 0');
    }
    for (const side of ['baseline', 'continuity']) {
      const m = c[side];
      if (!m) continue;
      const parts = m.directCoverage + m.reconstructedCoverage;
      // Final coverage is what the viewer sees, and every pixel of it came
      // either from a sample or from a fill. A record where the two parts do
      // not add up to the whole is describing pixels from somewhere else.
      if (Math.abs(parts - m.finalCoverage) > 1e-6) {
        fail(`${at}.${side}`, 'direct and reconstructed shares must sum to the final coverage');
      }
    }
    if (c.continuity && c.baseline && c.continuity.finalCoverage < c.baseline.finalCoverage) {
      fail(at, 'continuity covered less than the baseline, which is not a continuity result');
    }
    if (c.verdict === 'fail' && !c.verdictReason) {
      fail(at, 'a failing case states why');
    }
  });
}

if (!existsSync(DIR)) {
  console.log('verify:renderer-benchmark OK — no record directory; nothing measured yet.');
  process.exit(0);
}

const schema = JSON.parse(readFileSync(join(DIR, SCHEMA_FILE), 'utf8'));
const records = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== SCHEMA_FILE);

for (const file of records) {
  const where = `validation/renderer-benchmark/${file}`;
  let record;
  try {
    record = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  } catch (err) {
    fail(where, `is not valid JSON: ${err.message}`);
    continue;
  }
  validate(record, schema, where, schema);
  crossCheck(record, where);
}

if (problems.length > 0) {
  console.error('verify:renderer-benchmark FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

if (records.length === 0) {
  console.log(
    'verify:renderer-benchmark OK — schema present, 0 records. '
    + 'The field is not wired into the renderer, so it has never drawn a frame to measure.',
  );
} else {
  console.log(
    `verify:renderer-benchmark OK — ${records.length} record(s), `
    + `each covering all ${REQUIRED_SCENES.length} corpus scenes.`,
  );
}
