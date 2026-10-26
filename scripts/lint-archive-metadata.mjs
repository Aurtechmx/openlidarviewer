#!/usr/bin/env node
/**
 * lint-archive-metadata.mjs
 *
 * CITATION.cff, codemeta.json and .zenodo.json each describe this software to
 * a different consumer: citation tooling, the CodeMeta crosswalk, and the
 * Zenodo deposit made from a GitHub release. They are edited by hand and
 * nothing compared them, so the version DOI reached one file and not another,
 * one carried a contact address and two did not, and the version string was
 * absent from the deposit metadata altogether.
 *
 * Rules (each names the files it reads):
 *   Z1  version: CITATION.cff `version`, codemeta `version` and
 *       `softwareVersion`, and .zenodo.json `version` are one string, and it
 *       is the package.json version.
 *   Z2  DOI: the concept DOI and the newest version DOI in CITATION.cff
 *       `identifiers` appear in codemeta `identifier` (a pre-release version
 *       has no version DOI and names none); .zenodo.json carries no
 *       `doi` key, because Zenodo mints the DOI of each deposit and a stale one
 *       written there would be sent back to it.
 *   Z3  authors: the ORCIDs and family names of CITATION.cff `authors`, codemeta
 *       `author` and .zenodo.json `creators` are the same list in the same order.
 *   Z4  contributors: codemeta `contributor` and .zenodo.json `contributors`
 *       name the same ORCIDs. CITATION.cff 1.2.0 has no contributor field.
 *   Z5  contact: CITATION.cff `contact[].email` and codemeta `maintainer.email`
 *       are one address, and that address appears in docs/project/SUPPORT.md,
 *       so no address is invented here. The Zenodo deposit schema has no email
 *       field for a creator, so .zenodo.json is not read for this rule.
 *   Z6  related identifiers: the repository URL and the Software Heritage
 *       snapshot named by CITATION.cff and codemeta are among .zenodo.json
 *       `related_identifiers`, and CITATION.cff `repository-code` equals
 *       codemeta `codeRepository`.
 *
 * The CFF reader below handles the subset of YAML this file uses (scalars,
 * block lists of maps, one folded scalar), not YAML in general; a shape it
 * does not understand is reported as a problem rather than skipped.
 *
 * Exit 0 = clean; exit 1 = a disagreement (prints each).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';
import { escapeRegExp } from './regex-escape.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = {
  cff: 'CITATION.cff',
  codemeta: 'codemeta.json',
  zenodo: '.zenodo.json',
  support: 'docs/project/SUPPORT.md',
  pkg: 'package.json',
};

const unquote = (v) => String(v ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/**
 * Read the CFF subset: top-level `key: value` scalars, top-level block lists
 * whose items are maps of scalars (`authors`, `identifiers`, `contact`,
 * `keywords` as plain strings), and `abstract: >-` folded text, which is kept
 * as one string. Returns `{ scalars, lists }`.
 */
export function parseCff(text) {
  const scalars = {};
  const lists = {};
  let list = null;
  let item = null;
  let folded = null;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
      if (folded && raw.trim() === '') folded = null;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (folded) {
      if (indent > 0) { scalars[folded] = `${scalars[folded]} ${line}`.trim(); continue; }
      folded = null;
    }
    if (indent === 0) {
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      if (!m) throw new Error(`CITATION.cff: unreadable line "${line}"`);
      if (m[2] === '') { list = m[1]; lists[list] = []; item = null; }
      else if (m[2] === '>-' || m[2] === '>' || m[2] === '|') { folded = m[1]; scalars[folded] = ''; list = null; }
      else { scalars[m[1]] = unquote(m[2]); list = null; }
      continue;
    }
    if (!list) throw new Error(`CITATION.cff: indented line outside a list "${line}"`);
    if (line.startsWith('- ')) {
      const body = line.slice(2);
      const m = /^([\w-]+):\s*(.*)$/.exec(body);
      if (m) { item = { [m[1]]: unquote(m[2]) }; lists[list].push(item); }
      else { item = null; lists[list].push(unquote(body)); }
      continue;
    }
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!m || !item) throw new Error(`CITATION.cff: unreadable list line "${line}"`);
    item[m[1]] = unquote(m[2]);
  }
  return { scalars, lists };
}

