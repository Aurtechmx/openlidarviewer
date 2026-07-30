#!/usr/bin/env node
/**
 * Validate validation/defects/defect-registry.json against its JSON Schema.
 *
 * The validator is written here rather than pulled from a package because the
 * archive-portability suite requires every import in the tree to be a declared
 * dependency, and no schema validator is one. It implements the subset of JSON
 * Schema the registry schema uses and REFUSES a schema keyword it does not
 * implement, so a keyword added later cannot be silently ignored.
 *
 *   node scripts/check-defect-registry.mjs
 *
 * Exit 0 when the registry validates, 1 when it does not, 2 on a usage or read
 * error.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { compareCodeUnits } from './lib/codeUnitOrder.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = resolve(ROOT, 'validation/defects/defect-registry.json');
const SCHEMA = resolve(ROOT, 'validation/defects/defect-registry.schema.json');

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'uniqueItems', 'enum', 'pattern',
  'minLength', 'minimum',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'integer' || actual === 'number';
  return actual === expected;
}

/** Resolve a local `#/...` reference against the root schema. */
function deref(schema, root) {
  let node = schema;
  const seen = new Set();
  while (node && typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) throw new Error(`circular $ref at ${node.$ref}`);
    seen.add(node.$ref);
    if (!node.$ref.startsWith('#/')) throw new Error(`unsupported $ref ${node.$ref}`);
    node = node.$ref.slice(2).split('/').reduce((acc, key) => acc?.[key], root);
    if (!node) throw new Error(`unresolvable $ref`);
  }
  return node;
}

function validate(value, schema, root, path, errors) {
  const node = deref(schema, root);
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED.has(keyword)) {
      errors.push(`${path}: schema uses unimplemented keyword "${keyword}"`);
    }
  }

  if (node.type !== undefined) {
    const allowed = Array.isArray(node.type) ? node.type : [node.type];
    if (!allowed.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${allowed.join(' or ')}, found ${typeOf(value)}`);
      return;
    }
  }

  if (node.enum !== undefined && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of the ${node.enum.length} permitted values`);
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(`${path}: shorter than minLength ${node.minLength}`);
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${node.pattern}`);
    }
  }

  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${path}: below minimum ${node.minimum}`);
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${path}: has ${value.length} items, minItems is ${node.minItems}`);
    }
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push(`${path}: contains duplicate items`);
    }
    if (node.items !== undefined) {
      value.forEach((item, i) => validate(item, node.items, root, `${path}[${i}]`, errors));
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property "${key}"`);
    }
    const props = node.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        validate(child, props[key], root, `${path}.${key}`, errors);
      } else if (node.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

/**
 * Rules the schema cannot express, each one a way the numbers could stop
 * meaning what they say.
 */
function crossChecks(registry) {
  const errors = [];
  const ids = new Set();
  for (const d of registry.defects) {
    if (ids.has(d.id)) errors.push(`${d.id}: duplicate id`);
    ids.add(d.id);
    if (d.secondaryTags.includes(d.validationCategory)) {
      errors.push(`${d.id}: secondaryTags repeats the primary category`);
    }
    const bySuite = d.discoveryMethod === 'validation suite';
    if (bySuite !== (d.detectingMechanism !== 'none')) {
      errors.push(`${d.id}: discoveryMethod and detectingMechanism disagree`);
    }
    if (d.magnitude !== null && d.magnitude.trim() === '') {
      errors.push(`${d.id}: magnitude is blank; use null when none was measured`);
    }
  }
  const ordered = registry.defects.map((d) => d.id);
  if ([...ordered].sort(compareCodeUnits).join() !== ordered.join()) {
    errors.push('defects are not in id order');
  }
  return errors;
}

let registry;
let schema;
try {
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
} catch (err) {
  console.error(`cannot read the registry or its schema: ${err.message}`);
  process.exit(2);
}

const errors = [];
validate(registry, schema, schema, 'registry', errors);
errors.push(...crossChecks(registry));

if (errors.length > 0) {
  console.error(`defect registry: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(`defect registry: ${registry.defects.length} records validate against the schema`);
