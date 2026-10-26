/**
 * archiveMetadataLint.test.ts — the rules in scripts/lint-archive-metadata.mjs.
 *
 * CITATION.cff, codemeta.json and .zenodo.json are hand-edited and were never
 * compared: the v0.7.0 version DOI reached one file and not the others. The
 * cases below drive each rule with synthetic records, so they describe the
 * rules rather than the repository's current contents; one case runs the
 * real tree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs script, no types
import { parseCff, collectMetadataProblems, lintArchiveMetadata, orcidOf, doiOf } from '../scripts/lint-archive-metadata.mjs';
// @ts-expect-error - plain .mjs script, no types
import { serialOrder } from '../scripts/lib/gates.mjs';

const ORCID = '0000-0002-1825-0097';
const CO = '0000-0001-5109-3700';
const CFF = `cff-version: 1.2.0
title: "X"
authors:
  - given-names: "A."
    family-names: "Author"
    orcid: "https://orcid.org/${ORCID}"
contact:
  - family-names: "Author"
    email: "help@example.org"
version: "1.2.3"
repository-code: "https://example.org/repo"
identifiers:
  - type: doi
    value: "10.5281/zenodo.100"
    description: "Version DOI for the archived v1.2.3 release"
  - type: doi
    value: "10.5281/zenodo.1"
    description: "Concept DOI, resolves to the newest version"
  - type: swh
    value: "swh:1:snp:abc"
    description: "Software Heritage snapshot"
abstract: >-
  Two lines
  folded.
keywords:
  - lidar
`;
const codemeta = () => ({
  version: '1.2.3', softwareVersion: '1.2.3',
  identifier: ['https://doi.org/10.5281/zenodo.1', 'https://doi.org/10.5281/zenodo.100', 'https://archive.softwareheritage.org/swh:1:snp:abc'],
  codeRepository: 'https://example.org/repo',
  author: [{ '@type': 'Person', givenName: 'A.', familyName: 'Author', '@id': `https://orcid.org/${ORCID}` }],
  contributor: [{ '@type': 'Person', familyName: 'Helper', '@id': `https://orcid.org/${CO}` }],
  maintainer: { '@id': `https://orcid.org/${ORCID}`, email: 'help@example.org' },
});
const zenodo = () => ({
  version: '1.2.3',
  creators: [{ name: 'Author, A.', orcid: ORCID }],
  contributors: [{ name: 'Helper, B.', orcid: CO, type: 'Other' }],
  related_identifiers: [
    { relation: 'isSupplementTo', identifier: 'https://example.org/repo' },
    { relation: 'isSupplementTo', identifier: 'https://archive.softwareheritage.org/swh:1:snp:abc' },
  ],
});
const base = (over: Record<string, unknown> = {}) => ({
  cff: parseCff(CFF), codemeta: codemeta(), zenodo: zenodo(), support: 'General contact: help@example.org.', pkgVersion: '1.2.3', ...over,
});
const problems = (over: Record<string, unknown> = {}): string[] => collectMetadataProblems(base(over));

describe('parseCff reads the subset CITATION.cff uses', () => {
  it('scalars, block lists of maps, string lists and a folded scalar', () => {
    const c = parseCff(CFF);
    expect(c.scalars.version).toBe('1.2.3');
    expect(c.lists.authors[0]['family-names']).toBe('Author');
    expect(c.lists.identifiers).toHaveLength(3);
    expect(c.lists.keywords).toEqual(['lidar']);
    expect(c.scalars.abstract).toBe('Two lines folded.');
  });
  it('normalises ORCIDs and DOIs from URLs', () => {
    expect(orcidOf(`https://orcid.org/${ORCID}`)).toBe(ORCID);
    expect(doiOf('https://doi.org/10.5281/zenodo.1')).toBe('10.5281/zenodo.1');
  });
});

describe('the rules', () => {
  it('accepts three files that agree', () => {
    expect(problems()).toEqual([]);
  });
  it('Z1: a version that differs in any file, or from package.json', () => {
    expect(problems({ zenodo: { ...zenodo(), version: '1.2.2' } }).some((p) => p.startsWith('Z1') && p.includes('.zenodo.json'))).toBe(true);
    expect(problems({ pkgVersion: '1.3.0' }).filter((p) => p.startsWith('Z1'))).toHaveLength(4);
  });
  it('Z2: the version DOI and concept DOI must reach codemeta, and Zenodo must carry none', () => {
    const cm = codemeta(); cm.identifier = ['https://doi.org/10.5281/zenodo.1'];
    expect(problems({ codemeta: cm }).some((p) => p.startsWith('Z2') && p.includes('version DOI'))).toBe(true);
    expect(problems({ zenodo: { ...zenodo(), doi: '10.5281/zenodo.100' } }).some((p) => p.startsWith('Z2') && p.includes('doi key'))).toBe(true);
  });
  it('Z2: a version carrying regex metacharacters, a backslash among them, is matched literally', () => {
    const version = String.raw`1.2.3+b\1`;
    const cff = parseCff(CFF.replace('Version DOI for the archived v1.2.3 release', `Version DOI for the archived v${version} release`));
    const missingVersionDoi = (p: string) => p.startsWith('Z2') && p.includes('names no version DOI');
    expect(problems({ cff, pkgVersion: version }).some(missingVersionDoi)).toBe(false);
    // The same text with the backslash dropped is a different version, not a match.
    expect(problems({ cff, pkgVersion: '1.2.3+b1' }).some(missingVersionDoi)).toBe(true);
    // A dot is a literal dot, not "any character".
    expect(problems({ cff: parseCff(CFF.replace('v1.2.3', 'v1x2x3')), pkgVersion: '1.2.3' }).some(missingVersionDoi)).toBe(true);
  });
  it('Z3: the author lists must match by family name and ORCID, in order', () => {
    expect(problems({ zenodo: { ...zenodo(), creators: [{ name: 'Other, Z.', orcid: ORCID }] } }).some((p) => p.startsWith('Z3'))).toBe(true);
  });
  it('Z4: contributors must match between codemeta and Zenodo', () => {
    expect(problems({ zenodo: { ...zenodo(), contributors: [] } }).some((p) => p.startsWith('Z4'))).toBe(true);
  });
  it('Z5: one contact address, published by SUPPORT.md', () => {
    expect(problems({ codemeta: { ...codemeta(), maintainer: { email: 'other@example.org' } } }).some((p) => p.startsWith('Z5'))).toBe(true);
    expect(problems({ support: 'no address here' }).some((p) => p.startsWith('Z5') && p.includes('SUPPORT.md'))).toBe(true);
  });
  it('Z6: the repository and snapshot must reach the Zenodo related identifiers', () => {
    expect(problems({ zenodo: { ...zenodo(), related_identifiers: [] } }).filter((p) => p.startsWith('Z6'))).toHaveLength(2);
  });
});

describe('the real tree and the wiring', () => {
  it('the committed files agree', () => {
    expect(lintArchiveMetadata().problems).toEqual([]);
  });
  it('the release chain runs it', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:archive-metadata']).toBe('node scripts/lint-archive-metadata.mjs');
    expect(serialOrder(), 'a lint outside the release chain guards nothing at release time').toContain('lint:archive-metadata');
  });
});
