#!/usr/bin/env node
/**
 * run-oracles.mjs — capture the PROJ and GeographicLib answers for the frozen
 * UTM fixture matrix.
 *
 * This is an oracle-generation job, not a repository gate. It runs the two
 * external programs, records what they were and what they said, and writes
 * references/oracle-utm.json. tests/geodesyOracleAgreement.test.ts then reads
 * that committed file and compares OLV against it, so ordinary CI verifies the
 * candidate on a machine that has neither program installed.
 *
 * The candidate never enters this file. It captures oracles only, which is what
 * keeps the reference outputs usable as a fixed target: a reference that had to
 * be regenerated whenever OLV changed would not be a reference.
 *
 * GeographicLib picks the zone, because it applies the UTM zone exceptions from
 * the standard. PROJ is then asked for that same zone, so the PROJ leg measures
 * projection arithmetic while the GeographicLib leg also covers zone selection.
 *
 * Usage:  node validation/external-oracles/geodesy/run-oracles.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const ROOT = resolve(HERE, '../../..');
const REFS = resolve(HERE, 'references');

/** Coordinates go to both tools as fixed decimals: GeoConvert refuses 1e-9. */
const DEGREE_DIGITS = 12;
/** Nine decimals of a metre is far below any disagreement worth reporting. */
const METRE_DIGITS = 9;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const run = (exe, args, input) => {
  const r = execFileSync(exe, args, { input, encoding: 'utf8' });
  return r.trim();
};

/** `which`, resolved once so the exact path lands in the record. */
const resolveExe = (name) => run('/usr/bin/which', [name], undefined);

/**
 * The oracle binaries, resolved through `which` once each, for the reason
 * given on {@link PROJINFO}: a spawn that names a bare command asks PATH at
 * the moment it runs, so the binary that answered and the binary the record
 * names are two separate lookups that a PATH change between them can
 * separate. An oracle whose provenance can drift from its own numbers is not
 * an oracle. Resolving once and spawning the absolute path everywhere makes
 * the recorded path the one that produced the figures by construction.
 */
const CS2CS = resolveExe('cs2cs');
const GEOCONVERT = resolveExe('GeoConvert');

const versionOf = {
  // PROJ has no --version. Every CLI prints its release banner to stderr as the
  // first line of usage, and `-h` reaches it without consuming stdin.
  'proj-9.8.1': () => {
    const r = spawnSync(CS2CS, ['-h'], { encoding: 'utf8' });
    const banner = `${r.stderr ?? ''}${r.stdout ?? ''}`.split('\n')[0].trim();
    if (!/\d/.test(banner)) throw new Error(`cs2cs printed no version banner: ${JSON.stringify(banner)}`);
    return banner;
  },
  // GeoConvert prints its own argv[0] ahead of the version, so spawning the
  // absolute path would put this machine's install prefix into a committed
  // fixture and make it disagree with every other machine's. The binary that
  // answered is recorded separately as `executablePath`; what belongs in the
  // banner is the version.
  'geographiclib-2.7': () =>
    run(GEOCONVERT, ['--version'], undefined).replace(/^\S*GeoConvert:/, 'GeoConvert:'),
};

/**
 * The coordinate operation PROJ selects for a source and target, as PROJ names
 * it rather than as the caller assumes.
 *
 * Recording only the numbers leaves the record unable to explain itself. Two
 * PROJ builds can return different eastings for the same request because they
 * chose different candidate operations, and without the operation identity that
 * shows up as an unexplained change in a committed reference. `projinfo`
 * summary prints `<code>, <name>, <accuracy>, <area of use>` per candidate.
 *
 * The accuracy field is the second reason to keep this. A same-datum projection
 * reports `0 m` because no transformation grid is involved; a datum shift would
 * report the grid's accuracy instead, so this field is where a future study
 * would notice that a grid had silently entered the path.
 */
const operationCache = new Map();
/**
 * Resolved through `which` once, so the spawn names an absolute path rather
 * than leaning on whatever PATH happens to hold, and so the record says which
 * binary actually answered.
 */
const PROJINFO = resolveExe('projinfo');
function projOperationFor(sourceCrs, targetCrs) {
  const key = `${sourceCrs}->${targetCrs}`;
  if (operationCache.has(key)) return operationCache.get(key);

  const r = spawnSync(PROJINFO, ['-s', sourceCrs, '-t', targetCrs, '-o', 'PROJ', '--summary'], {
    encoding: 'utf8',
  });
  const text = r.stdout ?? '';
  const candidates = text.split('\n').filter((l) => /^\s*EPSG:|^\s*unknown id/.test(l));
  const first = candidates[0]?.trim() ?? null;
  const parts = first ? first.split(',').map((s) => s.trim()) : [];

  const op = {
    selected: parts[0] ?? null,
    name: parts[1] ?? null,
    accuracy: parts[2] ?? null,
    candidateCount: candidates.length,
    raw: first,
  };
  operationCache.set(key, op);
  return op;
}

