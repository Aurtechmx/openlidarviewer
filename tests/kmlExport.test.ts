/**
 * kmlExport.test.ts — the pure KML 2.2 exporter. We avoid DOMParser (not
 * guaranteed in Node) and instead sanity-check well-formedness via balanced
 * tag counts plus targeted substring/regex assertions: one Placemark per
 * annotation, lon,lat,alt coordinate order, the not-survey-grade caveat in
 * every description, the CRS name in the Document description, and correct XML
 * escaping of a hostile title.
 */

import { describe, it, expect } from 'vitest';
import { buildKml, type KmlExportInput, type KmlViewpoint, kmlAltitudeMode } from '../src/export/kmlExport';
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
    up: [0, 0, 1],
    unitToMetres: 1,
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
  // These fix coordinate ORDER, which needs a third ordinate present to be
  // observable — so they declare a proven metric orthometric datum. Without
  // one the geometry is 2D by policy; that case is covered by the
  // "omits the third ordinate" test below.
  it('annotation coordinates are lon,lat,alt in that order', () => {
    const kml = buildKml(input({ measurements: [], viewpoints: [], annotations: [annotation()], verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
    // local (1,2,3) → (101, 52, 3) = lon,lat,alt.
    expect(kml).toContain('<coordinates>101,52,3</coordinates>');
  });

  it('polyline coordinates are a space-separated lon,lat,alt list, closed not applied', () => {
    const kml = buildKml(input({ annotations: [], viewpoints: [], measurements: [polyline], verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
    expect(kml).toContain('<coordinates>100,50,0 110,50,0 110,60,0</coordinates>');
  });

  it('area polygon ring is closed (first vertex repeated last)', () => {
    const kml = buildKml(input({ annotations: [], viewpoints: [], measurements: [area], verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
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

describe('buildKml — measured values', () => {
  it('reports metres, scaling render units by unitToMetres (foot scan)', () => {
    // polyline render-unit length = 10 + 10 = 20; at 0.3048 m/unit → 6.096 m.
    const kml = buildKml(
      input({ annotations: [], viewpoints: [], measurements: [polyline], unitToMetres: 0.3048 }),
    );
    expect(kml).toContain('length_m=6.096');
  });

  it('reports raw metres for a metric scan (unitToMetres = 1)', () => {
    const kml = buildKml(input({ annotations: [], viewpoints: [], measurements: [polyline], verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
    expect(kml).toContain('length_m=20');
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

/**
 * A KML <coordinates> element is geographic by specification, so a value the
 * exporter cannot express as a real longitude/latitude has no honest
 * representation. Substituting '0' placed the feature at 0°N 0°E — Null Island,
 * in the Gulf of Guinea — which reads as a successful export of a real place.
 *
 * The sibling defect (the mapper returning raw easting/northing when conversion
 * failed) was closed separately; this is the same class one layer down, where
 * the number is already non-finite by the time it reaches formatting.
 */
describe('buildKml — a coordinate it cannot express is refused', () => {
  const nonFinite = (bad: number) => (): [number, number, number] => [bad, 40, 100];

  it('refuses NaN rather than writing 0,0', () => {
    expect(() => buildKml(input({ toLonLat: nonFinite(NaN) }))).toThrow(/coordinate/i);
  });

  it('refuses Infinity', () => {
    expect(() => buildKml(input({ toLonLat: nonFinite(Infinity) }))).toThrow(/coordinate/i);
  });

  it('never emits the Null Island coordinate for a bad input', () => {
    let text = '';
    try {
      text = buildKml(input({ toLonLat: nonFinite(NaN) }));
    } catch {
      text = '';
    }
    expect(text).not.toContain('0,0,');
  });

  it('still builds normally when every coordinate is finite', () => {
    expect(buildKml(input())).toContain('<kml');
  });

  it('refuses a longitude outside the geographic domain', () => {
    // An easting that slipped through as a longitude is finite but impossible;
    // the domain check is what catches that shape.
    expect(() => buildKml(input({ toLonLat: () => [500000, 40, 0] }))).toThrow(/longitude/i);
  });

  it('refuses a latitude outside the geographic domain', () => {
    expect(() => buildKml(input({ toLonLat: () => [-111, 4400000, 0] }))).toThrow(/latitude/i);
  });
});

/**
 * KML geometries must state how their altitude is treated.
 *
 * With no `<altitudeMode>` a reader applies the default — `clampToGround` —
 * and the altitude in `<coordinates>` is silently discarded onto whatever
 * terrain the viewer happens to have. Nothing told the reader the heights
 * were dropped. And `absolute` is a specific claim: metres above sea level.
 * Claiming it for an undeclared datum, or for heights in feet, places every
 * feature at a height it does not have.
 */
describe('KML altitude mode', () => {
  it('claims absolute only for a declared metric vertical datum', () => {
    expect(kmlAltitudeMode('EPSG:5703', 1).mode).toBe('absolute');
    // This line used to assert that an UNDECLARED vertical unit still counted
    // as metres. It encoded the defect: absence of a unit is not evidence of
    // one, and the value can arrive via a path that substitutes the
    // horizontal factor.
    expect(kmlAltitudeMode('EPSG:5703', undefined).mode).toBe('clampToGround');
  });

  it('clamps when no vertical datum is declared', () => {
    expect(kmlAltitudeMode(null, 1).mode).toBe('clampToGround');
    expect(kmlAltitudeMode(undefined, 1).mode).toBe('clampToGround');
    expect(kmlAltitudeMode('   ', 1).mode).toBe('clampToGround');
  });

  it('clamps when the vertical unit is not metres', () => {
    // KML absolute altitude is defined in metres; a foot height written as
    // absolute is out by a factor of three.
    expect(kmlAltitudeMode('EPSG:6360', 0.3048).mode).toBe('clampToGround');
  });

  it('always explains the treatment in words', () => {
    expect(kmlAltitudeMode(null, 1).reason).toMatch(/no vertical datum|not authoritative/i);
    expect(kmlAltitudeMode('EPSG:6360', 0.3048).reason).toMatch(/metres/i);
    expect(kmlAltitudeMode('EPSG:5703', 1).reason).toContain('EPSG:5703');
  });
});

describe('KML viewpoint follows the same altitude policy', () => {
  it('does not claim absolute for the camera when the features are clamped', () => {
    // A file whose measurements are clamped because the vertical reference is
    // unproven must not place its camera on a sea-level altitude.
    const clamped = buildKml(input({ verticalDatum: null }));
    const declared = buildKml(input({ verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
    if (clamped.includes('<LookAt>')) {
      expect(clamped.split('<LookAt>')[1]).toContain('clampToGround');
      expect(declared.split('<LookAt>')[1]).toContain('absolute');
    }
    // Geometry and camera must never disagree about the same file.
    expect(clamped).not.toContain('<altitudeMode>absolute</altitudeMode>');
  });
});

/**
 * `absolute` is a claim about MEAN SEA LEVEL, not about "a datum exists".
 *
 * The gate used to be "some vertical datum string is present AND the unit
 * factor is 1", which a WGS 84 ellipsoidal height passes — and an ellipsoidal
 * height is not a sea-level height, it differs from one by the geoid
 * separation, tens of metres in places. A depth axis passes the same gate and
 * is sign-flipped on top of that. Only a recognised metric orthometric
 * reference may be claimed, and everything else must not merely be labelled
 * clamped: the unproven altitude must not be written into the geometry at all.
 */
describe('KML altitude — only proven sea-level heights are claimed', () => {
  it('accepts the metric orthometric allow-list', () => {
    for (const d of ['EPSG:5703', 'NAVD88', 'EPSG:5714', 'EPSG:3855', 'EPSG:5773']) {
      expect(kmlAltitudeMode(d, 1).mode).toBe('absolute');
    }
  });

  it('does NOT claim absolute for a WGS 84 ellipsoidal height', () => {
    expect(kmlAltitudeMode('EPSG:4979', 1).mode).toBe('clampToGround');
  });

  it('does NOT claim absolute for a depth axis', () => {
    expect(kmlAltitudeMode('EPSG:5715', 1).mode).toBe('clampToGround');
  });

  it('does NOT claim absolute for an unrecognised datum label', () => {
    expect(kmlAltitudeMode('Site benchmark A', 1).mode).toBe('clampToGround');
  });

  it('omits the third ordinate entirely when the vertical reference is unproven', () => {
    const kml = buildKml(input({ verticalDatum: null }));
    expect(kml).toContain('<altitudeMode>clampToGround</altitudeMode>');
    // 2D geometry: "lon,lat" pairs only, never a third ordinate.
    for (const m of kml.matchAll(/<coordinates>([^<]*)<\/coordinates>/g)) {
      for (const tuple of m[1].split(' ')) {
        expect(tuple.split(',').length).toBe(2);
      }
    }
  });

  it('keeps the third ordinate only for a proven metric orthometric datum', () => {
    const kml = buildKml(input({ verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
    expect(kml).toContain('<altitudeMode>absolute</altitudeMode>');
    expect(kml).toContain('<coordinates>101,52,3</coordinates>');
  });

  it('discloses the source elevation with its unit and datum in every description', () => {
    const undeclared = buildKml(input({ verticalDatum: null }));
    expect(undeclared).toMatch(/Source elevation/);
    expect(undeclared).toMatch(/undeclared/i);

    const feet = buildKml(input({ verticalDatum: 'EPSG:6360', verticalUnitToMetres: 0.3048 }));
    expect(feet).toMatch(/Source elevation/);
    expect(feet).toContain('0.3048');
    expect(feet).toContain('EPSG:6360');

    const ortho = buildKml(input({ verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
    expect(ortho).toMatch(/Source elevation/);
    expect(ortho).toContain('EPSG:5703');
  });
});

/**
 * An unstated vertical unit is not a metre.
 *
 * `metric` read `verticalUnitToMetres === undefined || ≈1`, so a source that
 * declared a recognised orthometric datum but never declared its vertical UNIT
 * satisfied it and was written as absolute metres above sea level. Absence of
 * a unit is not evidence of metres — and the value reaching this function came
 * through a path that falls back to the HORIZONTAL factor, so a foot-based
 * scan could arrive looking metric.
 *
 * Fail closed: the unit must be present, finite and one.
 */
describe('KML absolute requires a stated metric vertical unit', () => {
  it('refuses absolute when the vertical unit is undeclared', () => {
    expect(kmlAltitudeMode('EPSG:5703', undefined).mode).toBe('clampToGround');
  });

  it('refuses absolute for a non-finite or absurd unit', () => {
    expect(kmlAltitudeMode('EPSG:5703', Number.NaN).mode).toBe('clampToGround');
    expect(kmlAltitudeMode('EPSG:5703', 0).mode).toBe('clampToGround');
  });

  it('still allows absolute when metres are explicitly stated', () => {
    expect(kmlAltitudeMode('EPSG:5703', 1).mode).toBe('absolute');
  });

  it('says the unit was the reason, not the datum', () => {
    expect(kmlAltitudeMode('EPSG:5703', undefined).reason).toMatch(/unit/i);
  });
});

/**
 * An unknown vertical scale must not become "metres" in the description.
 *
 * The altitude MODE already fails closed for an undeclared unit — geometry
 * goes 2D and clamps. But the description that discloses the omitted height
 * ran `f === undefined || ≈1 ? 'metres' : ...`, so the very case where the
 * scale is unknown printed "Source elevation: 12.5 metres". The geometry was
 * honest and the prose beside it was not, which is worse than either alone:
 * a reader takes the number and the unit together.
 */
describe('KML description never invents a vertical unit', () => {
  it('says the scale is unknown when it is', () => {
    const kml = buildKml(input({ verticalDatum: 'EPSG:5703', verticalUnitToMetres: undefined }));
    expect(kml).toMatch(/scale unknown/i);
    // Scoped to the elevation clause itself. The clamp REASON legitimately
    // says "absolute altitude is defined in metres", and a looser pattern
    // reached across into it — the test would have failed on correct code.
    const clause = /Source elevation:[^.]*\./i.exec(kml)?.[0] ?? '';
    expect(clause).not.toMatch(/\bmetres\b/i);
  });

  it('says metres only when metres are stated', () => {
    const kml = buildKml(input({ verticalDatum: 'EPSG:5703', verticalUnitToMetres: 1 }));
    expect(kml).toMatch(/Source elevation:[^<]*metres/i);
  });

  it('states the conversion factor for a non-metre unit', () => {
    const kml = buildKml(input({ verticalDatum: 'EPSG:6360', verticalUnitToMetres: 0.3048 }));
    expect(kml).toMatch(/1 unit = 0\.3048 m/);
  });
});
