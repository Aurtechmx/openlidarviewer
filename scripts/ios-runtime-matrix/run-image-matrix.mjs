#!/usr/bin/env node
/**
 * run-image-matrix.mjs — the body of one `ios-runtime-matrix.yml` job.
 *
 * One image (a `runs-on` value) is fixed by the workflow's own matrix; what
 * this script varies is the runtime, inside that one job, in a plain loop
 * rather than a second GitHub Actions matrix dimension. A dimension has to
 * be known before any job starts, but which runtimes an image ships is only
 * knowable on that image, so a static list would drift the moment GitHub
 * rotates one out — this asks the runner instead, every time.
 *
 * Two pages are opened per runtime: a bare WebGL triangle, and the OLV
 * build. The triangle is the control — if it also dies, the fault is the
 * image's GPU translation and not anything OLV does; if only OLV dies, the
 * crash is narrower than "any WebGL" and worth chasing inside the app.
 *
 * A crash here is a finding, not a bug in this script. The exit code stays
 * 0 through however many cells crash; it only turns nonzero when the script
 * itself could not do its job — no runtime discovered, or a simulator that
 * refused to boot at all.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { pickCells } from './discover-cells.mjs';

/**
 * Markers this leg has actually seen name a real crash: the paravirtual GPU
 * driver dying, the WebKit GPU process going down with it, or the simulator
 * itself reporting a terminated/crashed process. A loose `/error|fault/i`
 * scan matched ordinary log noise too, so this list is deliberately closed
 * rather than broadened; a marker not on it should be added here, not
 * covered by loosening the pattern back out.
 */
const CRASH_MARKER_RE = /AppleParavirt|SIGABRT|Trace\/BPT|\bcrashed\b|\bCorpse\b|gpuProcessExited|XPC_ERROR_CONNECTION_INTERRUPTED|metal\(21\)/;

/**
 * Apple's unified-log text puts the level as the fourth whitespace-separated
 * field (date, time, thread id, level, ...). The run this fix was written
 * against showed why that field matters as much as the marker text: every
 * "Default"-level line reading plain "Default" was the confirmed false
 * positive named in the brief, and a routine MobileSafari XPC reconnect that
 * happens to say `XPC_ERROR_CONNECTION_INTERRUPTED` while reporting its own
 * success is a second one, on a marker this file names deliberately. Both
 * are noise levels a real crash is not filed under.
 */
const NOISE_LEVELS = new Set(['Default', 'Info', 'Debug']);
function isCrashLine(line) {
  return CRASH_MARKER_RE.test(line) && !NOISE_LEVELS.has(line.trim().split(/\s+/)[3]);
}

const IMAGE = process.env.OLV_IMAGE ?? 'unknown-image';
const OLV_URL = process.env.OLV_BASE_URL ?? 'http://127.0.0.1:4173/?test=1';
const TRIANGLE_URL = process.env.OLV_TRIANGLE_URL ?? 'http://127.0.0.1:4174/webgl-triangle.html';
const MARKER_LOG = resolve(process.env.OLV_MARKER_LOG ?? 'triangle-marker.log');
const EVIDENCE_DIR = resolve(process.env.OLV_EVIDENCE_DIR ?? 'evidence');
const WAIT_MS = Number(process.env.OLV_CELL_WAIT_MS ?? 60000);
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;

