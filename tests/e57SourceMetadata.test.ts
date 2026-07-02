/**
 * e57SourceMetadata.test.ts
 *
 * The declared-only source-metadata capture added in v0.5.4: standard E57
 * root/scan provenance fields plus generic extension-namespace (e.g. `olv:`)
 * String/Integer/Float leaf elements, threaded from the XML schema reader
 * through `parseE57`'s result into `CloudMetadata.sourceMetadata`.
 *
 * Honesty contract pinned here:
 *   - Only DECLARED values appear. The E57 empty-element quirk (an empty
 *     element with a type attribute means the type's default — Integer/Float
 *     0, String "") must NOT fabricate rows: a zero dateTimeValue and empty
 *     strings are treated as not declared and omitted.
 *   - Extension fields carry their namespace URI and document order.
 *   - Malformed metadata degrades to omission, never a throw.
 */

import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/io/e57/xml';
import { readE57Document } from '../src/io/e57/schema';

const OLV_NS = 'https://aurtech.mx/openlidarviewer/metadata/1.0';

/** A minimal single-scan E57 XML document in the shape pye57 writes. */
function doc(opts: {
  rootExtra?: string;
  scanExtra?: string;
  scans?: number;
  rootAttrs?: string;
} = {}): string {
  const scans = opts.scans ?? 1;
  const scanBlock = (i: number): string => `
    <vectorChild type="Structure">
      <guid type="String"><![CDATA[{scan-guid-${i}}]]></guid>
      <name type="String"><![CDATA[Tikal Temple I synthetic reference model — A. Urias / Aurtech]]></name>
      <temperature type="Float"/>
      <relativeHumidity type="Float"/>
      <atmosphericPressure type="Float"/>
      <description type="String"><![CDATA[pye57 v0.4.19]]></description>
      <intensityLimits type="Structure">
        <intensityMinimum type="Float">2.80005693435668945e-01</intensityMinimum>
        <intensityMaximum type="Float">7.3806452751159668e-01</intensityMaximum>
      </intensityLimits>
      <colorLimits type="Structure">
        <colorRedMinimum type="Integer"/>
        <colorRedMaximum type="Integer">255</colorRedMaximum>
        <colorGreenMinimum type="Integer"/>
        <colorGreenMaximum type="Integer">255</colorGreenMaximum>
        <colorBlueMinimum type="Integer"/>
        <colorBlueMaximum type="Integer">255</colorBlueMaximum>
      </colorLimits>
      <acquisitionStart type="Structure">
        <dateTimeValue type="Float"/>
        <isAtomicClockReferenced type="Integer"/>
      </acquisitionStart>
      <acquisitionEnd type="Structure">
        <dateTimeValue type="Float"/>
      </acquisitionEnd>
      <points type="CompressedVector" fileOffset="48" recordCount="4">
        <prototype type="Structure">
          <cartesianX type="Float" precision="single"/>
          <cartesianY type="Float" precision="single"/>
          <cartesianZ type="Float" precision="single"/>
        </prototype>
        <codecs type="Vector"/>
      </points>
      <sensorVendor type="String"><![CDATA[Aurtech]]></sensorVendor>
      <sensorModel type="String"><![CDATA[Procedural heritage reference reconstruction]]></sensorModel>
      <sensorSerialNumber type="String"><![CDATA[SYNTHETIC-TIKAL-I-001]]></sensorSerialNumber>
      ${opts.scanExtra ?? ''}
    </vectorChild>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<e57Root type="Structure"
         xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0"
         xmlns:olv="${OLV_NS}" ${opts.rootAttrs ?? ''}>
  <formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName>
  <guid type="String"><![CDATA[{root-guid}]]></guid>
  <versionMajor type="Integer">1</versionMajor>
  <versionMinor type="Integer"/>
  <e57LibraryVersion type="String"><![CDATA[pye57-0.4.19]]></e57LibraryVersion>
  <coordinateMetadata type="String"><![CDATA[LOCAL_CARTESIAN_METRES; no geodetic CRS]]></coordinateMetadata>
  <creationDateTime type="Structure">
    <dateTimeValue type="Float">1.4670216e+09</dateTimeValue>
    <isAtomicClockReferenced type="Integer"/>
  </creationDateTime>
  <data3D type="Vector" allowHeterogeneousChildren="1">
    ${Array.from({ length: scans }, (_, i) => scanBlock(i + 1)).join('\n')}
  </data3D>
  <images2D type="Vector"/>
  ${opts.rootExtra ?? ''}
</e57Root>`;
}

