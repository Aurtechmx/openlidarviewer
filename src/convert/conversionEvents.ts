/**
 * conversionEvents.ts: one record of what a conversion changed or lost.
 *
 * The converter builds a list of events while it writes. The same list feeds
 * the report log, the Export panel and batch converter lists, and the text
 * area record inside the written LAS file, so a recipient who only has the
 * file reads what the sender saw. Each event has a fixed id, so two exports of
 * the same input record the same lines.
 *
 * Pure data. No DOM, no I/O.
 */

import type { ConvertReport, LogEntry } from './types';

/** What happened to the data. */
export type ConversionEventKind =
  /** A source meaning was rewritten into the target's encoding. */
  | 'translated'
  /** A value was written unchanged but reads differently in the target. */
  | 'reinterpreted'
  /** Information the target has no field for was left out. */
  | 'dropped'
  /** A value was forced into the target's range. */
  | 'clipped'
  /** A value was rounded to the target's precision. */
  | 'quantised';

export interface ConversionEvent {
  /** Stable identifier, for example `scan-angle-clipped` or `class-meaning-19`. */
  readonly id: string;
  readonly kind: ConversionEventKind;
  readonly level: 'info' | 'warn';
  /** Points affected. */
  readonly points: number;
  /** The sentence the report and the panels show. */
  readonly message: string;
  /** A sentence for the file when it should differ from `message`. */
  readonly record?: string;
  /** The export request allowed this loss (an opt-in was ticked). */
  readonly acknowledged: boolean;
}

/** The report line for an event. */
export function eventLogEntry(event: ConversionEvent): LogEntry {
  return { level: event.level, message: event.message };
}

/** The Text Area Description line for one event. */
export function eventRecordLine(event: ConversionEvent): string {
  const text = event.record ?? event.message;
  return `Conversion event ${event.id}: ${text}${event.acknowledged ? ' Allowed in the export request.' : ''}`;
}

/** Longest Text Area Description payload, in bytes, that fits the VLR length field with its NUL. */
export const MAX_RECORD_BYTES = 0xffff - 1;

/**
 * The provenance lines for a write: the lines the converter already carries
 * plus one line per event. When the whole text cannot fit the VLR, the
 * existing lines are dropped before any event is, and the report says so, so a
 * caveat never disappears without a trace.
 */
export function fitProvenance(
  baseLines: readonly string[],
  datumNote: string | null,
  events: readonly ConversionEvent[],
): { lines: string[]; trimmed: boolean } {
  const eventLines = events.map(eventRecordLine);
  const size = (lines: readonly string[]): number => lines.join('\n').length + (datumNote ? datumNote.length + 1 : 0);
  const all = [...baseLines, ...eventLines];
  if (size(all) <= MAX_RECORD_BYTES) return { lines: all, trimmed: false };
  return { lines: eventLines, trimmed: true };
}

/** The report entries the panels must show: every warning and error, and each translation. */
export function notableEntries(report: Pick<ConvertReport, 'log' | 'events'>): LogEntry[] {
  const translated = new Set((report.events ?? []).filter((e) => e.kind === 'translated').map((e) => e.message));
  return report.log.filter((l) => l.level !== 'info' || translated.has(l.message));
}

