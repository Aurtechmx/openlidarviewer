/**
 * recordSchema.mjs — the JSON Schema subset the validation-record verifiers use,
 * plus the canonical form their digests are taken over.
 *
 * WHY A SUBSET AND NOT A LIBRARY. No schema validator is a declared dependency
 * of this project, and scripts/verify-archive-portability.mjs requires every
 * import in this directory to be one. The subset implemented here is exactly
 * what the schemas next to it are allowed to use, and a keyword outside
 * `SUPPORTED_KEYWORDS` is reported as an error rather than ignored — a schema
 * that grows past its validator must fail loudly instead of quietly checking
 * less than it appears to.
 *
 * scripts/verify-cross-implementation-study.mjs carries an equivalent validator
 * inline. It is deliberately not refactored to import this one: that file is the
 * reviewed record format for cross-implementation studies and changing its
 * validation behaviour is not a side effect anyone should accept from adding a
 * new container. The two must stay in agreement, and the shape of the subset is
 * small enough to compare by reading.
 *
 * Ordering here is UTF-16 code-unit order, never `localeCompare`: these strings
 * feed digests that are committed and re-derived on other machines, and
 * collation order moves with the locale and the ICU build.
 */

import { createHash } from 'node:crypto';

import { compareCodeUnits } from './codeUnitOrder.mjs';

/** The only keywords a schema validated by this module may use. */
export const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'enum', 'pattern',
  'minLength', 'minimum', 'maximum',
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

function deref(node, root) {
  const seen = new Set();
  let cur = node;
  while (cur && typeof cur.$ref === 'string') {
    if (seen.has(cur.$ref)) throw new Error(`circular $ref at ${cur.$ref}`);
    seen.add(cur.$ref);
    if (!cur.$ref.startsWith('#/')) throw new Error(`unsupported $ref ${cur.$ref}`);
    cur = cur.$ref.slice(2).split('/').reduce((acc, key) => acc?.[key], root);
    if (!cur) throw new Error('unresolvable $ref');
  }
  return cur;
}

/**
 * Validate `value` against `schema`, pushing human-readable messages onto
 * `errors`. `root` is the schema document `$ref`s resolve against and `path` is
 * the JSON path prefix used in messages.
 */
export function validateAgainstSchema(value, schema, root, path, errors) {
  const node = deref(schema, root);
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
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
    // Trim before the length check. A minLength:1 field exists to require a
    // substantive value, and `"   "` has length 3 but says nothing — it passed
    // every register's minLength:1 guards, so a generalisation record could
    // name a whitespace-only `boundary.doesNotExtendTo` and satisfy the schema's
    // own "a reach with no boundary reads as universal" invariant on a
    // technicality. Empty string and empty array were already rejected; only
    // deliberately-typed whitespace slipped. Shared by every record register
    // (field, reproduction, impact, generalization), so this hardens all four.
    if (node.minLength !== undefined && value.trim().length < node.minLength) {
      errors.push(`${path}: shorter than minLength ${node.minLength}`);
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${node.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) {
      errors.push(`${path}: below minimum ${node.minimum}`);
    }
    if (node.maximum !== undefined && value > node.maximum) {
      errors.push(`${path}: above maximum ${node.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${path}: has ${value.length} items, minItems is ${node.minItems}`);
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      errors.push(`${path}: has ${value.length} items, maxItems is ${node.maxItems}`);
    }
    if (node.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: contains duplicate items`);
    }
    if (node.items !== undefined) {
      value.forEach((item, i) => validateAgainstSchema(item, node.items, root, `${path}[${i}]`, errors));
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
        validateAgainstSchema(child, props[key], root, `${path}.${key}`, errors);
      } else if (node.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

/** Key-sorted JSON, so a digest depends on values and not on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort(compareCodeUnits)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** `sha256:`-prefixed digest over the canonical form of `value`. */
export function digestOf(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

/** An ISO calendar date, `YYYY-MM-DD`, that is also a real day. */
export function isIsoDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

export { compareCodeUnits };
