/**
 * The post-build checks (test seam, dev flags, CSP) run on the directory that
 * ships: package.sh runs them on the staged copy before zipping, and
 * smoke-deploy-zip.mjs on the extraction of the finished archive.
 */
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEPLOY_CHECKS, runDeployChecks } from '../scripts/check-deploy-output.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal clean deploy directory: the source index.html and policies, one clean bundle. */
function deployDir(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'olv-deploy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), read('index.html'));
  writeFileSync(join(dir, '_headers'), read('public/_headers'));
  writeFileSync(join(dir, '.htaccess'), read('public/.htaccess'));
  writeFileSync(join(dir, 'credits.html'), read('public/credits.html'));
  writeFileSync(join(dir, 'credits.css'), read('public/credits.css'));
  writeFileSync(join(dir, 'assets', 'index-abcd1234.js'), 'console.log("clean bundle");\n');
  for (const [name, text] of Object.entries(extra)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const failing = (dir: string): string[] => runDeployChecks(dir).filter((r) => !r.ok).map((r) => r.name);

describe('runDeployChecks', () => {
  it('runs the seam, dev-flag, CSP and embed-origins checks', () => {
    expect(DEPLOY_CHECKS.map((c) => c.name)).toEqual(['no-test-seam', 'no-dev-flags', 'built-csp', 'no-embed-origins']);
  });

  it('passes a clean deploy directory', () => {
    const results = runDeployChecks(deployDir());
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it('fails when the bundle carries the Playwright seam', () => {
    const dir = deployDir({ 'assets/index-abcd1234.js': 'window.__OLV_TEST_API__ = {};\n' });
    expect(failing(dir)).toEqual(['no-test-seam']);
  });

  it('fails when the bundle carries maintainer flag handling', () => {
    const dir = deployDir({ 'assets/index-abcd1234.js': 'window.__olvNavDriver = 1;\n' });
    expect(failing(dir)).toEqual(['no-dev-flags']);
  });

  it('fails when a page other than index.html has an inline style the policy does not name', () => {
    const dir = deployDir({
      'credits.html': read('public/credits.html').replace('</head>', '<style>body{color:red}</style></head>'),
    });
    const res = runDeployChecks(dir).find((r) => r.name === 'built-csp')!;
    expect(res.ok).toBe(false);
    expect(res.output).toContain('credits.html: inline <style>');
  });

  it('fails every check on a directory that holds no build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-empty-'));
    dirs.push(dir);
    expect(failing(dir)).toEqual(['no-test-seam', 'no-dev-flags', 'built-csp', 'no-embed-origins']);
  });
});

describe('an embed allow-list left in the packaging shell', () => {
  const STAMP = '<meta name="olv-embed-origins" content="https://portal.example.org,https://courses.example.edu">';
  const stamped = (): string => deployDir({ 'index.html': read('index.html').replace('</head>', `${STAMP}</head>`) });
  const withEnv = <T,>(value: string | undefined, run: () => T): T => {
    const before = process.env.OLV_ALLOW_EMBED_ORIGINS;
    if (value === undefined) delete process.env.OLV_ALLOW_EMBED_ORIGINS;
    else process.env.OLV_ALLOW_EMBED_ORIGINS = value;
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.OLV_ALLOW_EMBED_ORIGINS;
      else process.env.OLV_ALLOW_EMBED_ORIGINS = before;
    }
  };

  it('fails packaging, naming the origins, unless the packager acknowledged them', () => {
    const dir = stamped();
    withEnv(undefined, () => {
      const res = runDeployChecks(dir).find((r) => r.name === 'no-embed-origins')!;
      expect(res.ok).toBe(false);
      expect(res.output).toContain('https://portal.example.org, https://courses.example.edu');
      expect(res.output).toContain('OLV_ALLOW_EMBED_ORIGINS=1');
    });
  });

  it('passes with OLV_ALLOW_EMBED_ORIGINS=1, and says the list was acknowledged', () => {
    const dir = stamped();
    withEnv('1', () => {
      const res = runDeployChecks(dir).find((r) => r.name === 'no-embed-origins')!;
      expect(res.ok).toBe(true);
    });
  });

  it('any other value does not acknowledge it', () => {
    const dir = stamped();
    withEnv('yes', () => expect(failing(dir)).toEqual(['no-embed-origins']));
  });

  it('a build with no list passes without the acknowledgement', () => {
    withEnv(undefined, () => expect(failing(deployDir())).toEqual([]));
  });

  it('is found on any page of the build, not only the first', () => {
    const dir = deployDir({ 'credits.html': read('public/credits.html').replace('</head>', `${STAMP}</head>`) });
    withEnv(undefined, () => {
      const res = runDeployChecks(dir).find((r) => r.name === 'no-embed-origins')!;
      expect(res.ok).toBe(false);
      expect(res.output).toContain('credits.html');
    });
  });
});

describe('the build stamp', () => {
  it('is added only for a non-empty list, and parses back to the same origins', async () => {
    const { embedOriginsStamp, findEmbedOriginsStamp } = await import('../scripts/lib/viteDefines.mjs');
    expect(embedOriginsStamp([])).toBeNull();
    const stamp = embedOriginsStamp(['https://a.example', 'https://b.example'])!;
    const html = `<head><meta charset="utf-8"><meta name="${stamp.name}" content="${stamp.content}"></head>`;
    expect(findEmbedOriginsStamp(html)).toEqual(['https://a.example', 'https://b.example']);
    expect(findEmbedOriginsStamp('<head><meta name="viewport" content="width=device-width"></head>')).toBeNull();
    expect(findEmbedOriginsStamp(`<meta content="https://a.example" name="olv-embed-origins">`)).toEqual(['https://a.example']);
  });

  it('is wired into the build as a plugin', () => {
    expect(read('vite.config.ts')).toContain('embedOriginsStampPlugin(embedOrigins)');
  });
});

describe('where the checks are wired', () => {
  const pkg = read('scripts/package.sh');
  const smoke = read('scripts/smoke-deploy-zip.mjs');

  it('package.sh checks the staged copy after normalising modes and before zipping it', () => {
    const staged = pkg.indexOf('check-deploy-output.mjs" "$TMP/deploy"');
    expect(staged).toBeGreaterThan(pkg.indexOf('normalise_modes "$TMP/deploy"'));
    expect(staged).toBeLessThan(pkg.indexOf('zip_deterministic "$TMP/deploy"'));
  });

  it('smoke-deploy-zip.mjs checks the extracted archive before serving it', () => {
    expect(smoke).toContain("from './check-deploy-output.mjs'");
    const check = smoke.indexOf('runDeployChecks(work)');
    expect(check).toBeGreaterThan(smoke.indexOf("execFileSync('unzip'"));
    expect(check).toBeLessThan(smoke.indexOf('await freePort()'));
  });
});