/** "Exported with 2 warnings", or "" when nothing is notable. */
export function warningSummary(entries: readonly LogEntry[]): string {
  const warnings = entries.filter((e) => e.level === 'warn').length;
  const notes = entries.length - warnings;
  const parts: string[] = [];
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (notes > 0) parts.push(`${notes} translation${notes === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

/*
 * Acquisition fields. LAS 1.4 formats 6 to 10 hold the scan angle as an int16
 * in 0.006 degree steps and a 2-bit scanner channel. Formats 0 to 5 hold the
 * angle as an int8 rank in whole degrees, limited to -90 to 90, and have no
 * channel field (ASPRS LAS 1.2 and 1.4 R15, scan angle rank and scanner
 * channel).
 */

const LEGACY_MAX_ANGLE = 90;
const ROUNDING_TOLERANCE_DEG = 1e-6;

export interface AcquisitionLoss {
  /** Points whose angle rounds to a whole-degree value beyond 90 and is clipped to 90. */
  readonly clippedAngle: number;
  /** Points whose in-range angle is rounded to a whole degree. */
  readonly roundedAngle: number;
  /** Points with a nonzero scanner channel that has no legacy field. */
  readonly droppedChannel: number;
  /** The channel numbers that occur among those points, ascending. */
  readonly channels: readonly number[];
}

/**
 * The whole-degree value a legacy write stores for an angle, before the
 * -90..90 limit: halves round away from zero, so 90.5 and -90.5 both clip.
 */
export function roundLegacyAngle(angle: number): number {
  return Math.sign(angle) * Math.round(Math.abs(angle));
}

export function assessLegacyAcquisition(
  scanAngle: Float32Array | undefined,
  scannerChannel: Uint8Array | undefined,
  count: number,
): AcquisitionLoss {
  let clippedAngle = 0;
  let roundedAngle = 0;
  let droppedChannel = 0;
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    if (scanAngle) {
      const a = scanAngle[i];
      if (Number.isFinite(a)) {
        // The writer stores the rounded angle (`roundLegacyAngle`), limited to -90..90. An angle is
        // clipped only when that whole-degree value is out of range; 90.402
        // writes as 90 and is rounded, 90.6 writes as 91 and is clipped.
        const rank = roundLegacyAngle(a);
        if (rank > LEGACY_MAX_ANGLE || rank < -LEGACY_MAX_ANGLE) clippedAngle++;
        else if (Math.abs(a - rank) > ROUNDING_TOLERANCE_DEG) roundedAngle++;
      }
    }
    if (scannerChannel && scannerChannel[i] !== 0) {
      droppedChannel++;
      seen.add(scannerChannel[i]);
    }
  }
  return { clippedAngle, roundedAngle, droppedChannel, channels: [...seen].sort((a, b) => a - b) };
}

/** True when the loss is one a legacy write needs the request to allow. */
export function isMaterialAcquisitionLoss(loss: AcquisitionLoss): boolean {
  return loss.clippedAngle > 0 || loss.droppedChannel > 0;
}

function pts(n: number): string {
  return `${n.toLocaleString()} point${n === 1 ? '' : 's'}`;
}

/** The refusal returned when the request has not allowed the loss. */
export function acquisitionLossRefusal(loss: AcquisitionLoss, optIn: string): string {
  const parts: string[] = [];
  if (loss.clippedAngle > 0) {
    parts.push(`${pts(loss.clippedAngle)} ${loss.clippedAngle === 1 ? 'has' : 'have'} a scan angle that rounds beyond 90 degrees, which LAS 1.2 clips to 90`);
  }
  if (loss.droppedChannel > 0) {
    parts.push(`${pts(loss.droppedChannel)} ${loss.droppedChannel === 1 ? 'carries' : 'carry'} a scanner channel, which LAS 1.2 has no field for`);
  }
  return `LAS 1.2 was not written. ${parts.join(', and ')}. Choose LAS 1.4 to keep them, or tick "${optIn}" to write the file without them.`;
}

/** The events for a legacy write, in a fixed order. */
export function acquisitionEvents(loss: AcquisitionLoss, acknowledged: boolean): ConversionEvent[] {
  const events: ConversionEvent[] = [];
  if (loss.clippedAngle > 0) {
    events.push({
      id: 'scan-angle-clipped',
      kind: 'clipped',
      level: 'warn',
      points: loss.clippedAngle,
      message: `LAS 1.2 stores the scan angle as -90 to 90 whole degrees. ${pts(loss.clippedAngle)} with a scan angle that rounds beyond 90 degrees ${loss.clippedAngle === 1 ? 'is' : 'are'} written as 90 or -90; use LAS 1.4 to keep them.`,
      acknowledged,
    });
  }
  if (loss.droppedChannel > 0) {
    events.push({
      id: 'scanner-channel-dropped',
      kind: 'dropped',
      level: 'warn',
      points: loss.droppedChannel,
      message: `LAS 1.2 has no scanner channel field. The channel (${loss.channels.join(', ')}) of ${pts(loss.droppedChannel)} is not written; use LAS 1.4 to keep it.`,
      acknowledged,
    });
  }
  if (loss.roundedAngle > 0) {
    events.push({
      id: 'scan-angle-rounded',
      kind: 'quantised',
      level: 'info',
      points: loss.roundedAngle,
      message: `LAS 1.2 stores the scan angle in whole degrees. ${pts(loss.roundedAngle)} ${loss.roundedAngle === 1 ? 'has' : 'have'} a fractional angle that is rounded to the nearest degree.`,
      acknowledged: false,
    });
  }
  return events;
}

/** One refusal a LAS 1.2 write would return, and the control that allows it. */
export interface LegacyRefusal {
  readonly text: string;
  readonly optIn: string;
}

const CHOOSE_CLAUSE = /\s*Choose LAS 1\.4\b.*$/s;
const WRITE_PREFIX = 'LAS 1.2 was not written. ';

/**
 * One refusal for a write that needs several opt-ins, so the user sees every
 * loss and every control at once. A single refusal is returned unchanged.
 */
export function combineRefusals(refusals: readonly LegacyRefusal[]): string {
  if (refusals.length === 1) return refusals[0].text;
  const bodies = refusals.map((r) => r.text.replace(WRITE_PREFIX, '').replace(CHOOSE_CLAUSE, ''));
  const controls = refusals.map((r) => `"${r.optIn}"`).join(', ');
  return `${WRITE_PREFIX}It would lose data in ${refusals.length} ways. ${bodies.join(' ')} Choose LAS 1.4 to keep all of it, or tick ${controls} to write the file without it.`;
}
