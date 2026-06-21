/**
 * kmlExport.test.ts — the pure KML 2.2 exporter. We avoid DOMParser (not
 * guaranteed in Node) and instead sanity-check well-formedness via balanced
 * tag counts plus targeted substring/regex assertions: one Placemark per
 * annotation, lon,lat,alt coordinate order, the not-survey-grade caveat in
 * every description, the CRS name in the Document description, and correct XML
 * escaping of a hostile title.
 */

import { describe, it, expect } from 'vitest';
import { buildKml, type KmlExportInput, type KmlViewpoint } from '../src/export/kmlExport';
import type { Annotation } from '../src/render/annotate/types';
import type { Measurement } from '../src/render/measure/types';

const CAVEAT = 'Estimates only — not survey-grade.';

/** A fixed-offset transform: local [x,y,z] → [x+100, y+50, z]. Deterministic. */
const toLonLat = (p: readonly [number, number, number]): [number, number, number] => [
  p[0] + 100,
  p[1] + 50,
  p[2],
];

function annotation(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1',
    title: 'Crack',
    note: 'A note',
    type: 'issue',
    createdAt: 0,
    updatedAt: 0,
    localPosition: { x: 1, y: 2, z: 3 },
    ...over,
  };
}

const polyline: Measurement = {
  id: 'm1',
  kind: 'polyline',
  name: 'Path',
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
};

const area: Measurement = {
  id: 'm2',
  kind: 'area',
  name: 'Plot',
  closed: true,
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
  ],
};

const viewpoint: KmlViewpoint = {
  name: 'Overview',
  position: [5, 5, 50],
  target: [5, 5, 0],
};

function input(over: Partial<KmlExportInput> = {}): KmlExportInput {
  return {
    annotations: [annotation(), annotation({ id: 'a2', title: 'Note 2' })],
    measurements: [polyline, area],
    viewpoints: [viewpoint],
    crsName: 'WGS 84 / UTM zone 12N',
    unitLabel: 'm',
    toLonLat,
    notSurveyGradeNote: CAVEAT,
    ...over,
  };
}

/** Count occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('buildKml — structure', () => {
  it('emits a well-formed KML 2.2 document with balanced tags', () => {
    const kml = buildKml(input());
    expect(kml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(kml).toContain('<Document>');
    expect(kml.trimEnd().endsWith('</kml>')).toBe(true);

    // Balanced container tags.
    for (const tag of ['kml', 'Document', 'Placemark', 'Point', 'LineString', 'Polygon', 'LookAt', 'description', 'coordinates', 'name']) {
      expect(count(kml, `<${tag}>`) + count(kml, `<${tag} `)).toBe(count(kml, `</${tag}>`));
    }
  });

  it('one Placemark per annotation (plus the measurement + viewpoint placemarks)', () => {
    const kml = buildKml(input());
    // 2 annotations + 1 polyline + 1 area + 1 viewpoint = 5 placemarks.
    expect(count(kml, '<Placemark>')).toBe(5);
    expect(count(kml, '<Point>')).toBe(2);
    expect(count(kml, '<LineString>')).toBe(1);
    expect(count(kml, '<Polygon>')).toBe(1);
    expect(count(kml, '<LookAt>')).toBe(1);
  });

  it('the not-survey-grade caveat appears in every description', () => {
    const kml = buildKml(input());
    // 1 Document description + 5 feature descriptions = 6 occurrences.
    expect(count(kml, CAVEAT)).toBe(6);
    expect(count(kml, '<description>')).toBe(6);
  });

  it('the CRS name appears in the Document description', () => {
    const kml = buildKml(input());
    const docDesc = kml.slice(kml.indexOf('<Document>'), kml.indexOf('<Placemark>'));
    expect(docDesc).toContain('WGS 84 / UTM zone 12N');
    expect(docDesc).toContain(CAVEAT);
  });
});

describe('buildKml — coordinates', () => {
  it('annotation coordinates are lon,lat,alt in that order', () => {
    const kml = buildKml(input({ measurements: [], viewpoints: [], annotations: [annotation()] }));
    // local (1,2,3) → (101, 52, 3) = lon,lat,alt.
    expect(kml).toContain('<coordinates>101,52,3</coordinates>');
  });

  it('polyline coordinates are a space-separated lon,lat,alt list, closed not applied', () => {
    const kml = buildKml(input({ annotations: [], viewpoints: [], measurements: [polyline] }));
    expect(kml).toContain('<coordinates>100,50,0 110,50,0 110,60,0</coordinates>');
  });

  it('area polygon ring is closed (first vertex repeated last)', () => {
    const kml = buildKml(input({ annotations: [], viewpoints: [], measurements: [area] }));
    expect(kml).toContain(
      '<coordinates>100,50,0 110,50,0 110,60,0 100,60,0 100,50,0</coordinates>',
    );
    expect(kml).toContain('<outerBoundaryIs>');
    expect(kml).toContain('<LinearRing>');
  });

  it('viewpoint emits a LookAt at the target with lon/lat/alt', () => {
    const kml = buildKml(input({ annotations: [], measurements: [], viewpoints: [viewpoint] }));
    expect(kml).toContain('<longitude>105</longitude>');
    expect(kml).toContain('<latitude>55</latitude>');
    expect(kml).toContain('<altitude>0</altitude>');
  });
});

describe('buildKml — escaping', () => {
  it('escapes & < > " in a title', () => {
    const hostile = 'A & B < C > D "E"';
    const kml = buildKml(
      input({
        annotations: [annotation({ title: hostile })],
        measurements: [],
        viewpoints: [],
      }),
    );
    expect(kml).toContain('A &amp; B &lt; C &gt; D &quot;E&quot;');
    expect(kml).not.toContain('<name>A & B');
  });
});

describe('buildKml — empty input', () => {
  it('produces a minimal valid kml/Document with no placemarks', () => {
    const kml = buildKml(
      input({ annotations: [], measurements: [], viewpoints: [], crsName: null }),
    );
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(kml).toContain('<Document>');
    expect(kml).toContain('</Document>');
    expect(kml.trimEnd().endsWith('</kml>')).toBe(true);
    expect(count(kml, '<Placemark>')).toBe(0);
    // The caveat still rides along in the Document description.
    expect(count(kml, '<description>')).toBe(1);
    expect(kml).toContain(CAVEAT);
    expect(kml).toContain('unknown CRS');
  });
});
