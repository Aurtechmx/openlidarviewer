/**
 * Types for the importable surface of `create-release-manifest.mjs`.
 *
 * The builder is plain ESM (it runs under bare `node` at release time), but
 * buildManifest is a pure function tested without a staged directory, so its
 * shape is declared here. The CLI body is guarded behind `isCliEntry`.
 */

import type { ArchitectureFingerprint } from './lint-module-graph.d.mts';

export const PAYLOAD_KINDS: readonly string[];

export function classifyAsset(name: string, version: string): string | null;

export interface BuildManifestInput {
  readonly version: string;
  readonly evidence: Record<string, unknown> | null;
  readonly assets: Record<string, { file: string; sizeBytes: number; sha256: string }>;
  readonly builtAt: string;
  readonly sourceDateEpoch?: string | null;
  readonly architecture?: ArchitectureFingerprint | null;
}

export interface BuildManifestResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly manifest: Record<string, unknown> | null;
}

export function buildManifest(input: BuildManifestInput): BuildManifestResult;