const protocol = JSON.parse(readFileSync(resolve(HERE, 'protocol.json'), 'utf8'));
const fixturesRaw = readFileSync(resolve(HERE, 'fixtures.json'), 'utf8');
const { fixtures } = JSON.parse(fixturesRaw);

if (fixtures.length < protocol.metrics.minimumFixtures) {
  throw new Error(
    `protocol requires ${protocol.metrics.minimumFixtures} fixtures, matrix has ${fixtures.length}`,
  );
}

/** GeoConvert -u: "<zone><n|s> <easting> <northing>", zone possibly zero-padded. */
const parseGeoConvert = (out) => {
  const m = /^(\d+)\s*([nsNS])\s+([\d.+-]+)\s+([\d.+-]+)$/.exec(out);
  if (!m) throw new Error(`GeoConvert output not understood: ${JSON.stringify(out)}`);
  return {
    zone: Number(m[1]),
    hemisphere: m[2].toLowerCase() === 's' ? 'S' : 'N',
    easting: Number(m[3]),
    northing: Number(m[4]),
  };
};

const results = [];
for (const f of fixtures) {
  const line = `${f.lat.toFixed(DEGREE_DIGITS)} ${f.lon.toFixed(DEGREE_DIGITS)}`;

  const geoRaw = run(GEOCONVERT, ['-u', '-p', String(METRE_DIGITS)], `${line}\n`);
  const geo = parseGeoConvert(geoRaw);

  const epsg = (geo.hemisphere === 'S' ? 32700 : 32600) + geo.zone;
  const projRaw = run(CS2CS, ['-f', `%.${METRE_DIGITS}f`, 'EPSG:4326', `EPSG:${epsg}`], `${line}\n`);
  const parts = projRaw.split(/\s+/);
  const proj = {
    easting: Number(parts[0]),
    northing: Number(parts[1]),
    epsg,
    operation: projOperationFor('EPSG:4326', `EPSG:${epsg}`),
  };

  if (!Number.isFinite(proj.easting) || !Number.isFinite(proj.northing)) {
    throw new Error(`cs2cs output not understood for ${f.id}: ${JSON.stringify(projRaw)}`);
  }

  results.push({
    id: f.id,
    lat: f.lat,
    lon: f.lon,
    input: line,
    geographiclib: { ...geo, raw: geoRaw },
    proj: { ...proj, raw: projRaw },
    /** What the two oracles differ by. Separates oracle spread from candidate error. */
    oracleSpread: {
      eastingM: proj.easting - geo.easting,
      northingM: proj.northing - geo.northing,
    },
  });
}

const spreadE = Math.max(...results.map((r) => Math.abs(r.oracleSpread.eastingM)));
const spreadN = Math.max(...results.map((r) => Math.abs(r.oracleSpread.northingM)));

const record = {
  schemaVersion: 1,
  protocolId: protocol.protocolId,
  generatedBy: 'validation/external-oracles/geodesy/run-oracles.mjs',
  fixturesSha256: `sha256:${sha256(fixturesRaw)}`,
  fixtureCount: results.length,
  environment: {
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    locale: process.env.LC_ALL ?? process.env.LANG ?? 'unset',
  },
  oracles: [
    {
      oracleId: 'geographiclib-2.7',
      role: 'independent-same-quantity-implementation',
      executablePath: GEOCONVERT,
      versionOutput: versionOf['geographiclib-2.7'](),
      commandLine: `GeoConvert -u -p ${METRE_DIGITS}`,
      zoneSource: 'oracle',
    },
    {
      oracleId: 'proj-9.8.1',
      role: 'independent-same-quantity-implementation',
      executablePath: CS2CS,
      versionOutput: versionOf['proj-9.8.1'](),
      commandLine: `cs2cs -f %.${METRE_DIGITS}f EPSG:4326 EPSG:<326|327><zone>`,
      zoneSource: 'geographiclib-2.7',
      operationSource: 'projinfo -s EPSG:4326 -t EPSG:<zone> -o PROJ --summary',
      operationExecutablePath: PROJINFO,
      operationsSelected: [...operationCache.entries()]
        .map(([pair, op]) => ({ pair, selected: op.selected, name: op.name, accuracy: op.accuracy, candidates: op.candidateCount }))
        .sort((a, b) => a.pair.localeCompare(b.pair)),
    },
  ],
  oracleAgreement: {
    maxAbsEastingM: spreadE,
    maxAbsNorthingM: spreadN,
    note: 'PROJ against GeographicLib over the same fixtures. Two separate lineages, so this bounds how much of any candidate residual could be oracle disagreement rather than candidate error.',
  },
  results,
};

mkdirSync(REFS, { recursive: true });
const out = resolve(REFS, 'oracle-utm.json');
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

console.log(
  `run-oracles: wrote ${results.length} fixture(s) to ${out.slice(ROOT.length + 1)}\n` +
    `  oracle spread: max |dE| ${spreadE.toExponential(3)} m, max |dN| ${spreadN.toExponential(3)} m`,
);
