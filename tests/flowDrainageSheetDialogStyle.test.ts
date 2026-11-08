/**
 * Every class the drainage sheet controls use has a style rule, so the
 * dialog and its button never fall back to browser defaults.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STYLES = join(process.cwd(), 'src', 'styles');
const css = readdirSync(STYLES).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(STYLES, f), 'utf8')).join('\n');
const sources = [
  readFileSync(join(process.cwd(), 'src', 'ui', 'fieldSimulation', 'flowDrainageSheetDialog.ts'), 'utf8'),
  readFileSync(join(process.cwd(), 'src', 'ui', 'fieldSimulation', 'flowPulseLab.ts'), 'utf8'),
].join('\n');

describe('drainage sheet controls are styled', () => {
  const classes = [...new Set([...sources.matchAll(/olv-flow-drainage[a-z-]*/g)].map((m) => m[0]))];
  it('finds the classes', () => {
    expect(classes).toContain('olv-flow-drainage-dialog');
    expect(classes).toContain('olv-flow-drainage-sheet');
  });
  it.each(classes)('%s has a rule', (c) => {
    expect(css).toMatch(new RegExp(`\\.${c}(?![a-z-])`));
  });
});