mkdirSync(EVIDENCE_DIR, { recursive: true });
if (!existsSync(MARKER_LOG)) writeFileSync(MARKER_LOG, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a host command; never throws, so one bad probe cannot stop the cell. */
function sh(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', ...opts }) };
  } catch (err) {
    return { ok: false, out: (err.stdout ?? '') + (err.stderr ?? ''), error: err.message };
  }
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * `log show`'s `--start`, five seconds before `sinceMs` as a pre-roll for
 * flush latency. `--last 5m` used to stand in its place, and the run this
 * fix was written against showed the cost of that: two cells run inside the
 * same five minutes share a host-wide `log show`, so an error from one
 * turned up, timestamp and all, in the other's evidence. Scoping the window
 * to this phase's own run is what makes a crash signature belong to the
 * cell it is filed under.
 */
function logStartArg(sinceMs) {
  return new Date(sinceMs - 5000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Drives one page on one already-booted simulator and grades what happened.
 * Every check below is optional evidence, not a precondition for the next
 * one — a dead Safari should still leave a screenshot and a log, not abort
 * the cell.
 */
async function runPhase(udid, cellSlug, phase, url, { expectMarker } = {}) {
  const markerLenBefore = readFileSync(MARKER_LOG, 'utf8').length;
  const phaseStartMs = Date.now();

  const opened = sh('xcrun', ['simctl', 'openurl', udid, url]);
  // The exact failure text, not just pass/fail: this is the only record of
  // *why* `openurl` refused on a runtime like iOS 18.2, and the pass/fail
  // boolean alone throws that reason away.
  const openError = opened.ok ? null : ((opened.error || opened.out || 'openurl failed').trim());
  await sleep(WAIT_MS);

  const launchctl = sh('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list']);
  const safariAlive = launchctl.ok && /mobilesafari/i.test(launchctl.out);

  const since = logStartArg(phaseStartMs);
  const hostLog = sh('log', ['show', '--start', since, '--predicate', 'process == "SimMetalHost"']);
  const hostLogPath = resolve(EVIDENCE_DIR, `${cellSlug}-${phase}-simmetalhost.log`);
  writeFileSync(hostLogPath, hostLog.out ?? '');

  const simLog = sh('xcrun', [
    'simctl', 'spawn', udid, 'log', 'show', '--start', since, '--predicate',
    'process == "MobileSafari" OR process == "WebContent" OR processImagePath CONTAINS "WebKit"',
  ]);
  writeFileSync(resolve(EVIDENCE_DIR, `${cellSlug}-${phase}-simulator.log`), simLog.out ?? '');

  // Checked across both logs: the host side names the paravirtual driver
  // fault, the simulator side names WebKit's own response to it, and a
  // signature from either is equally real evidence of a crash.
  const crashSignature = [...(hostLog.out ?? '').split('\n'), ...(simLog.out ?? '').split('\n')]
    .find(isCrashLine) ?? null;

  const screenshotPath = resolve(EVIDENCE_DIR, `${cellSlug}-${phase}.png`);
  sh('xcrun', ['simctl', 'io', udid, 'screenshot', screenshotPath]);

  let markerSeen = null;
  if (expectMarker) {
    const markerNow = readFileSync(MARKER_LOG, 'utf8');
    const appended = markerNow.slice(markerLenBefore);
    markerSeen = /ok=1/.test(appended) ? true : (appended.length > 0 ? false : null);
  }

  return {
    phase,
    url,
    opened: opened.ok,
    openError,
    safariAlive,
    markerSeen,
    crashSignature,
    screenshot: screenshotPath,
    hostLog: hostLogPath,
  };
}

async function runCell(cell) {
  const cellSlug = slug(`${IMAGE}-${cell.runtimeVersion}`);
  const simName = `olv-matrix-${cellSlug}`;
  console.log(`\n=== ${IMAGE} / ${cell.runtimeName} (${cell.deviceTypeName}) ===`);

  const created = sh('xcrun', ['simctl', 'create', simName, cell.deviceTypeId, cell.runtimeId]);
  if (!created.ok) {
    return { image: IMAGE, cell, setupError: `create failed: ${created.error}` };
  }
  const udid = created.out.trim();

  const booted = sh('xcrun', ['simctl', 'boot', udid]);
  const bootstatus = sh('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  if (!bootstatus.ok && !/already booted/i.test(booted.out ?? '')) {
    sh('xcrun', ['simctl', 'delete', udid]);
    return { image: IMAGE, cell, udid, setupError: `boot failed: ${bootstatus.error}` };
  }

  const webgl = await runPhase(udid, cellSlug, 'webgl', TRIANGLE_URL, { expectMarker: true });
  // OLV_URL carries `&autoload=tiny.las` (see the workflow): the page fetches
  // that fixture, hands it to the same function a real drop calls, and pings
  // this same marker log once Viewer.onDrawnFrame fires — a real post-load
  // render, not the triangle's proxy for one.
  const olv = await runPhase(udid, cellSlug, 'olv', OLV_URL, { expectMarker: true });

  sh('xcrun', ['simctl', 'shutdown', udid]);
  sh('xcrun', ['simctl', 'delete', udid]);

  return { image: IMAGE, cell, udid, webgl, olv };
}

function verdict(phase) {
  if (!phase) return 'n/a';
  if (phase.markerSeen === true) return 'survived';
  if (phase.safariAlive === false) return 'crashed';
  if (phase.markerSeen === false) return 'no marker (unclear)';
  return phase.safariAlive ? 'survived' : 'crashed';
}

function summaryRow(result) {
  const { cell } = result;
  if (result.setupError) {
    return `| ${IMAGE} | ${cell.runtimeName} | ${cell.deviceTypeName} | setup error | setup error | ${result.setupError} |`;
  }
  const openErrors = [result.webgl.openError, result.olv.openError].filter(Boolean).join(' / ');
  const sig = openErrors || result.webgl.crashSignature || result.olv.crashSignature || '';
  return `| ${IMAGE} | ${cell.runtimeName} | ${cell.deviceTypeName} | ${verdict(result.webgl)} | ${verdict(result.olv)} | ${sig.slice(0, 140).replace(/\|/g, '/')} |`;
}

async function main() {
  const runtimeList = sh('xcrun', ['simctl', 'list', 'runtimes', '-j']);
  if (!runtimeList.ok) {
    console.error(`could not list runtimes: ${runtimeList.error}`);
    process.exitCode = 1;
    return;
  }
  const cells = pickCells(JSON.parse(runtimeList.out));
  if (cells.length === 0) {
    console.error(`no usable iOS runtime found on ${IMAGE}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${IMAGE}: testing ${cells.length} runtime(s): ${cells.map((c) => c.runtimeName).join(', ')}`);

  const results = [];
  for (const cell of cells) {
    // eslint-disable-next-line no-await-in-loop -- cells share one Safari; concurrent boots would fight over it
    results.push(await runCell(cell));
  }

  writeFileSync(resolve(EVIDENCE_DIR, `${slug(IMAGE)}-results.json`), `${JSON.stringify(results, null, 2)}\n`);

  const rows = results.map(summaryRow).join('\n');
  console.log(`\n${rows}`);
  if (SUMMARY_FILE) {
    appendFileSync(SUMMARY_FILE, `\n### ${IMAGE}\n\n| image | runtime | device | WebGL triangle | OLV build | crash signature |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n`);
  }
}

await main();
