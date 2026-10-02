/**
 * capabilityManifestLint.test.ts: scripts/lint-capability-manifest.mjs is green
 * on the committed tree and rejects each rule's must-flag input by rule id.
 * Every case edits a copy of the manifest or a scratch document in a temp
 * directory, so the committed files are never touched.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'docs/validation/capability-manifest.json');
const TMP = mkdtempSync(join(tmpdir(), 'olv-capmanifest-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync('node', ['scripts/lint-capability-manifest.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });

let n = 0;
function withManifest(edit: (doc: any) => void, ...extra: string[]) {
  const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  edit(doc);
  const file = join(TMP, `manifest-${n++}.json`);
  writeFileSync(file, JSON.stringify(doc));
  return run('--manifest', file, ...extra);
}

function doc(text: string): string {
  const file = join(TMP, `doc-${n++}.md`);
  writeFileSync(file, text);
  return file;
}

const find = (d: any, id: string) => d.capabilities.find((c: any) => c.id === id);

describe('lint:capability-manifest', () => {
  it('passes on the committed tree', () => {
    const r = run();
    expect(r.stdout).toContain('lint:capability-manifest OK');
    expect(r.status).toBe(0);
  });

  it('M1 flags an unknown status and a duplicate id', () => {
    const r = withManifest((d) => {
      find(d, 'navigation').status = 'beta';
      d.capabilities.push({ ...find(d, 'themes') });
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M1 navigation: status "beta"');
    expect(r.stderr).toContain('M1 themes: duplicate id');
  });

  it('M1 flags a capability with no backing module', () => {
    const r = withManifest((d) => { find(d, 'themes').modules = []; });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M1 themes: no backing module');
  });

  it('M2 flags a backing module that does not exist', () => {
    const r = withManifest((d) => { find(d, 'themes').modules = ['src/ui/NoSuchPanel.ts']; });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M2 themes: backing module src/ui/NoSuchPanel.ts');
  });

  it('M3 flags an unreachable module listed as stable or preview', () => {
    const stable = withManifest((d) => { find(d, 'tie-point-registration').status = 'stable'; });
    expect(stable.status).toBe(1);
    expect(stable.stderr).toContain('M3 tie-point-registration: stable capability rests on unreachable module src/registration/generalIcp.ts');
    const preview = withManifest((d) => { find(d, 'qa-service').status = 'preview'; });
    expect(preview.status).toBe(1);
    expect(preview.stderr).toContain('M3 qa-service: preview capability rests on unreachable module src/qa/QaService.ts');
  });

  it('M3 counts an unreachable file under a listed directory', () => {
    const r = withManifest((d) => { find(d, 'navigation').modules.push('src/registration'); });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M3 navigation: stable capability rests on unreachable module src/registration/');
  });

  it('M3 accepts an unreachable module under a hidden capability', () => {
    const r = withManifest(() => {});
    expect(r.status).toBe(0);
  });

  it('M4 flags a claim missing from the claim register', () => {
    const r = withManifest((d) => { find(d, 'measurement').claims.push('MEAS-TELEPATHY'); });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M4 measurement: claim MEAS-TELEPATHY');
  });

  it('M5 flags an interface label the named file does not carry', () => {
    const r = withManifest((d) => { find(d, 'flow-pulse-lab').uiLabel.text = 'Flow Pulse (Beta)'; });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M5 flow-pulse-lab');
  });

  it('M6 flags a hidden capability with no docTerms', () => {
    const r = withManifest((d) => { delete find(d, 'qa-service').docTerms; });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M6 qa-service');
  });

  it('M7 flags a public document that offers a hidden capability', () => {
    const file = doc('# Guide\n\nAlign two scans with tie-point registration from the Work rail.\n');
    const r = run('--docs', file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M7');
    expect(r.stderr).toContain('tie-point-registration');
  });

  it('M7 accepts a paragraph that states the code is not reachable', () => {
    const file = doc('# Guide\n\nTie-point registration is staged for a later release and is not reachable in this build.\n');
    expect(run('--docs', file).status).toBe(0);
  });

  it('M7 does not let a qualifier about one capability excuse a claim about another', () => {
    const file = doc('# Guide\n\nThe QA service is staged.\n\n## Aligning scans\n\nUse tie-point registration today.\n');
    const r = run('--docs', file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M7');
    expect(r.stderr).toContain('tie-point-registration');
    expect(r.stderr).not.toContain('qa-service');
  });

  it('M7 does not let a qualifier in the opening lines excuse a later paragraph', () => {
    const file = doc('# The Continuity Field\n\nEverything here describes code that is present and switched off.\n\n## Detail\n\nThe Continuity Field closes holes between samples.\n');
    const r = run('--docs', file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('continuity-field');
  });

  it('M7 flags a claim that shares a paragraph with a qualifier about another capability', () => {
    const file = doc('The QA service is staged. Use tie-point registration today.\n');
    const r = run('--docs', file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tie-point-registration');
  });

  it('M7 accepts qualifications about the same capability', () => {
    const file = doc([
      '# The Continuity Field',
      '',
      'The Continuity Field is present and switched off in this build.',
      '',
      'The Continuity Field closes holes between samples. It is not reachable from the application.',
      '',
      'The QA service is staged, and tie-point registration is not yet offered.',
      '',
    ].join('\n'));
    expect(run('--docs', file).status).toBe(0);
  });

  it('M7 does not accept a pronoun qualifier in a paragraph naming two hidden capabilities', () => {
    const file = doc('The QA service checks scans. Tie-point registration aligns them. It is staged.\n');
    const r = run('--docs', file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('qa-service');
    expect(r.stderr).toContain('tie-point-registration');
  });

  it('M7 reads headings as names, not claims', () => {
    const file = doc('# Tie-point registration\n\nTie-point registration is not reachable in this build.\n');
    expect(run('--docs', file).status).toBe(0);
  });

  it('M8 flags a listed document that does not exist', () => {
    const r = run('--docs', join(TMP, 'missing.md'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('M8');
  });

  it('reads an explicit current document list that leaves release history out', async () => {
    // @ts-expect-error - plain .mjs script, no types
    const { CURRENT_DOCS } = await import('../scripts/lint-capability-manifest.mjs');
    expect(CURRENT_DOCS).toContain('README.md');
    expect(CURRENT_DOCS).toContain('docs/observatory/methods.md');
    expect(CURRENT_DOCS).toContain('src/observation/README.md');
    for (const d of CURRENT_DOCS) {
      expect(d.startsWith('docs/releases/') || d.startsWith('docs/release/') || d === 'CHANGELOG.md').toBe(false);
    }
  });

  it('keeps the observation overlay hidden and lists station suggestion apart', () => {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    expect(find(m, 'observation-overlay').status).toBe('hidden');
    expect(find(m, 'observation-overlay').modules).toEqual(['src/render/observation/ObservationPointOverlay.ts']);
    expect(find(m, 'station-suggestion').modules).toContain('src/observation/stationSuggestion.ts');
    expect(find(m, 'station-suggestion').status).toBe('preview');
  });

  it('M7 accepts a document that names no hidden capability', () => {
    const file = doc('# Guide\n\nMeasure a distance between two points.\n');
    expect(run('--docs', file).status).toBe(0);
  });
});
