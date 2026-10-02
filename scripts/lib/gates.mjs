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
 * Load scripts/gates.json and check it with {@link validateGates}.
 *
 * @param {Record<string,string>} [scripts] package.json scripts, for the
 *   existence check; omitted, it is read from ROOT.
 * @returns {{ steps: Array<{script:string, group?:string, after:string[], needs:string[], tags:string[]}> }}
 */
export function loadGates(scripts) {
  const raw = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const pkgScripts =
    scripts ?? JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts;
  return validateGates(raw, pkgScripts);
}

/**
 * Reject a manifest the runner could not schedule: an unknown or duplicated
 * script, a group reference that names no group, or a dependency that is not
 * an EARLIER step. Array order is the serial order, so every dependency must
 * come before its dependent.
 *
 * The earlier-step check runs after `@group` is expanded with
 * {@link directDeps}, the same expansion the scheduler and mustPrecede use. A
 * step that waits for its own group, or for a group with a member at or after
 * it, would otherwise wait on itself or form a cycle. Checking after the
 * expansion also rejects every cycle, since a cycle needs a dependency on a
 * step at or after its dependent.
 *
 * @param {{steps: Array<object>}} raw the parsed manifest
 * @param {Record<string,string>} pkgScripts package.json scripts
 */
export function validateGates(raw, pkgScripts) {
  const problems = [];
  const seen = new Set();
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
    seen.add(step.script);
    return step;
  });
  const gates = { steps };
  const position = new Map(steps.map((s, i) => [s.script, i]));
  const groups = new Set(steps.map((s) => s.group).filter(Boolean));
  steps.forEach((step, i) => {
    for (const ref of new Set([...step.after, ...step.needs])) {
      const group = ref.startsWith('@') ? ref.slice(1) : null;
      if (group !== null && !groups.has(group)) {
        problems.push(`${step.script} waits for group ${ref}, which no step belongs to`);
        continue;
      }
      if (group === null && !position.has(ref)) {
        problems.push(`${step.script} depends on ${ref}, which is not a step`);
        continue;
      }
      const via = group === null ? '' : ` through group ${ref}`;
      for (const dep of directDeps({ after: [ref], needs: [] }, gates)) {
        const at = position.get(dep);
        if (dep === step.script) problems.push(`${step.script} depends on itself${via}`);
        else if (at > i) problems.push(`${step.script} depends on ${dep}${via}, which is a later step`);
      }
    }
  });
  if (problems.length > 0) {
    throw new Error(`scripts/gates.json is not schedulable:\n  ${problems.join('\n  ')}`);
  }
  return gates;
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
