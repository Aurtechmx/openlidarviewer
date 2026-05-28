/**
 * eptDetect.ts
 *
 * Detect + validate an EPT `ept.json` manifest. Two entry points:
 *
 *   1. `detectEptUrl(url)` — quick URL-based test for "this looks like an
 *      EPT entry point" (the URL ends in `/ept.json` or `ept.json`). Used
 *      by the file-open routing to decide whether to take the EPT branch.
 *
 *   2. `parseEptMetadata(text)` — the full schema validator. Returns a
 *      typed `EptDetection` discriminated union so callers handle the
 *      failure paths explicitly.
 *
 * Validation philosophy: be strict on the fields the viewer USES (version,
 * dataType, hierarchyType, schema X/Y/Z, bounds, points). Be lenient on
 * fields the spec defines but the viewer doesn't consume (srs, sources,
 * extra schema attributes). A malformed-but-loadable EPT shouldn't fail
 * just because a metadata extension we don't read is shaped oddly.
 *
 * Pure parser — no I/O, no three.js. Caller provides the manifest text;
 * caller is responsible for the network fetch and the typed errors that
 * arise from it.
 */

import type {
  EptDataType,
  EptDetection,
  EptHierarchyType,
  EptMetadata,
  EptSchemaField,
} from './eptTypes';

