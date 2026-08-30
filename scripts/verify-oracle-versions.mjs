#!/usr/bin/env node
/**
 * verify-oracle-versions.mjs — does the oracle on this machine still match the
 * one the validation records say produced their references?
 *
 * Nothing in this repository asked that question before, and two failures went
 * unnoticed within an hour of each other because of it:
 *
 *   1. A package upgrade moved GDAL from 3.13.1 to 3.13.3. The corpus cites
 *      3.13.1 in hundreds of places. Every study kept passing, because every
 *      study compares committed artifacts against recomputed candidate output
 *      and never looks at the tool.
 *   2. PDAL 2.10.2 began aborting in dyld, because a shared library it links
 *      was upgraded underneath it. PDAL is the reference for several E4 legs.
 *      It was not producing wrong answers; it was producing none, and the only
 *      way to find out was to run it.
 *
 * This check reads the versions the records already state, runs each oracle's
 * own version command, and compares. It reads; it never rewrites a record.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABSENT IS NOT A FAILURE. BROKEN IS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Several legs already record `status: "failed"` rather than fabricating a
 * reference, and the reference runners are written to survive a missing tool.
 * A machine without SAGA installed is a normal machine, so an oracle that is
 * not on PATH is reported and passed over.
 *
 * An oracle that IS on PATH and cannot report its own version is the second
 * failure above, exactly. That exits non-zero. So does a version that disagrees
 * with what a record claims, and so does a container pin whose stated version
 * has drifted from the records that cite it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT READS
 * ─────────────────────────────────────────────────────────────────────────────
 *   validation/cross-implementation/studies/*.study.json  → reference.tool and
 *       reference.version, the version a study preregistered for its reference.
 *   validation/ ** /reference-runs*.json                  → the environment
 *       block each reference runner writes, verbatim from the tool.
 *   validation/oracles/oracle-pins.json                   → the versions the
 *       pinned container image installs, when that file exists.
 *
 * The pin cross-check is the half that runs everywhere. It needs no oracle
 * installed at all, so CI catches a record and an image that have drifted apart
 * even on a runner that has neither GDAL nor PDAL.
 *
 * Usage:
 *   node scripts/verify-oracle-versions.mjs           human-readable report
 *   node scripts/verify-oracle-versions.mjs --json    the same as one JSON object
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryOnPath } from './lib/binaryOnPath.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATION = resolve(ROOT, 'validation');
const STUDIES = resolve(VALIDATION, 'cross-implementation/studies');
const PINS = resolve(VALIDATION, 'oracles/oracle-pins.json');
const rel = (abs) => relative(ROOT, abs).split('\\').join('/');

/**
 * The oracles this project uses, and how each one is asked its version.
 *
 * `probe` is the command. `parse` pulls the version out of what the command
 * prints. `extract` pulls the version out of a free-text string a record wrote,
 * which is a different problem: those strings range from a bare "2.10.2" to
 * `GDAL 3.13.1 "Iowa City", released 2026/06/01` to a sentence naming two tools.
 *
 * `names` is matched against a study's `reference.tool` field, case-insensitively
 * and as a WHOLE WORD, so "GDAL/OGR SpatiaLite and R" resolves to both GDAL and
 * R, while "GeographicLib" is NOT mistaken for GDAL by the `ogr` inside it.
 */
