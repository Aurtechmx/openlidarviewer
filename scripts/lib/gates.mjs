/**
 * scripts/lib/gates.mjs — read and check scripts/gates.json, the step list of
 * `npm run test:release:execute`.
 *
 * Shared by scripts/run-gates.mjs (which runs it) and by every lint or test
 * that asks "does the release chain run X, and before Y?". Those used to split
 * the `&&` string in package.json; the manifest is now the one place the chain
 * lives, so they must ask here rather than keep a second parser.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST = resolve(ROOT, 'scripts/gates.json');

/**
 * Load the manifest and reject anything the runner could not schedule: an
 * unknown or duplicated script, a dependency that is not declared EARLIER in
 * the array (array order is the serial order, so it must be a valid schedule),
 * or a group reference that names no group.
 *
 * @param {Record<string,string>} [scripts] package.json scripts, for the
 *   existence check; omitted, it is read from ROOT.
 * @returns {{ steps: Array<{script:string, group?:string, after:string[], needs:string[], tags:string[]}> }}
 */
export function loadGates(scripts) {
  const raw = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const pkgScripts =
    scripts ?? JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts;
  const problems = [];
  const seen = new Set();
  const groups = new Set();
  const steps = raw.steps.map((s, i) => {
    const step = {
      script: s.script,
      group: s.group,
      after: s.after ?? [],
      needs: s.needs ?? [],
      tags: s.tags ?? [],
    };
    if (typeof step.script !== 'string') problems.push(`step ${i + 1} has no script`);
    else if (!(step.script in pkgScripts)) problems.push(`${step.script} is not a package.json script`);
    if (seen.has(step.script)) problems.push(`${step.script} is listed twice`);
    for (const dep of [...step.after, ...step.needs]) {
      if (dep.startsWith('@')) {
        if (!groups.has(dep.slice(1))) problems.push(`${step.script} waits for group ${dep}, which no earlier step belongs to`);
      } else if (!seen.has(dep)) {
        problems.push(`${step.script} depends on ${dep}, which is not an earlier step`);
      }
    }
    seen.add(step.script);
    if (step.group) groups.add(step.group);
    return step;
  });
  if (problems.length > 0) {
    throw new Error(`scripts/gates.json is not schedulable:\n  ${problems.join('\n  ')}`);
  }
  return { steps };
}

/** Script names in serial (`--serial`) order. */
export function serialOrder(gates = loadGates()) {
  return gates.steps.map((s) => s.script);
}

/** Direct dependencies of a step, with `@group` expanded to its members. */
export function directDeps(step, gates) {
  const out = new Set();
  for (const dep of [...step.after, ...step.needs]) {
    if (dep.startsWith('@')) {
      for (const s of gates.steps) if (s.group === dep.slice(1)) out.add(s.script);
    } else {
      out.add(dep);
    }
  }
  return out;
}

/**
 * True when the runner guarantees `first` finishes before `second` starts, in
 * parallel mode as well as serial: `first` is a transitive dependency of
 * `second`. Position in the array alone is NOT enough, because two members of
 * one group run concurrently.
 */
export function mustPrecede(first, second, gates = loadGates()) {
  const byName = new Map(gates.steps.map((s) => [s.script, s]));
  const start = byName.get(second);
  if (!start || !byName.has(first)) return false;
  const stack = [...directDeps(start, gates)];
  const visited = new Set();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === first) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    stack.push(...directDeps(byName.get(cur), gates));
  }
  return false;
}
