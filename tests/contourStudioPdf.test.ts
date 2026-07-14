import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildContourStudioPdf } from '../src/terrain/export/contourStudioPdf';
import {
  buildContourPdfModel,
  type ContourPdfInput,
} from '../src/terrain/contourStudio/contourDeliverablePdfModel';

// A minimal, honest PR10 model fixture. Every number here is arbitrary-but-
// stated; the emitter must render exactly what the model carries, nothing more.
function baseInput(): ContourPdfInput {
  return {
    title: 'Test Site',
    provenance: {
      software: 'OpenLiDARViewer',
      softwareVersion: '0.5.9',
      gitCommit: 'abc1234',
      generated: '2026-07-12T00:00:00.000Z',
      crs: 'EPSG:32610',
      verticalDatum: 'EGM2008 height',
      horizontalUnit: 'm',
      verticalUnit: 'm',
      grid: '10x10 @ 1 m',
      methodIds: ['olv.contour.analytical@1'],
      sourceHash: 'deadbeefcafe',
    },
    support: { measuredPct: 80, interpolatedPct: 15, unsupportedPct: 5 },
    validation: {
      mode: 'holdout-cross-validation',
      rmseM: 0.123,
      sampleSize: 42,
      independentCheckpoints: false,
    },
    decision: { status: 'validated', badge: 'Internal validation', caveats: [] },
    geometry: { cartographic: false, analyticalAvailable: true },
  };
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

describe('buildContourStudioPdf (multipage Contour Studio PDF emitter)', () => {
  it('emits real PDF bytes for a validated model, one page per model page', async () => {
    const model = buildContourPdfModel(baseInput());
    const bytes = await buildContourStudioPdf(model);

    // %PDF- magic.
    expect(bytes[0]).toBe(PDF_MAGIC[0]);
    expect(bytes[1]).toBe(PDF_MAGIC[1]);
    expect(bytes[2]).toBe(PDF_MAGIC[2]);
    expect(bytes[3]).toBe(PDF_MAGIC[3]);

    // Non-trivial byte length.
    expect(bytes.byteLength).toBeGreaterThan(500);

    // One PDF page per model page/section (base model = 4 pages).
    expect(model.pages.length).toBe(4);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(model.pages.length);
  });

  it('emits an exploratory (watermarked) model including the optional standards page', async () => {
    const model = buildContourPdfModel({
      ...baseInput(),
      decision: {
        status: 'exploratory',
        badge: 'Exploratory',
        watermark: 'EXPLORATORY',
        caveats: ['These outputs are not survey-grade.'],
      },
      standardsTraceability: true,
    });
    expect(model.watermark).toBe('EXPLORATORY');
    expect(model.pages.length).toBe(5);

    const bytes = await buildContourStudioPdf(model);
    expect(bytes[0]).toBe(PDF_MAGIC[0]);
    expect(bytes[1]).toBe(PDF_MAGIC[1]);
    expect(bytes.byteLength).toBeGreaterThan(500);

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(model.pages.length);
  });
});
