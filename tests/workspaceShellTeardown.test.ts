/**
 * workspaceShellTeardown.test.ts
 *
 * The workspace shell registers two listeners on the phone-layout media query.
 * The query object outlives the shell, so each listener must be removed by a
 * teardown, or a remounted shell keeps flipping the layout of a disposed one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHELL = readFileSync(resolve(__dirname, '../src/app/workspace/workspaceShell.ts'), 'utf8');

describe('workspace shell media-query listeners', () => {
  it('every change listener on the layout query has a matching removal in a teardown', () => {
    const added = [...SHELL.matchAll(/mobileMql\?\.addEventListener\('change', (\w+)\)/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(0);
    const teardowns = [...SHELL.matchAll(/addTeardown\(\(\) => \{([\s\S]*?)\n  \}\);/g)].map((m) => m[1]).join('\n');
    for (const fn of added) {
      expect(teardowns, fn).toContain(`mobileMql?.removeEventListener('change', ${fn})`);
    }
  });
});
