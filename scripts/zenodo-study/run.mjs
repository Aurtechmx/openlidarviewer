#!/usr/bin/env node
/**
 * run.mjs: the Zenodo 15421291 small-file study, end to end.
 * `npm run validate:zenodo-small`. See docs/validation/zenodo-small-study.md.
 *
 *   1. find iPhone.laz and GroundTruth.xlsx in the external-data cache and
 *      check their size and SHA-256 against the dataset register
 *   2. independent reference: laspy + lazrs (pinned in requirements.txt)
 *   3. OLV Node paths: serial decode, COPC node decode, LAS 1.4 export, CRS
 *   4. OLV pooled decode in Chromium with real workers
 *   5. the independent reader on OLV's exports
 *   6. compare, write results.json and summary.md
 *
 * Every check ends passed, failed, skipped, unsupported or unavailable. The
 * exit code is 1 when any required check is failed or unavailable: a missing
 * input, venv, package or browser never reads as a pass.
 *
 * Options:
 *   --data <dir>     external-data root holding zenodo/15421291/ (default:
 *                    $OLV_EXTERNAL_DATA, else ../SCANS beside the repository)
 *   --out <dir>      results folder (default: validation-results/zenodo-15421291)
 *   --python <path>  interpreter with requirements.txt installed (default:
 *                    $ZENODO_STUDY_PYTHON, else <out>/venv/bin/python)
 *   --setup-venv     create <out>/venv and install requirements.txt first
 *   --headed         run Chromium headed
 *   --no-ui          skip the app journey (reported as skipped)
 *   --keep           keep the record and LAS intermediates (about 800 MB)
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { compareCanonical, float32HalfUlp } from './canonical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const RECORD = '15421291';
const INPUTS = [
  { id: 'OLV-DS-055-SCANCMP-IPHONE', file: 'iPhone.laz', required: true },
  { id: 'OLV-DS-056-SCANCMP-GROUNDTRUTH', file: 'GroundTruth.xlsx', required: true },
];
const SPHERE_CSV = join(ROOT, 'validation', 'sphere-accuracy', 'spheres-epsg5514.csv');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const flag = (name) => argv.includes(name);
const dataRoot = resolve(opt('--data') ?? process.env.OLV_EXTERNAL_DATA ?? join(ROOT, '..', 'SCANS'));
const outDir = resolve(opt('--out') ?? join(ROOT, 'validation-results', `zenodo-${RECORD}`));
const venv = join(outDir, 'venv');
const python = resolve(opt('--python') ?? process.env.ZENODO_STUDY_PYTHON ?? join(venv, 'bin', 'python'));
const work = join(outDir, 'work');

const checks = [];
/** status: passed | failed | skipped | unsupported | unavailable */
function check(id, status, detail, required = true) {
  checks.push({ id, status, required, detail });
  const mark = { passed: 'ok  ', failed: 'FAIL', skipped: 'skip', unsupported: 'n/a ', unavailable: 'MISS' }[status];
  console.log(`${mark} ${id}${detail?.summary ? `: ${detail.summary}` : ''}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** sourceSha256 and sourceBytes of one register record, read without a YAML dependency. */
function registerRecord(id) {
  const text = readFileSync(join(ROOT, 'validation', 'datasets', 'dataset-register.yaml'), 'utf8');
  const start = text.indexOf(`- datasetId: ${id}\n`);
  if (start === -1) throw new Error(`${id} is not in the dataset register`);
  const end = text.indexOf('\n  - datasetId:', start + 1);
  const block = text.slice(start, end === -1 ? undefined : end);
  const field = (k) => new RegExp(`^\\s+${k}: (.+)$`, 'm').exec(block)?.[1]?.trim();
  return { sha256: field('sourceSha256'), bytes: Number(field('sourceBytes')), sourceUrl: field('sourceUrl') };
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadCanonical(name) {
  const meta = readJson(join(work, `${name}.json`));
  const buf = readFileSync(join(work, meta.canonical.file));
  return { records: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), count: meta.canonical.count, fields: meta.canonical.fields, meta };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error?.message };
}

function finish() {
  const failed = checks.filter((c) => c.required && (c.status === 'failed' || c.status === 'unavailable'));
  const result = {
    study: 'zenodo-15421291-small',
    generatedAt: new Date().toISOString(),
    command: `node scripts/zenodo-study/run.mjs ${argv.join(' ')}`.trim(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
    },
    inputs: INPUTS.map((i) => ({ datasetId: i.id, file: i.file })),
    verdict: failed.length === 0 ? 'passed' : 'failed',
    counts: Object.fromEntries(['passed', 'failed', 'skipped', 'unsupported', 'unavailable'].map((s) => [s, checks.filter((c) => c.status === s).length])),
    checks,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(result, null, 2));
  const lines = [
    `# Zenodo ${RECORD} small-file study`,
    '',
    `Verdict: ${result.verdict}. ${Object.entries(result.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
    `Generated ${result.generatedAt} by \`${result.command}\` on Node ${process.version}.`,
    '',
    '| Check | Status | Summary |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.id} | ${c.status}${c.required ? '' : ' (optional)'} | ${(c.detail?.summary ?? '').replace(/\|/g, '/')} |`),
    '',
    'Scope: decoding, attribute handling, export and CRS provenance of one public file. It is not sphere detection, a forestry or DBH result, or an instrument-accuracy result, and it moves no evidence level.',
    '',
  ];
  writeFileSync(join(outDir, 'summary.md'), lines.join('\n'));
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
  console.log(`\n${result.verdict.toUpperCase()}: results in ${outDir}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// ── 1. inputs ────────────────────────────────────────────────────────────────
mkdirSync(work, { recursive: true });
const paths = {};
for (const input of INPUTS) {
  const p = join(dataRoot, 'zenodo', RECORD, input.file);
  const rec = registerRecord(input.id);
  if (!existsSync(p)) {
    check(`input:${input.file}`, 'unavailable', { summary: `not in the cache (expected zenodo/${RECORD}/${input.file} under the data root; source ${rec.sourceUrl})` }, input.required);
    continue;
  }
  const bytes = statSync(p).size;
  const hash = sha256(p);
  const ok = bytes === rec.bytes && hash === rec.sha256;
  check(`input:${input.file}`, ok ? 'passed' : 'failed', {
    summary: ok ? `${bytes} bytes, SHA-256 matches ${input.id}` : `size ${bytes} (register ${rec.bytes}), SHA-256 ${hash} (register ${rec.sha256})`,
    bytes, sha256: hash, datasetId: input.id,
  }, input.required);
  if (ok) paths[input.file] = p;
}
if (!paths['iPhone.laz'] || !paths['GroundTruth.xlsx']) finish();

// ── 2. independent reference ─────────────────────────────────────────────────
const requirements = join(HERE, 'requirements.txt');
if (flag('--setup-venv') && !existsSync(python)) {
  const mk = run('python3', ['-m', 'venv', venv]);
  const pip = mk.code === 0 ? run(join(venv, 'bin', 'pip'), ['install', '-q', '-r', requirements]) : mk;
  if (pip.code !== 0) check('reference:venv', 'failed', { summary: 'could not create the venv', log: pip.out.slice(-2000) });
}
if (!existsSync(python)) {
  check('reference:venv', 'unavailable', { summary: `no interpreter at ${basename(dirname(dirname(python)))}/bin/python; pass --setup-venv, --python or ZENODO_STUDY_PYTHON` });
  finish();
}
const freeze = run(python, ['-I', '-m', 'pip', 'freeze']);
const pins = readFileSync(requirements, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const installed = new Set(freeze.out.split('\n').map((l) => l.trim().toLowerCase()));
const missingPins = pins.filter((p) => !installed.has(p.toLowerCase()));
if (freeze.code !== 0 || missingPins.length) {
  check('reference:venv', 'failed', { summary: `pinned packages not installed: ${missingPins.join(', ') || 'pip failed'}` });
  finish();
}
check('reference:venv', 'passed', { summary: pins.join(', '), pins });
const refRun = run(python, ['-I', join(HERE, 'reference.py'), 'las', paths['iPhone.laz'], work, 'reference']);
if (refRun.code !== 0) {
  check('reference:decode', 'failed', { summary: 'laspy could not read the original', log: refRun.out.slice(-2000) });
  finish();
}
const ref = readJson(join(work, 'reference.json'));
{
  const h = ref.header;
  check('reference:decode', h.pointCount === 2207759 && h.pointFormat === 7 && h.version === '1.4' ? 'passed' : 'failed', {
    summary: `${h.pointCount} points, LAS ${h.version}, PDRF ${h.pointFormat}, record ${h.recordLength} bytes, scale ${h.scale.join('/')}`,
    tool: ref.tool, header: h, vlrs: ref.vlrs, evlrs: ref.evlrs, distinctXyz: ref.distinctXyz, distinctRecords: ref.distinctRecords,
  });
  const copcVlr = ref.vlrs.some((v) => v.userId === 'copc' && v.recordId === 1);
  const wktVlr = ref.vlrs.find((v) => v.userId === 'LASF_Projection' && v.recordId === 2112);
  check('reference:inventory', copcVlr && wktVlr ? 'passed' : 'failed', {
    summary: `COPC info VLR ${copcVlr ? 'present' : 'absent'}; WKT VLR payload ${wktVlr?.payloadBytes ?? 'absent'} byte(s), text "${ref.wkt ?? ''}"; global encoding ${h.globalEncoding}; extra dimensions ${ref.extraDimensions.map((d) => `${d.name} ${d.dtype}`).join(', ')}`,
    extraDimensions: ref.extraDimensions, extraDimensionStats: ref.extraDimensionStats, normalLength: ref.normalLength,
    standardDimensions: ref.standardDimensions, rgb: ref.rgb,
  });
}
{
  const h = ref.header;
  const ok = ref.vlrs.some((v) => v.userId === 'copc' && v.recordId === 1) && h.pointCount === 2207759 && h.pointFormat === 7
    && h.recordLength === 60 && h.scale.every((s) => s === 0.001);
  check('facts:iphone', ok ? 'passed' : 'failed', {
    summary: `COPC (info VLR first) despite the .laz name; ${h.pointCount} points; PDRF ${h.pointFormat}; ${h.recordLength}-byte records; scale ${h.scale.join('/')} m`,
  });
}
const wbRun = run(python, ['-I', join(HERE, 'reference.py'), 'workbook', paths['GroundTruth.xlsx'], SPHERE_CSV, join(work, 'workbook.json')]);
if (wbRun.code !== 0) {
  check('workbook:reference-points', 'failed', { summary: 'openpyxl could not read the workbook', log: wbRun.out.slice(-2000) });
} else {
  const wb = readJson(join(work, 'workbook.json'));
  const cmp = wb.csvComparison;
  const ok = wb.referencePoints.count === 13 && cmp.matchedNames === 13 && cmp.onlyInCsv.length === 0 && cmp.onlyInWorkbook.length === 0 && cmp.maxAbsDifferenceMetres <= 5.0001e-7;
  check('workbook:reference-points', ok ? 'passed' : 'failed', {
    summary: `sheets ${Object.keys(wb.sheets).join(', ')}; ${wb.referencePoints.count} ReferencePoints entries, ${cmp.matchedNames} matched by name in spheres-epsg5514.csv, max |difference| ${cmp.maxAbsDifferenceMetres.toExponential(2)} m (6-decimal rounding); TreesPoints ${wb.treesPoints.count} rows`,
    ...wb,
  });
}

// ── 3. OLV Node paths ────────────────────────────────────────────────────────
const vitest = join(ROOT, 'node_modules', '.bin', 'vitest');
const nodeRun = run(vitest, ['run', '--config', 'scripts/zenodo-study/vitest.study.config.ts'], {
  env: { ...process.env, ZENODO_STUDY_INPUT: paths['iPhone.laz'], ZENODO_STUDY_OUT: work, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
});
if (nodeRun.code !== 0) check('olv:node-paths', 'failed', { summary: 'the Node study run failed', log: nodeRun.out.slice(-4000) });

// ── 4. pooled, in a browser ──────────────────────────────────────────────────
let pooledOk = false;
try {
  const { runPooled } = await import('./pooled.mjs');
  const p = await runPooled({ repo: ROOT, input: paths['iPhone.laz'], outDir: work, headed: flag('--headed') });
  pooledOk = p.decodePath === 'pooled' && p.poolWorkers > 0 && p.pageErrors.length === 0;
  check('olv:pooled-engaged', pooledOk ? 'passed' : 'failed', {
    summary: `decode path ${p.decodePath}, ${p.poolWorkers ?? 0} pool workers, ${p.chunkWorkersSeen} chunk workers seen (${p.workersClosedAfterLoad} closed 2 s after the load), ${p.lazChunkCount} LAZ chunks, ${p.decodeMs} ms, ${p.browser}${p.headless ? ' headless' : ''}`,
    ...p, representation: undefined,
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  const missing = /Cannot find module|Executable doesn't exist|browserType.launch/i.test(msg);
  check('olv:pooled-engaged', missing ? 'unavailable' : 'failed', { summary: missing ? 'Playwright or its Chromium is not installed' : msg.split('\n')[0], log: msg.slice(0, 4000) });
}

// ── 4b. the app itself: open, navigate, assign a CRS ───────────────────────
if (flag('--no-ui')) {
  check('ui:crs-journey', 'skipped', { summary: 'skipped by --no-ui' }, false);
} else {
  try {
    const { runUi } = await import('./ui.mjs');
    const u = await runUi({ repo: ROOT, input: paths['iPhone.laz'], headed: flag('--headed') });
    const row = (h, label) => Object.values(h).find((r) => r.text.includes(label))?.text ?? '';
    const beforeOk = /CRS unknown/.test(u.before.crs) && /Coordinate system\s*Unknown/.test(row(u.before.health, 'Coordinate system'));
    const afterOk = /EPSG:5514/.test(u.after.crs) && /User override/.test(u.after.crs) && /Coordinate system\s*Known/.test(row(u.after.health, 'Coordinate system'))
      && /Vertical datum\s*Unknown/.test(row(u.after.health, 'Vertical datum'));
    check('ui:crs-journey', beforeOk && afterOk && u.assign5514Offered && u.pageErrors.length === 0 ? 'passed' : 'failed', {
      summary: `opened in the app: "${u.before.crs.slice(0, 110)}…"; after choosing EPSG:5514 in the section, without reopening: readiness "${row(u.after.health, 'Coordinate system')}", "${row(u.after.health, 'Vertical datum')}"; timings (measurements only) ${JSON.stringify(u.timingsMs)}; ${u.browser}${u.headless ? ' headless' : ''}, ${u.device}; not exercised: ${u.notDone.join(', ')}`,
      ...u,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check('ui:crs-journey', /Cannot find module|Executable doesn't exist/i.test(msg) ? 'unavailable' : 'failed', { summary: msg.split('\n')[0] });
  }
}

// ── 5. independent reader on OLV's exports ───────────────────────────────────
const exportNames = ['keep', 'catalogue', 'user', 'assign'];
const exportsRead = {};
for (const n of exportNames) {
  const las = join(work, `export-${n}.las`);
  if (!existsSync(las)) continue;
  const r = run(python, ['-I', join(HERE, 'reference.py'), 'las', las, work, `export-${n}`]);
  if (r.code === 0) exportsRead[n] = true;
  else check(`export:${n}:independent-read`, 'failed', { summary: 'laspy could not read the OLV export', log: r.out.slice(-2000) });
}

// ── 6. comparisons ───────────────────────────────────────────────────────────
const refC = loadCanonical('reference');
const H = ref.header;

/** The bound on the float64 -> float32 -> float64 residual for a path. */
function representationCheck(name, c, pathMeta) {
  const rep = c.meta.representation;
  const bound = [0, 1, 2].map((a) => float32HalfUlp(rep.maxAbsLocal[a]) + 4 * Number.EPSILON * Math.abs(H.max[a] - H.min[a] + Math.abs(H.min[a])));
  const within = rep.maxAbsError.every((e, a) => e <= bound[a]) && rep.maxAbsError.every((e, a) => e < H.scale[a] / 2);
  check(`${name}:representation`, within && rep.nonFinite === 0 && rep.ambiguousRounding === 0 ? 'passed' : 'failed', {
    summary: `max |error| ${rep.maxAbsError.map((e) => e.toExponential(2)).join(' / ')} m (X/Y/Z), float32 bound ${bound.map((e) => e.toExponential(2)).join(' / ')} m, half scale step ${H.scale[0] / 2} m; ${rep.nonFinite} non-finite`,
    ...rep, bound, origin: pathMeta?.origin ?? pathMeta?.renderOrigin,
  });
}

/**
 * Fields an OLV path does not read. The COPC streaming decode runs without
 * point semantics, so these are absent there; every other path reads all
 * canonical fields.
 */
const COPC_NOT_DECODED = ['userData', 'scanAngleRaw', 'scannerChannel', 'scanDirection', 'edgeOfFlightLine'];
const NOT_DECODED = { copc: COPC_NOT_DECODED, 'copc-reversed': COPC_NOT_DECODED };

/**
 * Compare `a` against the reference-side `b`. A field `b` has that `a` lacks
 * fails the check unless it is in `notDecoded`; those are reported as an
 * optional unsupported line.
 */
function compareCheck(id, a, b, notDecoded = []) {
  const r = compareCanonical(a, b, { notDecoded });
  const ok = r.multisetEqual && r.countA === H.pointCount && r.countB === H.pointCount;
  check(id, ok ? 'passed' : 'failed', {
    summary: `${r.countA} vs ${r.countB} records, ${r.mismatchedRecords} mismatched, ${r.coordinateMismatches} coordinate mismatches, duplicates ${r.duplicateRecordsA}/${r.duplicateRecordsB}; fields compared ${r.comparedFields.length}${r.missingFields.length ? `, missing: ${r.missingFields.join(', ')}` : ''}${r.notCompared.onlyA.length + r.notDecodedFields.length ? `, not compared: ${[...r.notCompared.onlyA, ...r.notDecodedFields].join(', ')}` : ''}`,
    ...r,
  });
  if (r.missingFields.length) check(`${id}:fields`, 'failed', { summary: `missing from this output although the path reads them: ${r.missingFields.join(', ')}` });
  if (r.notDecodedFields.length) check(`${id}:fields`, 'unsupported', { summary: `not decoded on this path: ${r.notDecodedFields.join(', ')}` }, false);
  return r;
}

for (const name of ['serial', 'fullfile', 'copc', 'copc-reversed', 'pooled']) {
  if (!existsSync(join(work, `${name}.json`))) {
    check(`olv:${name}`, name === 'pooled' && !pooledOk ? 'failed' : 'failed', { summary: 'no output from this path' });
    continue;
  }
  const c = loadCanonical(name);
  const m = c.meta;
  const boundsOk = [0, 1, 2].every((a) => m.integerBounds.min[a] === ref.integerBounds.min[a] && m.integerBounds.max[a] === ref.integerBounds.max[a]);
  check(`olv:${name}:population`, m.canonical.count === H.pointCount && boundsOk ? 'passed' : 'failed', {
    summary: `${m.canonical.count} points (header ${H.pointCount}); integer bounds ${boundsOk ? 'equal' : 'differ from'} the reference`,
    integerBounds: m.integerBounds,
  });
  representationCheck(`olv:${name}`, c, m);
  compareCheck(`olv:${name}:vs-reference`, c, refC, NOT_DECODED[name]);
  if (name === 'copc' || name === 'copc-reversed') {
    const h = m.hierarchy;
    const ok = h.isComplete && h.pageErrors === 0 && h.octreeErrors.length === 0 && h.distinctPageEntries === h.pageEntries
      && h.distinctNodeIds === h.dataNodes && h.overlappingByteRanges === 0 && h.hierarchyPointSum === H.pointCount
      && m.decodedNodes === h.dataNodes && m.shortNodes === 0 && m.decodedPoints === H.pointCount;
    check(`olv:${name}:nodes`, ok ? 'passed' : 'failed', {
      summary: `${h.dataNodes} data nodes on ${h.pages} hierarchy page(s), depth 0-${h.maxDepth}; ${m.decodedNodes} decoded once each; ${h.pageEntries - h.distinctPageEntries} duplicate keys, ${h.overlappingByteRanges} overlapping byte ranges, ${m.shortNodes} short nodes; hierarchy sum ${h.hierarchyPointSum}`,
      ...h, decodedNodes: m.decodedNodes, shortNodes: m.shortNodes,
    });
  }
  if (m.normals !== undefined || name.startsWith('copc')) {
    check(`olv:${name}:extra-dimensions`, 'unsupported', {
      summary: `NormalX/NormalY/NormalZ (float64 extra bytes) are not read into the cloud (normals ${m.normals ?? 'absent'})`,
    }, false);
  }
}
if (existsSync(join(work, 'serial.json')) && existsSync(join(work, 'pooled.json'))) compareCheck('olv:pooled:vs-serial', loadCanonical('pooled'), loadCanonical('serial'));
if (existsSync(join(work, 'serial.json')) && existsSync(join(work, 'copc.json'))) compareCheck('olv:copc:vs-serial', loadCanonical('copc'), loadCanonical('serial'), NOT_DECODED.copc);
if (existsSync(join(work, 'serial.json')) && existsSync(join(work, 'fullfile.json'))) compareCheck('olv:fullfile:vs-serial', loadCanonical('fullfile'), loadCanonical('serial'));
if (existsSync(join(work, 'copc.json')) && existsSync(join(work, 'copc-reversed.json'))) {
  const a = readJson(join(work, 'copc.json'));
  const b = readJson(join(work, 'copc-reversed.json'));
  const r = compareCanonical(loadCanonical('copc'), loadCanonical('copc-reversed'));
  check('olv:copc:colour-order-independent', r.multisetEqual && a.rgbEightBitDecision === b.rgbEightBitDecision ? 'passed' : 'failed', {
    summary: `first node ${a.firstNodeId} vs ${b.firstNodeId}: 8-bit-in-low-byte decision ${a.rgbEightBitDecision} vs ${b.rgbEightBitDecision}; ${r.mismatchedRecords} mismatched records (ArrayBufferRangeSource vs local File range source)`,
  });
}
if (existsSync(join(work, 'fullfile.json'))) {
  const f = readJson(join(work, 'fullfile.json'));
  check('colour:iphone-opening-mode', f.recommendedColour.mode === 'rgb' && f.rgbReadability.verdict === 'readable' ? 'passed' : 'failed', {
    summary: `RGB ${f.rgbReadability.verdict} (chromatic fraction ${f.rgbReadability.chromaticFraction}, luminance IQR ${f.rgbReadability.luminanceIqr}); opens in ${f.recommendedColour.mode}: "${f.recommendedColour.reason}"`,
  });
}
if (existsSync(join(work, 'negative-controls.json'))) {
  const n = readJson(join(work, 'negative-controls.json'));
  check('negative:cancelled-read', n.cancelled.threw && n.cancelled.code === 'aborted' ? 'passed' : 'failed', { summary: `${n.cancelled.name} (${n.cancelled.code})` });
  check('negative:range-past-end', n.rangePastEnd.threw && n.rangePastEnd.name === 'LoadError' ? 'passed' : 'failed', { summary: `${n.rangePastEnd.name}: ${n.rangePastEnd.message}` });
  check('negative:invalid-range', n.negativeOffset.threw && n.negativeOffset.code === 'out-of-range' ? 'passed' : 'failed', { summary: `${n.negativeOffset.name} (${n.negativeOffset.code})` });
  const t = n.truncated;
  check('negative:truncated-node-bytes', t.threw ? 'passed' : 'failed', {
    summary: t.threw
      ? `${t.name}: ${t.message}`
      : `decompressChunk + decodeRecords on half of node ${n.node}'s ${n.chunkBytes} bytes returned ${t.result.decodedPoints} of ${t.result.nodePoints} points, ${t.result.outsideHeaderBounds} outside the header bounds, and no error. The production read path refuses a short node range before decoding (CopcSource.readNodeChunk, boundedRead); the decoder itself cannot tell`,
    ...t,
  });
}