const OLV_ROOT_FIELDS = `
  <olv:title type="String"><![CDATA[Tikal Temple I — reference-based synthetic E57 point cloud]]></olv:title>
  <olv:author type="String"><![CDATA[A. Urias]]></olv:author>
  <olv:license type="String"><![CDATA[CC-BY-4.0]]></olv:license>
  <olv:datasetType type="String"><![CDATA[synthetic_reference_reconstruction]]></olv:datasetType>
  <olv:accuracyClass type="String"><![CDATA[reference_based_not_survey_grade]]></olv:accuracyClass>
  <olv:levelCount type="String"><![CDATA[9]]></olv:levelCount>`;

function fieldMap(fields: readonly { name: string; value: string }[]): Map<string, string> {
  return new Map(fields.map((f) => [f.name, f.value]));
}

describe('readE57Document — declared standard fields', () => {
  const sm = readE57Document(parseXml(doc()))!.sourceMetadata;

  it('captures the declared root fields', () => {
    expect(sm).not.toBeNull();
    const std = fieldMap(sm!.standard);
    expect(std.get('guid')).toBe('{root-guid}');
    expect(std.get('scan guid')).toBe('{scan-guid-1}');
    expect(std.get('e57LibraryVersion')).toBe('pye57-0.4.19');
    expect(std.get('coordinateMetadata')).toBe('LOCAL_CARTESIAN_METRES; no geodetic CRS');
  });

  it('converts a non-zero creationDateTime from the GPS epoch and labels it', () => {
    const std = fieldMap(sm!.standard);
    const created = std.get('creationDateTime');
    // 1.4670216e9 s after 1980-01-06 lands in 2026. The GPS seconds stay
    // VERBATIM as written in the file (leap seconds are not applied, and
    // the label says where the number came from).
    expect(created).toMatch(/^2026-07-02T\d{2}:\d{2}:\d{2}Z \(GPS time 1\.4670216e\+09\)$/);
  });

  it('captures the declared per-scan fields verbatim', () => {
    const std = fieldMap(sm!.standard);
    expect(std.get('name')).toBe(
      'Tikal Temple I synthetic reference model — A. Urias / Aurtech',
    );
    expect(std.get('description')).toBe('pye57 v0.4.19');
    expect(std.get('sensorVendor')).toBe('Aurtech');
    expect(std.get('sensorModel')).toBe('Procedural heritage reference reconstruction');
    expect(std.get('sensorSerialNumber')).toBe('SYNTHETIC-TIKAL-I-001');
  });

  it('formats declared intensity and colour limits', () => {
    const std = fieldMap(sm!.standard);
    expect(std.get('intensityLimits')).toBe(
      '0.28000569343566895 to 0.7380645275115967',
    );
    // Empty minima are the spec default (0) NEXT TO a declared maximum —
    // that pairing is a real declaration and renders as 0 to 255.
    expect(std.get('colorLimits')).toBe('R 0 to 255, G 0 to 255, B 0 to 255');
  });

  it('omits empty-element defaults: no fabricated zeros', () => {
    const std = fieldMap(sm!.standard);
    // temperature / relativeHumidity / atmosphericPressure are empty
    // elements (Float default 0) — not declarations.
    expect(std.has('temperature')).toBe(false);
    expect(std.has('relativeHumidity')).toBe(false);
    expect(std.has('atmosphericPressure')).toBe(false);
    // acquisitionStart / End carry a zero (empty) dateTimeValue — undeclared.
    expect(std.has('acquisitionStart')).toBe(false);
    expect(std.has('acquisitionEnd')).toBe(false);
  });
});

