/**
 * reportTemplateGoldens.test.ts — v0.5.5 P12 template consolidation.
 *
 * Golden-content pins for the two-template catalogue, asserted against
 * the ACTUAL rendered PDF bytes (content streams inflated, text runs
 * decoded — the same harness as reportPdfLayout.test.ts):
 *
 *   - Survey Summary is genuinely compact: it names the capture type
 *     (compact provenance) but contains NO "Signals" list, NO "Expected
 *     accuracy (cited literature)" block, NO Annotations section and NO
 *     "Declared source metadata" section.
 *   - Technical Report is the complete record: it contains all of them.
 *   - The shared dataset block renders exactly ONCE per report in both.
 *   - Legacy template ids render via the engine (mapped to the nearest
 *     current template) and the result echoes the NORMALISED id.
 *
 * Background (verified from real exports): the previous four look-alike
 * templates emitted ~85 % byte-identical content and differed only in
 * trailing stubs — these pins keep the two survivors honestly distinct.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { generateReport, composeReportInputs } from '../src/report';
import type {
  ReportInputs,
  ReportProvenanceFingerprint,
  ReportTemplateId,
} from '../src/report';
import { fingerprintFor } from '../src/diagnostics/provenance';
import type { Annotation } from '../src/render/annotate/types';
import type { Measurement } from '../src/render/measure/types';

// ─────────────────────────────────────────────────────────────────────────────
// Content-stream text extraction (same approach as reportPdfLayout.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

async function renderText(inputs: ReportInputs): Promise<{
  text: string;
  templateId: ReportTemplateId;
  failed: readonly string[];
}> {
  const result = await generateReport(inputs);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  const texts: string[] = [];
  for (const seg of bytes.toString('latin1').split(/stream\r?\n/).slice(1)) {
    const raw = seg.split('endstream')[0];
    let content: string;
    try {
      content = inflateSync(Buffer.from(raw, 'latin1')).toString('latin1');
    } catch {
      continue; // not a flate stream (xref etc.)
    }
    if (!content.includes('BT')) continue;
    for (const m of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
      texts.push(Buffer.from(m[1], 'hex').toString('latin1'));
    }
  }
  return { text: texts.join('\n'), templateId: result.templateId, failed: result.failedSections };
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — one dataset, rendered through both templates, with every
// optional input populated so an omitted section is a template decision,
// never a missing-data accident.
// ─────────────────────────────────────────────────────────────────────────────

function droneProvenance(): ReportProvenanceFingerprint {
  const f = fingerprintFor('drone-lidar');
  return {
    label: f.label,
    confidence: f.confidence,
    signals: f.signals,
    bounds: f.bounds.map((b) => ({ label: b.label, value: b.value, source: b.source })),
    disclaimer: f.disclaimer,
  };
}

const ANNOTATIONS: Annotation[] = [
  {
    id: 'a1', title: 'Spalling at pier base', type: 'issue',
    createdAt: 1000, updatedAt: 1000, localPosition: { x: 1, y: 2, z: 3 },
  },
];

const MEASUREMENTS: Measurement[] = [
  { id: 'm1', kind: 'distance', name: 'Deck span', points: [[0, 0, 0], [25, 0, 0]] },
];

function makeInputs(templateId: string): ReportInputs {
  return composeReportInputs({
    templateId: templateId as ReportTemplateId,
    title: 'Golden fixture',
    metadata: {
      fileName: 'golden.copc.laz',
      format: 'COPC',
      sourcePointCount: 4_683_690,
      width: 120, depth: 80, height: 22,
      density: 488,
      hasRgb: true, hasIntensity: true, hasClassification: true,
      crsName: 'WGS 84 / UTM zone 12N (EPSG:32612)',
      crsUnit: 'metre',
    },
    visuals: [],
    annotations: ANNOTATIONS,
    measurements: MEASUREMENTS,
    unitSystem: 'metric',
    technicalNotes: 'Golden-fixture technical note.',
    provenance: droneProvenance(),
    sourceMetadata: {
      standard: [{ name: 'sensorModel', value: 'GoldenScan X1' }],
      extensions: [],
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Goldens
// ─────────────────────────────────────────────────────────────────────────────

describe('survey-summary golden (compact)', () => {
  it('names the capture type but carries none of the Technical Report detail blocks', async () => {
    const { text, failed } = await renderText(makeInputs('survey-summary'));
    expect(failed).toEqual([]);
    // Compact provenance present: heading + capture-type headline + disclaimer.
    expect(text).toContain('Provenance');
    expect(text).toContain('Capture type');
    // Dataset summary carries CRS + units.
    expect(text).toContain('Dataset summary');
    expect(text).toContain('UTM zone 12N');
    // Measurements + technical notes are Survey Summary material.
    expect(text).toContain('Measurements (1)');
    expect(text).toContain('Deck span');
    expect(text).toContain('Golden-fixture technical note.');
    // NO detail blocks: signals, cited accuracy, annotations, declared metadata.
    expect(text).not.toContain('Signals');
    expect(text).not.toContain('Expected accuracy (cited literature)');
    expect(text).not.toContain('Annotations (');
    expect(text).not.toContain('Spalling at pier base');
    expect(text).not.toContain('Declared source metadata');
    expect(text).not.toContain('GoldenScan X1');
  });
});

describe('technical-report golden (complete)', () => {
  it('contains everything Survey Summary has PLUS the full detail blocks', async () => {
    const { text, failed } = await renderText(makeInputs('technical-report'));
    expect(failed).toEqual([]);
    // The shared core.
    expect(text).toContain('Inspection summary');
    expect(text).toContain('Dataset summary');
    expect(text).toContain('UTM zone 12N');
    expect(text).toContain('Measurements (1)');
    expect(text).toContain('Golden-fixture technical note.');
    // Full provenance detail: signals + literature-cited bounds.
    expect(text).toContain('Signals');
    expect(text).toContain('Expected accuracy (cited literature)');
    expect(text).toContain('source:');
    // Annotations + the v0.5.4 declared-metadata section.
    expect(text).toContain('Annotations (1)');
    expect(text).toContain('Spalling at pier base');
    expect(text).toContain('Declared source metadata');
    expect(text).toContain('GoldenScan X1');
  });
});

describe('shared dataset block renders once per report', () => {
  it.each(['survey-summary', 'technical-report'] as const)('%s', async (id) => {
    const { text } = await renderText(makeInputs(id));
    expect(countOf(text, 'Dataset summary')).toBe(1);
    expect(countOf(text, 'Inspection summary')).toBe(1);
  });
});

describe('legacy template ids render via the engine', () => {
  it.each([
    ['engineering-inspection', 'technical-report'],
    ['qa-validation', 'technical-report'],
    ['technical-documentation', 'technical-report'],
    ['terrain-review', 'technical-report'],
    ['scan-acceptance', 'technical-report'],
  ] as const)('%s → %s', async (legacy, expected) => {
    const { templateId, text } = await renderText(makeInputs(legacy));
    expect(templateId).toBe(expected);
    // The mapped template's signature detail block is present.
    expect(text).toContain('Expected accuracy (cited literature)');
  });

  it('a genuinely unknown id still throws a precise error', async () => {
    await expect(generateReport(makeInputs('not-a-template'))).rejects.toThrow(
      /Unknown report template id/,
    );
  });
});