// Exports, as the independent reader sees them.
if (exportsRead.keep) {
  const e = loadCanonical('export-keep');
  const em = readJson(join(work, 'export-keep.json'));
  // Return number and number of returns are 0 on every source point; LAS
  // starts both at 1 and the writer raises 0 to 1 and records that. Compare
  // everything else exactly, then check the returns change is the recorded one.
  const RETURNS = ['returnNumber', 'returnCount'];
  const without = (c) => ({ ...c, fields: c.fields.filter((f) => !RETURNS.includes(f)) });
  compareCheck('export:keep:vs-reference', without(e), without(refC));
  {
    const sr = ref.standardDimensions;
    const er = em.standardDimensions;
    const srcZero = sr.return_number.max === 0 && sr.number_of_returns.max === 0;
    const raised = er.return_number.min === 1 && er.return_number.max === 1 && er.number_of_returns.min === 1 && er.number_of_returns.max === 1;
    const event = /Conversion event return-zero-raised/.test(em.textArea ?? '');
    const logged = (readJson(join(work, 'crs.json')).exports.keep.log ?? []).some((l) => /2,207,759 points have return number or number of returns 0/.test(l));
    check('export:keep:returns', srcZero && raised && event && logged ? 'passed' : 'failed', {
      summary: `source return number and number of returns are 0 on every point; export writes ${er.return_number.min}-${er.return_number.max} and ${er.number_of_returns.min}-${er.number_of_returns.max}; recorded in the export log ${logged ? 'yes' : 'no'} and the file's text area ${event ? 'yes' : 'no'}`,
    });
  }
  const sameQ = em.header.scale.every((s, a) => s === H.scale[a]) && em.header.offset.every((o, a) => o === H.offset[a]);
  check('export:keep:quantisation', sameQ ? 'passed' : 'failed', { summary: `scale ${em.header.scale.join('/')}, offset ${em.header.offset.join('/')} (source ${H.scale.join('/')}, ${H.offset.join('/')})` });
  const rgbChanged = ref.rgb && em.rgb ? 'source stores 8-bit colour as v*256 (low byte always 0); OLV keeps 8 bits and writes v*257, so every non-zero 16-bit value differs by v while the 8-bit value is unchanged' : '';
  check('export:keep:conversions', 'passed', {
    summary: `PDRF ${H.pointFormat} -> ${em.header.pointFormat}, LAS ${em.header.version}; ${rgbChanged}; COPC structure, NormalX/Y/Z extra bytes and the qgis statistics EVLR are not written`,
    sourceRgb: ref.rgb, exportRgb: em.rgb, exportExtraDimensions: em.extraDimensions, exportVlrs: em.vlrs, exportEvlrs: em.evlrs,
  }, false);
  check('export:keep:rgb16', ref.rgb.lowByteNonZeroValues === 0 && em.rgb.times257Values === em.rgb.values ? 'passed' : 'failed', {
    summary: `source 16-bit RGB: max ${ref.rgb.max16}, low byte non-zero in ${ref.rgb.lowByteNonZeroValues} of ${ref.rgb.values} values; export 16-bit RGB: max ${em.rgb.max16}, ${em.rgb.times257Values} of ${em.rgb.values} values are v*257. With the 8-bit values equal, export16 = (source16 >> 8) * 257 for every value`,
  });
  check('export:keep:extra-dimensions', em.extraDimensions.length === 0 ? 'unsupported' : 'failed', {
    summary: `source extra dimensions ${ref.extraDimensions.map((d) => d.name).join(', ')}; export carries ${em.extraDimensions.length ? em.extraDimensions.map((d) => d.name).join(', ') : 'none'}, so the round trip is not lossless`,
  }, false);
  for (const n of ['catalogue', 'user', 'assign']) {
    if (!exportsRead[n]) continue;
    compareCheck(`export:${n}:coordinates-unmoved`, loadCanonical(`export-${n}`), e);
  }
}

