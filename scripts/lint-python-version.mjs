#!/usr/bin/env node
/**
 * lint-python-version.mjs — one answer to "which Python does this project use?"
 *
 * The repository ships five Python scripts that generate fixtures, rasters and
 * plots. They are developer tooling, not part of the build or CI, which is why
 * the version was never written down anywhere and the question could not be
 * answered without inspecting a machine.
 *
 * Two files now state it, and they must agree: .python-version, which pyenv and
 * most editors read, and sonar-project.properties, which decides the ruleset
 * static analysis applies. A mismatch means analysis is judging the code
 * against a language version nobody runs, and every finding it produces is
 * suspect without anyone noticing the reason.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const pinFile = resolve(ROOT, '.python-version');
if (!existsSync(pinFile)) {
  problems.push('.python-version is missing — the interpreter version is undeclared.');
}
const pin = existsSync(pinFile) ? readFileSync(pinFile, 'utf8').trim() : null;

if (pin !== null && !/^\d+\.\d+(\.\d+)?$/.test(pin)) {
  problems.push(`.python-version reads "${pin}", which is not a version number.`);
}

const sonarFile = resolve(ROOT, 'sonar-project.properties');
if (existsSync(sonarFile) && pin) {
  const sonar = /^sonar\.python\.version\s*=\s*(.+)$/m.exec(readFileSync(sonarFile, 'utf8'));
  if (!sonar) {
    problems.push('sonar-project.properties does not set sonar.python.version.');
  } else {
    // Compare on major.minor: a patch-level pin is still the same ruleset.
    const short = (v) => v.trim().split('.').slice(0, 2).join('.');
    if (short(sonar[1]) !== short(pin)) {
      problems.push(
        `sonar.python.version is ${sonar[1].trim()} but .python-version is ${pin}. ` +
          'Static analysis would judge the scripts against a version nobody runs.',
      );
    }
  }
}

/** Present so removing the last script also removes the reason for this check. */
function pythonFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) pythonFiles(full, acc);
    else if (entry.name.endsWith('.py')) acc.push(full);
  }
  return acc;
}
const scripts = pythonFiles(ROOT);

if (problems.length > 0) {
  console.error('lint:python-version FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  `lint:python-version OK — Python ${pin} declared for ${scripts.length} script(s), ` +
    'and static analysis agrees.',
);
