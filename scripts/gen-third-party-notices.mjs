#!/usr/bin/env node
/**
 * gen-third-party-notices.mjs: write the copyright notices and full licence
 * texts of every bundled package into docs/project/THIRD_PARTY_NOTICES.md.
 *
 * The bundled set is the component list in sbom.json (generated with
 * `--omit dev`, so it is what ships in dist/). For each component the script
 * reads the licence and NOTICE files from the installed package under
 * node_modules, pulls out its copyright lines, and reproduces each distinct
 * licence text once. The result replaces the block between the two
 * `generated:licence-texts` markers; everything outside the markers is curated
 * by hand and left alone.
 *
 * A package that ships no licence file gets the standard text of its declared
 * licence and a copyright line from FALLBACK_COPYRIGHT below, both marked as
 * such in the output.
 *
 * Usage:
 *   node scripts/gen-third-party-notices.mjs          rewrite the block
 *   node scripts/gen-third-party-notices.mjs --check  exit 1 if the block is stale
 *
 * OLV_NOTICES_EXTRA_MODULES may name a further node_modules directory to search
 * when a package is missing from the local install.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_PATH = 'docs/project/THIRD_PARTY_NOTICES.md';
export const BEGIN = '<!-- generated:licence-texts:begin (scripts/gen-third-party-notices.mjs) -->';
export const END = '<!-- generated:licence-texts:end -->';

/** Copyright lines for packages whose published tarball carries no licence file. */
const FALLBACK_COPYRIGHT = {
  'laz-perf': 'Copyright Hobu, Inc. and the laz-perf contributors (https://github.com/hobuinc/laz-perf)',
  draco3d: 'Copyright The Draco Authors, Google LLC (https://github.com/google/draco)',
  flatbuffers: 'Copyright Google Inc. and the FlatBuffers authors (https://github.com/google/flatbuffers)',
};

/** Standard texts for licences a package declares but whose text it does not ship. */
const ZLIB_TEXT = `This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;

const LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;

const normalise = (t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 12);

function packageDir(name, searchRoots) {
  for (const r of searchRoots) {
    const d = join(r, name);
    if (existsSync(join(d, 'package.json'))) return d;
  }
  return null;
}

/** Lines that state a copyright, without the licence's own boilerplate uses of the word. */
export function copyrightLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(Copyright|COPYRIGHT)\b/.test(l) || /^(\(c\)|©)\s*\d/i.test(l))
    .filter((l) => !/^copyright (notice|holder|owner|statement)/i.test(l))
    .filter((l) => !/\[yyyy\]|\[name of copyright owner\]/i.test(l));
}

/**
 * Build the generated block. `components` is [{name, version, licence}];
 * `readPkg(name)` returns {licences: [{file, text}], notices: [{file, text}]}
 * or null when the package is not installed.
 */
export function buildBlock(components, readPkg) {
  const missing = [];
  const texts = new Map(); // hash -> {label, text, users: []}
  const entries = [];
  const noticeBlocks = [];
  let apacheCanonical = null;

  const pkgs = components.map((c) => ({ ...c, files: readPkg(c.name) }));
  for (const p of pkgs) {
    for (const l of p.files?.licences ?? []) {
      if (/Apache License\s+Version 2\.0, January 2004/.test(l.text) && l.text.length < 12000) {
        apacheCanonical ??= normalise(l.text);
      }
    }
  }

  const addText = (label, text, user) => {
    const t = normalise(text);
    const h = hash(t);
    if (!texts.has(h)) texts.set(h, { label, text: t, users: [] });
    texts.get(h).users.push(user);
    return h;
  };

  for (const p of pkgs) {
    const user = `${p.name} ${p.version}`;
    if (!p.files) {
      missing.push(p.name);
      continue;
    }
    const refs = [];
    const copyright = new Set();
    for (const l of p.files.licences) {
      refs.push(addText(p.licence, l.text, user));
      for (const c of copyrightLines(l.text)) copyright.add(c);
    }
    let note = '';
    if (!p.files.licences.length) {
      note = ' The published package ships no licence file; the standard text of its declared licence applies.';
      if (/Apache-2\.0/.test(p.licence) && apacheCanonical) refs.push(addText('Apache-2.0', apacheCanonical, user));
    }
    if (/Zlib/.test(p.licence)) refs.push(addText('Zlib', ZLIB_TEXT, user));
    if (!copyright.size && FALLBACK_COPYRIGHT[p.name]) {
      copyright.add(`${FALLBACK_COPYRIGHT[p.name]} (from the upstream repository; the package names no holder)`);
    }
    for (const n of p.files.notices) {
      noticeBlocks.push(`#### NOTICE file of ${user} (${n.file})\n\n\`\`\`\n${normalise(n.text)}\n\`\`\``);
      for (const c of copyrightLines(n.text)) copyright.add(c);
    }
    const lines = [...copyright];
    entries.push({ user, licence: p.licence, lines, refs: [...new Set(refs)], note });
  }

  const ids = new Map([...texts.keys()].map((h, i) => [h, `T${i + 1}`]));
  const out = [BEGIN, '', '## Copyright notices and full licence texts', ''];
  out.push(
    'This section is generated from the installed packages by',
    '`scripts/gen-third-party-notices.mjs`. Each bundled package is listed with',
    'the copyright lines from its own licence and NOTICE files and the licence text',
    'that applies to it; each distinct text is reproduced once at the end.',
    '',
    '### Bundled packages',
    '',
  );
  for (const e of entries) {
    out.push(`#### ${e.user}`, '');
    out.push(`Licence: ${e.licence}. Text: ${e.refs.map((h) => ids.get(h)).join(', ') || 'none found'}.${e.note}`, '');
    if (e.lines.length) for (const l of e.lines) out.push(`- ${l}`);
    else out.push('- No copyright line in the shipped files; the licence text applies as published.');
    out.push('');
  }
  if (noticeBlocks.length) {
    out.push('### NOTICE files', '');
    out.push('Apache-2.0 section 4(d) requires these to travel with the distribution.', '');
    out.push(noticeBlocks.join('\n\n'), '');
  }
  out.push('### Licence texts', '');
  for (const [h, t] of texts) {
    out.push(`#### ${ids.get(h)}: ${t.label}`, '');
    out.push(`Applies to: ${t.users.join(', ')}.`, '');
    out.push('```', t.text, '```', '');
  }
  out.push(END);
  return { block: out.join('\n'), missing };
}