// CRS.
const crsPath = join(work, 'crs.json');
if (existsSync(crsPath)) {
  const crs = readJson(crsPath);
  const r = crs.resolved;
  check('crs:original-unresolved', crs.declaredInFile === null && r.fromFile.kind === 'unknown' && r.fromFile.epsg === undefined ? 'passed' : 'failed', {
    summary: `file declares ${crs.declaredInFile ? JSON.stringify(crs.declaredInFile) : 'no CRS'} (empty WKT record); resolves to ${r.fromFile.kind}/${r.fromFile.source}; no EPSG taken from the name, magnitudes or description`,
    fromFile: r.fromFile,
  });
  check('crs:stored-catalogue-record-not-applied', r.catalogueRecordOnLocalFile.kind === 'unknown' ? 'passed' : 'failed', {
    summary: `a stored catalogue record for the same name resolves ${r.catalogueRecordOnLocalFile.kind}/${r.catalogueRecordOnLocalFile.source} on a file opened from disk`,
  });
  const cat = r.fromCatalogue;
  check('crs:publisher-assertion', cat.epsg === 5514 && cat.source === 'catalog-tile' && cat.assertedBy === crs.publisherAssertion && cat.userConfirmed === false ? 'passed' : 'failed', {
    summary: `EPSG:${cat.epsg}, source ${cat.source}, asserted by "${cat.assertedBy}", confidence ${cat.confidence}, user-confirmed ${cat.userConfirmed}`,
    fromCatalogue: cat,
  });
  const u = r.fromUser;
  check('crs:user-override', u.epsg === 5514 && u.source === 'user-override' && u.userConfirmed === true && !u.assertedBy ? 'passed' : 'failed', {
    summary: `EPSG:${u.epsg}, source ${u.source}, user-confirmed ${u.userConfirmed}`,
    fromUser: u,
  });
  check('crs:label-does-not-move-points', crs.positionsSha256Before === crs.positionsSha256After && JSON.stringify(crs.originBefore) === JSON.stringify(crs.originAfter) ? 'passed' : 'failed', {
    summary: 'cloud positions and origin byte-identical before and after resolving and exporting under each CRS',
  });
  const m = crs.measurement;
  check('crs:measurement-eligibility', m.fromFile.groundMetresPermitted === false && m.fromCatalogue.groundMetresPermitted && m.fromUser.groundMetresPermitted ? 'passed' : 'failed', {
    summary: `ground-metre claims permitted: unresolved ${m.fromFile.groundMetresPermitted}, publisher assertion ${m.fromCatalogue.groundMetresPermitted}, user override ${m.fromUser.groundMetresPermitted}`,
    ...m,
  });
  const s = crs.session;
  check('crs:session-keeps-source', s.catalogue?.source === 'catalog-tile' && s.catalogue?.assertedBy === crs.publisherAssertion && s.user?.source === 'user-override' && s.unresolved?.kind === 'unknown' ? 'passed' : 'failed', {
    summary: `session read-back: catalogue ${s.catalogue?.source} (${s.catalogue?.assertedBy ?? 'no asserting party'}), override ${s.user?.source}, original ${s.unresolved?.kind}`,
    session: s,
  });
  for (const n of exportNames) {
    if (!exportsRead[n]) continue;
    const em = readJson(join(work, `export-${n}.json`));
    const wkt5514 = typeof em.wkt === 'string' && /Krovak/i.test(em.wkt);
    const vertical = typeof em.wkt === 'string' && /VERT_CS|VERTCRS|COMPD_CS|COMPOUNDCRS/i.test(em.wkt);
    if (vertical) check(`crs:export-${n}-vertical`, 'failed', { summary: 'the export declares a vertical CRS the input does not establish' });
    const line = (em.textArea ?? '').split('\n').find((l) => l.startsWith('CRS source')) ?? '';
    const expect = { keep: [!wkt5514, /default-assumption/.test(line)], catalogue: [wkt5514, /catalog-tile \(Zenodo/.test(line)], user: [wkt5514, /user-override/.test(line)], assign: [wkt5514, true] }[n];
    check(`crs:export-${n}`, expect.every(Boolean) ? 'passed' : 'failed', {
      summary: `WKT ${wkt5514 ? 'EPSG:5514 written' : 'not written'}${wkt5514 ? (vertical ? ', with a vertical CRS' : ', horizontal only') : ''}; text area "${line}"`,
      exportLog: crs.exports[n],
    });
  }
  if (exportsRead.assign) {
    const em = readJson(join(work, 'export-assign.json'));
    const says = /Conversion event crs-assigned: EPSG:5514 assigned at export/.test(em.textArea ?? '');
    check('crs:export-assign-states-assignment', says ? 'passed' : 'failed', {
      summary: says ? 'the export text area records that EPSG:5514 was assigned at export' : 'the export carries EPSG:5514 WKT but its text area does not say the CRS was assigned at export',
    });
  }
} else {
  check('crs:original-unresolved', 'failed', { summary: 'no CRS output from the Node run' });
}

// Optional extended experiment: LA03 colour readability needs the 202 MB file.
const la03 = join(dataRoot, 'zenodo', RECORD, 'LA03mapry.laz');
check('optional:la03-rgb-readability', 'skipped', {
  summary: `not run here; tests/zenodoLa03ColourObserved.test.ts runs on 2,000 committed LA03 records, and scripts/zenodo-study/extract-la03-fixture.py re-extracts them (${existsSync(la03) ? 'LA03mapry.laz is cached' : 'LA03mapry.laz not cached'})`,
}, false);

finish();