describe('readE57Document — extension-namespace fields', () => {
  it('captures root-level extension leaves with namespace URI, in order', () => {
    const sm = readE57Document(parseXml(doc({ rootExtra: OLV_ROOT_FIELDS })))!.sourceMetadata!;
    expect(sm.extensions.map((f) => f.name)).toEqual([
      'title', 'author', 'license', 'datasetType', 'accuracyClass', 'levelCount',
    ]);
    expect(sm.extensions[0].value).toBe(
      'Tikal Temple I — reference-based synthetic E57 point cloud',
    );
    expect(sm.extensions[3].value).toBe('synthetic_reference_reconstruction');
    for (const f of sm.extensions) expect(f.namespaceUri).toBe(OLV_NS);
  });

  it('captures scan-level extension leaves before root-level ones', () => {
    const sm = readE57Document(
      parseXml(doc({
        scanExtra: '<olv:creator type="String"><![CDATA[A. Urias]]></olv:creator>',
        rootExtra: '<olv:license type="String"><![CDATA[CC-BY-4.0]]></olv:license>',
      })),
    )!.sourceMetadata!;
    expect(sm.extensions.map((f) => f.name)).toEqual(['creator', 'license']);
  });

  it('captures any prefix, keeping an unresolvable one with no URI', () => {
    const sm = readE57Document(
      parseXml(doc({
        rootExtra: '<mystery:field type="String"><![CDATA[value]]></mystery:field>',
      })),
    )!.sourceMetadata!;
    const f = sm.extensions.find((x) => x.name === 'field');
    expect(f?.value).toBe('value');
    expect(f?.namespaceUri).toBeUndefined();
  });

  it('does NOT treat prefixed E57-core-namespace elements as extensions', () => {
    const sm = readE57Document(
      parseXml(doc({
        rootAttrs: 'xmlns:e57="http://www.astm.org/COMMIT/E57/2010-e57-v1.0"',
        rootExtra: '<e57:vendorNote type="String"><![CDATA[core-ns]]></e57:vendorNote>',
      })),
    )!.sourceMetadata!;
    expect(sm.extensions.find((x) => x.name === 'vendorNote')).toBeUndefined();
  });

  it('omits empty extension elements (type defaults are not declarations)', () => {
    const sm = readE57Document(
      parseXml(doc({
        rootExtra: `
          <olv:emptyString type="String"/>
          <olv:emptyInt type="Integer"/>
          <olv:emptyFloat type="Float"/>
          <olv:real type="Integer">7</olv:real>`,
      })),
    )!.sourceMetadata!;
    expect(sm.extensions.map((f) => f.name)).toEqual(['real']);
    expect(sm.extensions[0].value).toBe('7');
  });

  it('ignores non-scalar and untyped extension elements', () => {
    const sm = readE57Document(
      parseXml(doc({
        rootExtra: `
          <olv:struct type="Structure"><olv:inner type="String">x</olv:inner></olv:struct>
          <olv:blob type="Blob">deadbeef</olv:blob>
          <olv:untyped>loose text</olv:untyped>`,
      })),
    )!.sourceMetadata!;
    // The Structure and Blob and untyped leaves are all skipped; nothing
    // from the hostile block leaks into the declared list.
    expect(sm.extensions).toEqual([]);
  });
});

describe('readE57Document — multi-scan and degradation', () => {
  it('prefixes per-scan fields with the scan index when scans > 1', () => {
    const sm = readE57Document(parseXml(doc({ scans: 2 })))!.sourceMetadata!;
    const std = fieldMap(sm.standard);
    expect(std.has('scan 1 sensorModel')).toBe(true);
    expect(std.has('scan 2 sensorModel')).toBe(true);
    expect(std.has('sensorModel')).toBe(false);
  });

  it('returns null sourceMetadata when nothing beyond geometry is declared', () => {
    const bare = `<?xml version="1.0"?>
      <e57Root type="Structure">
        <data3D type="Vector">
          <vectorChild type="Structure">
            <points type="CompressedVector" fileOffset="0" recordCount="1">
              <prototype type="Structure">
                <cartesianX type="Float"/><cartesianY type="Float"/><cartesianZ type="Float"/>
              </prototype>
            </points>
          </vectorChild>
        </data3D>
      </e57Root>`;
    const parsed = readE57Document(parseXml(bare));
    expect(parsed.sourceMetadata).toBeNull();
  });

  it('degrades hostile metadata to omission, never a throw', () => {
    // A dateTimeValue that is not a number, limits with garbage text, and
    // an extension field with a hostile name must not sink the document
    // read — and must not fabricate values.
    const hostile = doc({
      rootExtra: `
        <olv:ok type="String"><![CDATA[fine]]></olv:ok>
        <olv:nan type="Float">not-a-number</olv:nan>`,
    }).replace(
      '<dateTimeValue type="Float">1.4670216e+09</dateTimeValue>',
      '<dateTimeValue type="Float">bogus</dateTimeValue>',
    );
    const parsed = readE57Document(parseXml(hostile));
    const sm = parsed.sourceMetadata!;
    const std = fieldMap(sm.standard);
    expect(std.has('creationDateTime')).toBe(false); // unparseable → omitted
    expect(sm.extensions.map((f) => f.name)).toContain('ok');
    // A Float extension whose text isn't numeric is still the writer's
    // verbatim declaration of SOMETHING — but it is not a valid scalar, so
    // it is carried verbatim (strings are never coerced).
    expect(sm.extensions.find((f) => f.name === 'nan')?.value).toBe('not-a-number');
    // Geometry interpretation is untouched.
    expect(parsed.scans).toHaveLength(1);
  });
});