/** Quick URL test for the EPT entrypoint. */
export function detectEptUrl(url: string): boolean {
  // Trim a hash / query, then check the pathname ends with /ept.json.
  // Both `https://server/path/to/ept.json` and `…/path/to/ept.json?token=x`
  // should match. Case-insensitive on the filename.
  try {
    const u = new URL(url);
    return /(?:^|\/)ept\.json$/i.test(u.pathname);
  } catch {
    // Not a parseable URL — fall through to plain-string match (handles
    // local file-system paths during dev).
    return /(?:^|\/)ept\.json(?:\?|#|$)/i.test(url);
  }
}

/**
 * Validate + parse an EPT metadata document from the raw manifest text.
 *
 * Errors are returned as `{ isEpt: false, reason }` rather than thrown so
 * the file-open path can fall through to other format probes cleanly. The
 * reason string is the user-facing message — keep it short and concrete.
 */
export function parseEptMetadata(text: string): EptDetection {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      isEpt: false,
      reason: `EPT manifest is not valid JSON (${err instanceof Error ? err.message : 'parse error'}).`,
    };
  }

  if (!isPlainObject(json)) {
    return { isEpt: false, reason: 'EPT manifest must be a JSON object.' };
  }

  // ── version ──────────────────────────────────────────────────────────────
  const version = json['version'];
  if (typeof version !== 'string') {
    return { isEpt: false, reason: 'EPT manifest is missing a "version" string.' };
  }
  if (!/^1\./.test(version)) {
    return {
      isEpt: false,
      reason: `Unsupported EPT version ${version} — only EPT 1.x is supported.`,
    };
  }

  // ── dataType ─────────────────────────────────────────────────────────────
  const dataType = json['dataType'];
  if (dataType !== 'laszip' && dataType !== 'binary' && dataType !== 'zstandard') {
    return {
      isEpt: false,
      reason: `Unsupported EPT dataType "${String(dataType)}" — expected laszip / binary / zstandard.`,
    };
  }

  // ── hierarchyType ────────────────────────────────────────────────────────
  const hierarchyType = json['hierarchyType'];
  if (hierarchyType !== 'json') {
    return {
      isEpt: false,
      reason: `Unsupported EPT hierarchyType "${String(hierarchyType)}" — expected json.`,
    };
  }

  // ── points + span ────────────────────────────────────────────────────────
  const points = json['points'];
  if (typeof points !== 'number' || !Number.isFinite(points) || points < 0) {
    return { isEpt: false, reason: 'EPT manifest is missing a non-negative "points" count.' };
  }
  const span = json['span'];
  if (typeof span !== 'number' || !Number.isFinite(span) || span <= 0) {
    return { isEpt: false, reason: 'EPT manifest is missing a positive "span".' };
  }

  // ── schema ───────────────────────────────────────────────────────────────
  const schema = json['schema'];
  if (!Array.isArray(schema)) {
    return { isEpt: false, reason: 'EPT manifest is missing a "schema" array.' };
  }
  const parsedSchema: EptSchemaField[] = [];
  for (const entry of schema) {
    const field = parseSchemaField(entry);
    if (!field) {
      return {
        isEpt: false,
        reason: 'EPT schema contains an invalid field entry.',
      };
    }
    parsedSchema.push(field);
  }
  // The viewer requires X/Y/Z to be present.
  for (const need of ['X', 'Y', 'Z']) {
    if (!parsedSchema.some((f) => f.name === need)) {
      return {
        isEpt: false,
        reason: `EPT schema is missing the required "${need}" attribute.`,
      };
    }
  }

  // ── bounds ───────────────────────────────────────────────────────────────
  const bounds = json['bounds'];
  const boundsCubic = json['boundsConforming']
    ? json['bounds']
    : json['bounds'];
  // EPT v1.0 carries `bounds` (the cube) and `boundsConforming` (the tight
  // data bounds). v1.1 added `bounds.cubic` and `bounds.conforming` as
  // nested. Support both layouts.
  let conforming: readonly [number, number, number, number, number, number] | null = null;
  let cubic: readonly [number, number, number, number, number, number] | null = null;

  if (Array.isArray(bounds) && bounds.length === 6 && bounds.every(isFiniteNumber)) {
    cubic = bounds as [number, number, number, number, number, number];
    const conf = json['boundsConforming'];
    if (Array.isArray(conf) && conf.length === 6 && conf.every(isFiniteNumber)) {
      conforming = conf as [number, number, number, number, number, number];
    } else {
      // Some writers omit boundsConforming; fall back to the cube.
      conforming = cubic;
    }
  } else if (isPlainObject(bounds)) {
    const c = bounds['cubic'];
    const k = bounds['conforming'];
    if (Array.isArray(c) && c.length === 6 && c.every(isFiniteNumber)) {
      cubic = c as [number, number, number, number, number, number];
    }
    if (Array.isArray(k) && k.length === 6 && k.every(isFiniteNumber)) {
      conforming = k as [number, number, number, number, number, number];
    }
  }
  // Silence the unused-variable warning while we keep `boundsCubic` to
  // document the v1.0/v1.1 source-of-truth indirection. The values come
  // from the explicit branches above.
  void boundsCubic;

  if (!cubic || !conforming) {
    return { isEpt: false, reason: 'EPT manifest is missing a valid bounds array.' };
  }

  // ── srs (optional WKT string) ────────────────────────────────────────────
  let srs: string | undefined;
  const srsField = json['srs'];
  if (isPlainObject(srsField)) {
    const wkt = srsField['wkt'];
    if (typeof wkt === 'string' && wkt.trim().length > 0) {
      srs = wkt;
    }
  } else if (typeof srsField === 'string' && srsField.trim().length > 0) {
    srs = srsField;
  }

  const metadata: EptMetadata = {
    version,
    dataType: dataType as EptDataType,
    hierarchyType: hierarchyType as EptHierarchyType,
    points,
    span,
    schema: parsedSchema,
    bounds: { conforming, cubic },
    srs,
  };
  return { isEpt: true, metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSchemaField(raw: unknown): EptSchemaField | null {
  if (!isPlainObject(raw)) return null;
  const name = raw['name'];
  const size = raw['size'];
  const type = raw['type'];
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
  if (type !== 'signed' && type !== 'unsigned' && type !== 'float') return null;
  const out: { -readonly [K in keyof EptSchemaField]: EptSchemaField[K] } = {
    name,
    size,
    type,
  };
  if (typeof raw['scale'] === 'number' && Number.isFinite(raw['scale'])) {
    out.scale = raw['scale'] as number;
  }
  if (typeof raw['offset'] === 'number' && Number.isFinite(raw['offset'])) {
    out.offset = raw['offset'] as number;
  }
  return out;
}
