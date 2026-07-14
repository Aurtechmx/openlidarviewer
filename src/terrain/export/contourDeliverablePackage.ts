/**
 * contourDeliverablePackage.ts
 *
 * The ZIP-assembly wiring the PR11 package MODEL (contourPackageManifest.ts)
 * explicitly leaves out: given a manifest (which decided WHICH files the package
 * contains, honestly, and threw for a blocked decision) plus the produced bytes
 * for each included product, assemble the real deliverable ZIP with a
 * SHA256SUMS integrity manifest over every file in it.
 *
 * The emitter owns two entries the model marks "included" but does not produce
 * bytes for: the README (its text comes from the manifest) and SHA256SUMS (which
 * can only be computed once every other file's bytes exist). Every other included
 * role MUST have bytes supplied by the caller — an included role with no bytes is
 * a caller bug and throws, so the package can never ship a file the manifest
 * promised but nothing wrote.
 *
 * Pure and deterministic (given the input bytes): no DOM, no I/O. Built on the
 * dependency-free store ZIP writer + the synchronous SHA-256, so the whole
 * deliverable assembles in one straight-line function and is unit-testable.
 */

import { buildZip, type ZipEntry } from '../../convert/zipStore';
import { sha256Hex } from './sha256';
import type { ContourPackageManifest, PackageRole } from '../contourStudio/contourPackageManifest';

/**
 * Produced bytes per included product role. The README and checksums roles are
 * OWNED by the emitter and must NOT appear here; every other included role must.
 */
export type PackageByteMap = ReadonlyMap<PackageRole, Uint8Array>;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Assemble the deliverable ZIP from a manifest + the produced bytes. Writes each
 * included product file (named exactly as the manifest specifies), the README,
 * and a SHA256SUMS manifest covering every file — so a recipient can verify the
 * whole package with `shasum -a 256 -c SHA256SUMS`.
 *
 * @throws if an included product role (other than readme/checksums) has no bytes.
 */
export function assembleContourDeliverable(
  manifest: ContourPackageManifest,
  bytesByRole: PackageByteMap,
): Uint8Array {
  const entries: ZipEntry[] = [];

  for (const e of manifest.entries) {
    if (e.status !== 'included') continue;
    // The emitter owns these two; checksums is appended last (it hashes the rest).
    if (e.role === 'checksums') continue;
    if (e.role === 'readme') {
      entries.push({ name: e.filename, bytes: enc(manifest.readme) });
      continue;
    }
    const bytes = bytesByRole.get(e.role);
    if (!bytes) {
      throw new Error(
        `contourDeliverablePackage: no bytes supplied for included role "${e.role}" (${e.filename}). ` +
          'Every included product must be produced, or the manifest must mark it omitted.',
      );
    }
    entries.push({ name: e.filename, bytes });
  }

  // SHA256SUMS LAST — it hashes every file already assembled (README included),
  // in the standard `sha256sum` format, and never lists itself.
  const checksums = manifest.entries.find((e) => e.role === 'checksums' && e.status === 'included');
  if (checksums) {
    const sums = entries.map((en) => `${sha256Hex(en.bytes)}  ${en.name}`).join('\n') + '\n';
    entries.push({ name: checksums.filename, bytes: enc(sums) });
  }

  return buildZip(entries);
}