/** A bare ORCID id from any of the spellings the three files use. */
export const orcidOf = (v) => {
  const m = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/.exec(String(v ?? ''));
  return m ? m[1] : null;
};

/** A bare DOI from a `10.…` value or a doi.org URL. */
export const doiOf = (v) => {
  const m = /(10\.\d{4,9}\/\S+)/.exec(String(v ?? ''));
  return m ? m[1].replace(/[),.]+$/, '') : null;
};

/** Family name from a Zenodo "Family, Given" creator or a CFF/codemeta map. */
const familyOf = (p) => p?.['family-names'] ?? p?.familyName ?? (typeof p?.name === 'string' ? p.name.split(',')[0].trim() : null);

/**
 * The problems across the three parsed files. `cff` is `parseCff` output,
 * `codemeta` and `zenodo` parsed JSON, `support` the SUPPORT.md text, `pkgVersion`
 * the package version. Pure, so the rules are testable on synthetic records.
 */
export function collectMetadataProblems({ cff, codemeta, zenodo, support, pkgVersion }) {
  const problems = [];
  const fail = (rule, msg) => problems.push(`${rule} ${msg}`);

  // Z1 version
  const versions = {
    'CITATION.cff version': cff.scalars.version ?? null,
    'codemeta.json version': codemeta.version ?? null,
    'codemeta.json softwareVersion': codemeta.softwareVersion ?? null,
    '.zenodo.json version': zenodo.version ?? null,
  };
  for (const [where, v] of Object.entries(versions)) {
    if (v !== pkgVersion) fail('Z1', `${where} is ${JSON.stringify(v)}, package.json is ${pkgVersion}`);
  }

  // Z2 DOI
  const cffDois = (cff.lists.identifiers ?? []).filter((i) => i.type === 'doi');
  const concept = cffDois.find((i) => /concept doi/i.test(i.description ?? ''));
  const forVersion = cffDois.find((i) => new RegExp(`\\bv${escapeRegExp(pkgVersion)}\\b`).test(i.description ?? ''));
  const codemetaDois = new Set((Array.isArray(codemeta.identifier) ? codemeta.identifier : [codemeta.identifier]).map(doiOf).filter(Boolean));
  if (!concept) fail('Z2', 'CITATION.cff names no concept DOI (an identifier whose description says "Concept DOI")');
  else if (!codemetaDois.has(doiOf(concept.value))) fail('Z2', `codemeta.json identifier lacks the concept DOI ${concept.value}`);
  // A pre-release cut (a version with a suffix, such as 0.7.1-alpha.1) is not
  // deposited, so it has no version DOI and must not claim one.
  const preRelease = pkgVersion.includes('-');
  if (preRelease && forVersion) fail('Z2', `CITATION.cff names a version DOI for the pre-release v${pkgVersion}, which is not deposited`);
  else if (!preRelease && !forVersion) fail('Z2', `CITATION.cff names no version DOI for v${pkgVersion}`);
  else if (forVersion && !codemetaDois.has(doiOf(forVersion.value))) fail('Z2', `codemeta.json identifier lacks the v${pkgVersion} version DOI ${forVersion.value}`);
  if ('doi' in zenodo) fail('Z2', '.zenodo.json carries a doi key; Zenodo mints the DOI of each deposit, so a written one is stale by construction');

  // Z3 authors
  const authors = {
    'CITATION.cff authors': (cff.lists.authors ?? []).map((a) => ({ orcid: orcidOf(a.orcid), family: familyOf(a) })),
    'codemeta.json author': (codemeta.author ?? []).map((a) => ({ orcid: orcidOf(a['@id'] ?? a.identifier), family: familyOf(a) })),
    '.zenodo.json creators': (zenodo.creators ?? []).map((a) => ({ orcid: orcidOf(a.orcid), family: familyOf(a) })),
  };
  const key = (list) => list.map((a) => `${a.family}/${a.orcid}`).join(';');
  const [first, ...rest] = Object.entries(authors);
  if (first[1].length === 0) fail('Z3', `${first[0]} is empty`);
  for (const [where, list] of rest) {
    if (key(list) !== key(first[1])) fail('Z3', `${where} [${key(list)}] differs from ${first[0]} [${key(first[1])}]`);
  }

  // Z4 contributors
  const cmContrib = (codemeta.contributor ?? []).map((c) => orcidOf(c['@id'] ?? c.identifier)).sort();
  const zContrib = (zenodo.contributors ?? []).map((c) => orcidOf(c.orcid)).sort();
  if (cmContrib.join(',') !== zContrib.join(',')) {
    fail('Z4', `codemeta.json contributor ORCIDs [${cmContrib}] differ from .zenodo.json contributors [${zContrib}]`);
  }

  // Z5 contact
  const cffEmails = (cff.lists.contact ?? []).map((c) => c.email).filter(Boolean);
  const cmEmail = codemeta.maintainer?.email ?? null;
  if (cffEmails.length === 0) fail('Z5', 'CITATION.cff has no contact entry with an email');
  if (!cmEmail) fail('Z5', 'codemeta.json maintainer has no email');
  if (cffEmails.length > 0 && cmEmail && !cffEmails.includes(cmEmail)) {
    fail('Z5', `codemeta.json maintainer email ${cmEmail} is not among CITATION.cff contact emails [${cffEmails}]`);
  }
  for (const e of new Set([...cffEmails, ...(cmEmail ? [cmEmail] : [])])) {
    if (!String(support ?? '').includes(e)) fail('Z5', `${e} is not the address docs/project/SUPPORT.md publishes; the metadata may not name a contact the project does not`);
  }

  // Z6 related identifiers
  const repo = cff.scalars['repository-code'] ?? null;
  if (!repo) fail('Z6', 'CITATION.cff has no repository-code');
  else if (codemeta.codeRepository !== repo) fail('Z6', `codemeta.json codeRepository ${codemeta.codeRepository} differs from CITATION.cff repository-code ${repo}`);
  const swh = (cff.lists.identifiers ?? []).find((i) => i.type === 'swh')?.value ?? null;
  const cmIds = Array.isArray(codemeta.identifier) ? codemeta.identifier : [codemeta.identifier];
  if (!swh) fail('Z6', 'CITATION.cff names no Software Heritage identifier');
  else if (!cmIds.some((i) => String(i).includes(swh))) fail('Z6', `codemeta.json identifier lacks the Software Heritage snapshot ${swh}`);
  const related = (zenodo.related_identifiers ?? []).map((r) => r.identifier);
  if (repo && !related.includes(repo)) fail('Z6', `.zenodo.json related_identifiers lacks the repository ${repo}`);
  if (swh && !related.some((r) => String(r).includes(swh))) fail('Z6', `.zenodo.json related_identifiers lacks the Software Heritage snapshot ${swh}`);

  return problems;
}

export function lintArchiveMetadata(root = ROOT) {
  const read = (p) => readFileSync(resolve(root, p), 'utf8');
  for (const p of Object.values(FILES)) {
    if (!existsSync(resolve(root, p))) return { problems: [`${p} is missing`] };
  }
  let cff;
  try {
    cff = parseCff(read(FILES.cff));
  } catch (e) {
    return { problems: [String(e.message ?? e)] };
  }
  return {
    problems: collectMetadataProblems({
      cff,
      codemeta: JSON.parse(read(FILES.codemeta)),
      zenodo: JSON.parse(read(FILES.zenodo)),
      support: read(FILES.support),
      pkgVersion: JSON.parse(read(FILES.pkg)).version,
    }),
  };
}

if (isCliEntry(import.meta.url)) {
  const { problems } = lintArchiveMetadata();
  if (problems.length > 0) {
    console.error('lint:archive-metadata FAILED — CITATION.cff, codemeta.json and .zenodo.json disagree:\n');
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.log('lint:archive-metadata OK — CITATION.cff, codemeta.json and .zenodo.json agree on version, DOIs, authors, contributors, contact and related identifiers.');
}
