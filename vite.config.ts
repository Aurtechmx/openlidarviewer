import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Single source of truth for the app version — read from package.json at
// build time and exposed to the app as the `__APP_VERSION__` global.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