const ORACLES = [
  {
    id: 'GDAL',
    names: ['gdal', 'ogr'],
    probe: ['gdalinfo', '--version'],
    parse: (out) => /GDAL\s+(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null,
    extract: (text) => /GDAL\s+(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? bareVersion(text),
  },
  {
    id: 'PDAL',
    names: ['pdal'],
    probe: ['pdal', '--version'],
    parse: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null,
    extract: (text) => /PDAL\s+(\d+\.\d+\.\d+)/i.exec(text)?.[1] ?? bareVersion(text),
  },
  {
    id: 'SAGA',
    names: ['saga'],
    probe: ['saga_cmd', '--version'],
    parse: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null,
    extract: (text) => bareVersion(text),
  },
  {
    id: 'R',
    // "R" alone is a substring of far too much prose, so the match is on the
    // word, which is how every record that means the language writes it.
    names: [/\bR\b/],
    probe: ['Rscript', '--version'],
    parse: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null,
    extract: (text) => /\bR\s+(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null,
  },
];

/** The first bare `x.y.z` in a string, or null. */
function bareVersion(text) {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/**
 * Whether a name matches a tool field. A string name matches as a WHOLE WORD,
 * not a bare substring: `ogr` matches "GDAL/OGR" (the slash is a boundary) but
 * NOT "GeographicLib", where the letters `ogr` sit mid-word. Substring matching
 * misread "GeographicLib" as GDAL and then attributed the PROJ version beside it
 * to GDAL — the false positive this word-boundary form removes. A RegExp name is
 * used as given (the `R` language token already relies on this).
 */
function nameMatches(name, tool) {
  return name instanceof RegExp ? name.test(tool) : new RegExp(`\\b${name}\\b`, 'i').test(tool);
}

/** Which oracles a record's tool field names. */
export function oraclesFor(tool) {
  return ORACLES.filter((o) => o.names.some((n) => nameMatches(n, tool)));
}

/** Every *.json under a directory tree, skipping the frozen snapshot. */
function jsonFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // validation/snapshot/ is a frozen copy of an earlier release. Its versions
    // are history and are supposed to differ from today's machine.
    if (entry.isDirectory()) {
      if (entry.name === 'snapshot' || entry.name === 'node_modules') continue;
      jsonFiles(full, acc);
    } else if (entry.name.endsWith('.json')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Every (oracle, version, source) claim the corpus makes.
 *
 * A claim is a version some committed record says an oracle had. The same
 * version appears many times; each occurrence is kept so a mismatch can name
 * every file that would have to change.
 */
function collectClaims() {
  const claims = [];
  const add = (oracleId, version, source, field) => {
    if (version) claims.push({ oracleId, version, source, field });
  };

  if (existsSync(STUDIES)) {
    for (const name of readdirSync(STUDIES).filter((n) => n.endsWith('.json'))) {
      const path = join(STUDIES, name);
      let study;
      try {
        study = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      const ref = study.reference;
      if (!ref?.tool || typeof ref.version !== 'string') continue;
      for (const oracle of oraclesFor(ref.tool)) {
        add(oracle.id, oracle.extract(ref.version), rel(path), 'reference.version');
      }
    }
  }

  // The environment blocks the reference runners write. Field names are per
  // runner (`pdalVersion`, `gdalinfoVersion`, `gdalTranslateVersion`), so the
  // oracle is decided by the field name rather than by a tool field.
  const FIELD_ORACLE = [
    [/^pdalVersion$/i, 'PDAL'],
    [/^gdal/i, 'GDAL'],
    [/^ogr/i, 'GDAL'],
    [/^saga/i, 'SAGA'],
    [/^r(Script)?Version$/i, 'R'],
  ];
  for (const path of jsonFiles(VALIDATION)) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const env = doc?.environment;
    if (!env || typeof env !== 'object') continue;
    for (const [field, value] of Object.entries(env)) {
      if (typeof value !== 'string') continue;
      // "unavailable: ..." and "not-recorded: ..." are how the runners record a
      // tool they could not reach. They are not version claims.
      if (/^(unavailable|not-recorded|not-executed)/.test(value)) continue;
      const hit = FIELD_ORACLE.find(([re]) => re.test(field));
      if (!hit) continue;
      const oracle = ORACLES.find((o) => o.id === hit[1]);
      add(oracle.id, oracle.extract(value), rel(path), `environment.${field}`);
    }
  }
  return claims;
}

/**
 * What the pinned image declares for each oracle, when the pin manifest is
 * present. A value is a single version OR an array of accepted versions — a
 * declared set for a corpus produced across more than one patch release (see
 * oracle-pins.json GDALVersionsNote). Each accepted version becomes one entry.
 */
function collectPins() {
  if (!existsSync(PINS)) return null;
  try {
    const pins = JSON.parse(readFileSync(PINS, 'utf8'));
    const out = [];
    for (const [oracleId, value] of Object.entries(pins.oracleVersions ?? {})) {
      for (const version of Array.isArray(value) ? value : [value]) {
        if (typeof version === 'string') out.push({ oracleId, version });
      }
    }
    return { path: rel(PINS), entries: out };
  } catch {
    return { path: rel(PINS), entries: [], unreadable: true };
  }
}

/**
 * The recorded versions a declared set does not accept. Empty when every
 * recorded version is in the set. This is what keeps the guard honest: a
 * documented multi-version corpus passes, but a version nobody declared fails.
 */
export function undeclaredVersions(recorded, accepted) {
  return [...new Set(recorded.filter((v) => !accepted.has(v)))];
}

/** Ask one oracle its own version. */
function probe(oracle) {
  const found = binaryOnPath(oracle.probe[0]);
  if (found === null) {
    return { state: 'absent', detail: `${oracle.probe[0]} is not on PATH` };
  }
  const r = spawnSync(found, oracle.probe.slice(1), { encoding: 'utf8' });
  const exitCode = r.status === null ? -1 : r.status;
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (exitCode !== 0) {
    return {
      state: 'broken',
      path: found,
      exitCode,
      // The dyld abort that started this file printed its whole complaint to
      // stderr and exited 134. Keeping the first lines makes the report the
      // diagnosis rather than a pointer to one.
      detail: (output.trim() || r.error?.message || 'no output').split('\n').slice(0, 6).join('\n'),
    };
  }
  const version = oracle.parse(output);
  if (version === null) {
    return {
      state: 'broken',
      path: found,
      exitCode,
      detail: `exited 0 but printed no recognisable version: ${output.trim().slice(0, 200)}`,
    };
  }
  return { state: 'present', path: found, version, raw: output.trim().split('\n')[0] };
}

function main() {
  const asJson = process.argv.includes('--json');
  const claims = collectClaims();
  const pins = collectPins();
  const problems = [];
  const report = [];

  for (const oracle of ORACLES) {
    const mine = claims.filter((c) => c.oracleId === oracle.id);
    const pinned = pins?.entries.filter((p) => p.oracleId === oracle.id) ?? [];
    if (mine.length === 0 && pinned.length === 0) continue;

    const versions = [...new Set(mine.map((c) => c.version))].sort();
    const live = probe(oracle);
    const entry = {
      oracle: oracle.id,
      command: oracle.probe.join(' '),
      recordedVersions: versions,
      recordCount: mine.length,
      pinnedVersions: [...new Set(pinned.map((p) => p.version))],
      live,
      status: 'ok',
    };

    // The static half: the image's declared version set against the corpus, no
    // oracle needed. A record passes if it matches ANY declared version; one that
    // matches none is undeclared drift.
    const accepted = new Set(pinned.map((p) => p.version));
    if (pinned.length > 0) {
      const disagreeing = mine.filter((c) => !accepted.has(c.version));
      if (disagreeing.length > 0) {
        entry.status = 'pin-drift';
        problems.push(
          `${oracle.id}: ${pins.path} accepts ${[...accepted].join(', ')}, but ${disagreeing.length} record(s) cite ` +
            `${undeclaredVersions(disagreeing.map((c) => c.version), accepted).join(', ')} (undeclared). ` +
            `First: ${disagreeing[0].source} (${disagreeing[0].field}).`,
        );
      }
    }

    // The live half.
    if (live.state === 'broken') {
      entry.status = 'broken';
      problems.push(
        `${oracle.id}: ${live.path} is installed but \`${oracle.probe.join(' ')}\` failed ` +
          `(exit ${live.exitCode}). ${mine.length} record(s) name it as a reference.\n      ` +
          live.detail.split('\n').join('\n      '),
      );
    } else if (live.state === 'present') {
      // A record is only a live mismatch when it names a version this machine
      // does not have AND the pin does not declare — a declared version produced
      // on another machine is expected, not a reproduction failure.
      const wrong = mine.filter((c) => c.version !== live.version && !accepted.has(c.version));
      if (wrong.length > 0) {
        entry.status = 'mismatch';
        const cited = [...new Set(wrong.map((c) => c.version))].join(', ');
        const files = [...new Set(wrong.map((c) => c.source))];
        problems.push(
          `${oracle.id}: this machine has ${live.version}, but ${wrong.length} record(s) in ` +
            `${files.length} file(s) cite ${cited}. Re-running a reference here would not ` +
            `reproduce what those records describe.\n      ` +
            files.slice(0, 6).map((f) => `- ${f}`).join('\n      ') +
            (files.length > 6 ? `\n      - ...and ${files.length - 6} more` : ''),
        );
      }
    } else if (entry.status === 'ok') {
      // Only when the pin cross-check above found nothing: a drifted pin is a
      // finding on its own, and an absent oracle must not erase it.
      entry.status = 'absent';
    }
    report.push(entry);
  }

  if (pins?.unreadable) {
    problems.push(`${pins.path} exists but is not readable JSON.`);
  }

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ generatedBy: 'scripts/verify-oracle-versions.mjs', pins: pins?.path ?? null, oracles: report, problems }, null, 2) + '\n',
    );
    process.exit(problems.length > 0 ? 1 : 0);
  }

  for (const e of report) {
    const live =
      e.live.state === 'present'
        ? `${e.live.version} at ${e.live.path}`
        : e.live.state === 'absent'
          ? 'not installed here'
          : `INSTALLED BUT BROKEN (exit ${e.live.exitCode})`;
    const pin = e.pinnedVersions.length > 0 ? `, image pins ${e.pinnedVersions.join('/')}` : '';
    console.log(
      `${e.status === 'ok' || e.status === 'absent' ? 'ok  ' : 'FAIL'}  ${e.oracle.padEnd(5)} ` +
        `records cite ${e.recordedVersions.join('/') || '(none)'} in ${e.recordCount} place(s)${pin}; live: ${live}`,
    );
  }

  if (problems.length > 0) {
    console.error('\nverify:oracle-versions FAILED\n');
    for (const p of problems) console.error(`  • ${p}\n`);
    console.error(
      '  A reference produced now would not be the reference these records describe.\n' +
        '  Either install the version the records name (validation/oracles/ builds it),\n' +
        '  or re-run the affected references and update every record that cites the old version.\n',
    );
    process.exit(1);
  }

  const absent = report.filter((e) => e.status === 'absent').map((e) => e.oracle);
  console.log(
    `\nverify:oracle-versions OK — ${claims.length} recorded version claim(s) checked` +
      (absent.length > 0 ? `; ${absent.join(', ')} not installed here, which is not a failure.` : '.'),
  );
}

if (isCliEntry(import.meta.url)) {
  main();
}
