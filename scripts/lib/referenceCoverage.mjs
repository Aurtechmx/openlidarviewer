/**
 * referenceCoverage.mjs — one auditable view of the oracle-triangulation
 * framework's external-validation coverage.
 *
 * Each `validation/oracle-consensus/*.consensus.json` record triangulates one
 * OLV quantity against analytic truth and/or matched independent implementations
 * (GDAL, GRASS, PROJ, ...), or documents method sensitivity against a set of
 * established filters. This module reduces WHATEVER records are present to a flat
 * coverage matrix — quantity, verdict class, which reference tiers back it, and
 * which external tools — so the framework's reach can be read at a glance and
 * grow as new families (volume, registration, ...) land. It reads the records;
 * it does not know a roster.
 *
 * verdictClass derivation:
 *   evidenceRole === 'exploratory'        -> METHOD_SENSITIVITY
 *   else has an analytic-truth leg        -> PASS_TRUTH
 *   else (only matched implementations)   -> PASS_REPLICATION
 */
import { expectedTestName } from '../lint-oracle-consensus.mjs';

/** Collect every oracle entry a record carries, whether flat or under `cases`. */
function collectOracles(record) {
  if (Array.isArray(record.oracles)) return record.oracles;
  if (Array.isArray(record.cases)) return record.cases.flatMap((c) => c.oracles ?? []);
  return [];
}

/** First word of a tool string, upper-cased leader kept as the vendor token. */
function toolLeader(tool) {
  if (!tool || typeof tool !== 'string') return null;
  const first = tool.trim().split(/\s+/)[0];
  return first || null;
}

/**
 * Reference tools that back one record. For triangulation records they come from
 * the matched/truth oracle `tool` strings (first word). For an exploratory
 * record there are no oracle legs — the references are the per-scene
 * `referenceF1` keys (e.g. smrf/csf/pmf), so read them from there.
 */
function externalToolsFor(record, oracles) {
  const tools = new Set();
  for (const o of oracles) {
    const leader = toolLeader(o.tool);
    // "closed form ..." is the analytic-truth leg, not an external tool.
    if (leader && !/^closed$/i.test(leader)) tools.add(leader);
  }
  if (record.evidenceRole === 'exploratory' && Array.isArray(record.scenes)) {
    for (const s of record.scenes) {
      const ref = s.referenceF1;
      if (ref && typeof ref === 'object') {
        for (const k of Object.keys(ref)) tools.add(k);
      }
    }
  }
  return [...tools].sort();
}

/** Distinct referenceClass values present across a record's oracle legs. */
function referenceClassesFor(record, oracles) {
  const classes = new Set(oracles.map((o) => o.referenceClass).filter(Boolean));
  if (record.evidenceRole === 'exploratory') classes.add('exploratory-reference');
  return [...classes].sort();
}

/**
 * Derive the verdict class for one record. Returns null when the record carries
 * no basis for a verdict (no truth leg, no matched implementations, not
 * exploratory) — the lint treats that as a failure.
 */
export function deriveVerdictClass(record, oracles = collectOracles(record)) {
  if (record.evidenceRole === 'exploratory') return 'METHOD_SENSITIVITY';
  const hasTruth = oracles.some((o) => o.referenceClass === 'analytic-truth');
  if (hasTruth) return 'PASS_TRUTH';
  const matched = oracles.filter((o) => o.referenceClass === 'matched-implementation').length;
  if (matched > 0) return 'PASS_REPLICATION';
  return null;
}

/**
 * Pure coverage reducer. `records` is an array of `{ file, record }` pairs.
 * Returns one row per record, sorted by quantity then file.
 */
export function buildCoverage(records) {
  const rows = records.map(({ file, record }) => {
    const oracles = collectOracles(record);
    return {
      quantity: record?.contract?.quantity ?? null,
      record: file,
      test: expectedTestName(file),
      verdictClass: deriveVerdictClass(record, oracles),
      referenceClasses: referenceClassesFor(record, oracles),
      externalTools: externalToolsFor(record, oracles),
      evidenceRole: record?.evidenceRole ?? null,
    };
  });
  rows.sort((a, b) => {
    const q = String(a.quantity).localeCompare(String(b.quantity));
    return q !== 0 ? q : String(a.record).localeCompare(String(b.record));
  });
  return rows;
}

/** Counts by verdictClass plus the sorted quantity list. */
export function coverageSummary(coverage) {
  const byVerdictClass = {};
  for (const row of coverage) {
    const key = row.verdictClass ?? 'UNCLASSIFIED';
    byVerdictClass[key] = (byVerdictClass[key] ?? 0) + 1;
  }
  const quantities = [...new Set(coverage.map((r) => r.quantity).filter(Boolean))].sort();
  return { total: coverage.length, byVerdictClass, quantities };
}
