/**
 * openFailureReport.ts
 *
 * The informative failure report for a file no probe opens. It replaces the
 * bare "Unrecognised file format" refusal with what the viewer could tell
 * from the sampled bytes: size, text or binary, byte entropy, a recognised non
 * point cloud signature, a candidate fixed record size, and neutral
 * explanations of what the file may be.
 *
 * Redaction follows Copy diagnostics: no file name or path, no coordinates,
 * no file content. Only the extension (short, alphanumeric) is kept, because
 * it is part of the evidence the probes weighed.
 *
 * Pure: no DOM, unit-tested in Node.
 */
import { byteEntropy, detectStride, extensionOf, looksLikeText, type ProbeDecision } from './formatProbes';
import { formatByteSize } from '../formatByteSize';
import type { ProbeBound } from './progressiveProbe';

export interface OpenFailureFacts {
  readonly schema: 'olv-open-report/1';
  readonly verdict: ProbeDecision['level'];
  /** The probe bound that ended the search, when one did. */
  readonly limit: ProbeBound | null;
  readonly sizeBytes: number;
  readonly sampledBytes: number;
  readonly extension: string;
  readonly content: 'text' | 'binary' | 'empty';
  /** Bits per byte over the sample, two decimals. */
  readonly entropyBitsPerByte: number;
  readonly signature: string | null;
  readonly recordSizeBytes: number | null;
  /** Formats with any evidence, strongest first, as `format: LEVEL`. */
  readonly candidates: string[];
  readonly explanations: string[];
}

/** Keep an extension only when it is short and plain. */
function safeExtension(name: string): string {
  const ext = extensionOf(name);
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

const OPEN_FORMATS = 'LAS/LAZ, E57, PLY, PCD, PTX, PTS or XYZ';

/** Gather the report facts. */
export function buildOpenFailureFacts(
  decision: ProbeDecision,
  sample: Uint8Array,
  sizeBytes: number,
  name: string,
  bound?: ProbeBound,
): OpenFailureFacts {
  const content = sample.length === 0 ? 'empty' : looksLikeText(sample) ? 'text' : 'binary';
  const entropy = Math.round(byteEntropy(sample) * 100) / 100;
  const stride = content === 'binary' ? detectStride(sample) : null;
  const sig = decision.foreign;
  const explanations: string[] = [];
  if (content === 'empty') {
    explanations.push('The file is empty.');
  } else if (sig && sig.kind === 'capture') {
    explanations.push(
      `It is a ${sig.name}: a raw recording of network packets. Raw captures are not decoded yet. ` +
        `Export the scan to ${OPEN_FORMATS} with the software that recorded it.`,
    );
  } else if (sig && (sig.kind === 'archive' || sig.kind === 'compressed')) {
    explanations.push(`It is ${sig.name}. Extract it and open the point cloud inside.`);
  } else if (sig) {
    explanations.push(`It is ${article(sig.name)} ${sig.name}, not a point cloud.`);
  } else {
    if (content === 'binary' && entropy >= 7.5) {
      explanations.push('The bytes look compressed or encrypted, so no structure can be read from them.');
    }
    if (stride !== null) {
      explanations.push(
        `The data repeats every ${stride} bytes, which suggests fixed-size records with no recognised header. ` +
          'It may be an unsupported raw capture or a headerless export.',
      );
    }
    if (content === 'text') {
      explanations.push('The file is text, but its lines do not look like a point list with three numeric columns.');
    }
    explanations.push(
      'Some formats keep the points and their description in separate files. A companion file may be missing.',
    );
    explanations.push(`If the software that made it can export ${OPEN_FORMATS}, that file will open here.`);
  }
  if (bound) explanations.push(BOUND_TEXT[bound]);
  return {
    schema: 'olv-open-report/1',
    verdict: decision.level,
    limit: bound ?? null,
    sizeBytes,
    sampledBytes: sample.length,
    extension: safeExtension(name),
    content,
    entropyBitsPerByte: entropy,
    signature: sig ? sig.name : null,
    recordSizeBytes: stride,
    // Levels only: the internal confidence is not calibrated and never leaves the probe.
    candidates: decision.candidates.map((c) => `${c.decoderId}: ${c.level}`),
    explanations,
  };
}

const BOUND_TEXT: Record<ProbeBound, string> = {
  'max-bytes': 'Only the first 1 MiB was examined; the probe reads no further than that.',
  'time-cap': 'The probe stopped at its time limit, so only the start of the file was examined.',
  'read-failed': 'The browser could not read more of the file, so only the start of it was examined.',
};

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** The short message the toast shows. */
export function openFailureSummary(f: OpenFailureFacts): string {
  if (f.verdict === 'NOT_POINT_CLOUD' && f.signature) {
    return `This file is ${article(f.signature)} ${f.signature}, not a point cloud. ${f.explanations[0] ?? ''}`.trim();
  }
  const kind = f.content === 'empty' ? 'empty' : `${f.content}, ${formatByteSize(f.sizeBytes)}`;
  return `This file was not recognised as a point cloud (${kind}). ${f.explanations[0] ?? ''} Copy report for details.`
    .replace(/\s+/g, ' ')
    .trim();
}

/** The plain-text report Copy report puts on the clipboard. */
export function openFailureReportText(f: OpenFailureFacts): string {
  const lines = [
    `OpenLiDARViewer open report (${f.schema})`,
    `Verdict: ${f.verdict}`,
    `Size: ${formatByteSize(f.sizeBytes)} (${f.sizeBytes} bytes)`,
    `Sampled: ${f.sampledBytes} bytes from the start of the file`,
    `Probe limit reached: ${f.limit ?? 'none'}`,
    `Extension: ${f.extension ? '.' + f.extension : 'none'}`,
    `Content: ${f.content}`,
    `Byte entropy: ${f.entropyBitsPerByte.toFixed(2)} bits per byte`,
    `Signature: ${f.signature ?? 'none recognised'}`,
    `Fixed record size: ${f.recordSizeBytes === null ? 'none detected' : `${f.recordSizeBytes} bytes`}`,
    `Format evidence: ${f.candidates.length ? f.candidates.join(', ') : 'none'}`,
    'Possible explanations:',
    ...f.explanations.map((e) => `- ${e}`),
  ];
  return lines.join('\n');
}