export function spliceBlock(doc, block) {
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) return `${doc.trimEnd()}\n\n${block}\n`;
  return doc.slice(0, a) + block + doc.slice(b + END.length);
}

function readFromDisk(searchRoots) {
  return (name) => {
    const dir = packageDir(name, searchRoots);
    if (!dir) return null;
    const files = readdirSync(dir).sort();
    const read = (f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') });
    return {
      licences: files.filter((f) => LICENCE_FILE.test(f)).map(read),
      notices: files.filter((f) => NOTICE_FILE.test(f)).map(read),
    };
  };
}

export function sbomComponents(sbom) {
  return (sbom.components ?? [])
    .map((c) => ({
      name: c.group ? `${c.group}/${c.name}` : c.name,
      version: c.version,
      licence: (c.licenses ?? []).map((l) => l.license?.id ?? l.expression).filter(Boolean).join(' AND ') || 'unknown',
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

if (isCliEntry(import.meta.url)) {
  const check = process.argv.includes('--check');
  const roots = [join(ROOT, 'node_modules')];
  if (process.env.OLV_NOTICES_EXTRA_MODULES) roots.push(resolve(process.env.OLV_NOTICES_EXTRA_MODULES));
  const components = sbomComponents(JSON.parse(readFileSync(join(ROOT, 'sbom.json'), 'utf8')));
  const { block, missing } = buildBlock(components, readFromDisk(roots));
  if (missing.length) {
    console.error(`notices: not installed, cannot read licence files: ${missing.join(', ')}. Run npm ci, or set OLV_NOTICES_EXTRA_MODULES.`);
    process.exit(1);
  }
  const path = join(ROOT, NOTICES_PATH);
  const doc = readFileSync(path, 'utf8');
  const next = spliceBlock(doc, block);
  if (check) {
    if (next !== doc) {
      console.error(`notices: ${NOTICES_PATH} is stale. Run node scripts/gen-third-party-notices.mjs.`);
      process.exit(1);
    }
    console.log(`notices OK: ${components.length} bundled packages, licence texts current.`);
  } else {
    writeFileSync(path, next);
    console.log(`notices: wrote ${components.length} bundled packages to ${NOTICES_PATH}.`);
  }
}
