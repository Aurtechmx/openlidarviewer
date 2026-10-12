import { describe, it, expect } from 'vitest';
import { openSync, readSync, closeSync } from 'node:fs';
import {
  recogniseUnsupported,
  recognisedUnsupportedMessage,
  RCS_MAGIC,
  RECOGNISE_BYTES,
} from '../src/io/recognisedUnsupported';
import { sniffFormat, SOURCE_FORMATS } from '../src/io/sniffFormat';
import { isRegisteredFormat } from '../src/io/formatInfo';

/** Synthetic bytes: an ASCII prefix followed by filler. */
function bytes(prefix: string, filler = 64): ArrayBuffer {
  const out = new Uint8Array(prefix.length + filler);
  for (let i = 0; i < prefix.length; i++) out[i] = prefix.charCodeAt(i);
  for (let i = prefix.length; i < out.length; i++) out[i] = (i * 37) & 0xff;
  return out.buffer;
}

const RCS_BODY =
  "Autodesk ReCap scan (.rcs) — not supported yet. OpenLiDARViewer can't read ReCap's RCS " +
  'format yet. In Autodesk ReCap, export the scan as E57 or LAS, then open that file here.';
const RCP_BODY =
  "Autodesk ReCap project (.rcp) — not supported yet. This is a ReCap project file. It points " +
  "to .rcs scans, which OpenLiDARViewer can't read yet. Export the scans from ReCap as E57 or LAS.";

describe('recogniseUnsupported — RCS by content', () => {
  it('recognises ADOCT-prefixed bytes named .rcs', () => {
    const r = recogniseUnsupported(bytes('ADOCT'), 'sample.rcs');
    expect(r?.kind).toBe('recognised-unsupported');
    expect(r?.format).toBe('rcs');
    expect(r?.name).toBe('Autodesk ReCap scan (.rcs)');
  });

  it('recognises ADOCT-prefixed bytes under another extension or none', () => {
    expect(recogniseUnsupported(bytes('ADOCT'), 'scan.bin')?.format).toBe('rcs');
    expect(recogniseUnsupported(bytes('ADOCT'), 'scan.las')?.format).toBe('rcs');
    expect(recogniseUnsupported(bytes('ADOCT'), 'scan')?.format).toBe('rcs');
  });

  it('does not claim a .rcs file whose bytes lack the magic', () => {
    expect(recogniseUnsupported(bytes('NOTRC'), 'sample.rcs')).toBeNull();
    expect(recogniseUnsupported(bytes('ADOC'), 'sample.rcs')).toBeNull(); // near miss
    expect(recogniseUnsupported(bytes('adoct'), 'sample.rcs')).toBeNull(); // case matters
    expect(recogniseUnsupported(new ArrayBuffer(0), 'sample.rcs')).toBeNull();
    // and the sniffer leaves it to the normal unknown-format handling
    expect(sniffFormat(bytes('NOTRC'), 'sample.rcs')).toBe('unknown');
  });

  it('a .rcs name on a real LAS head is not claimed', () => {
    expect(recogniseUnsupported(bytes('LASF', 200), 'scan.rcs')).toBeNull();
  });

  it('reads only the magic bytes', () => {
    expect(RCS_MAGIC).toBe('ADOCT');
    expect(RECOGNISE_BYTES).toBe(5);
    // exactly the magic and nothing else is enough
    expect(recogniseUnsupported(bytes('ADOCT', 0), 'x.rcs')?.format).toBe('rcs');
  });
});

describe('recogniseUnsupported — RCP by extension', () => {
  it('recognises a .rcp file by name', () => {
    const r = recogniseUnsupported(bytes('<?xml version="1.0"?>'), 'site.rcp');
    expect(r?.format).toBe('rcp');
    expect(r?.name).toBe('Autodesk ReCap project (.rcp)');
    expect(recogniseUnsupported(bytes('anything'), 'SITE.RCP')?.format).toBe('rcp');
  });

  it('does not recognise RCP from content alone', () => {
    expect(recogniseUnsupported(bytes('<?xml version="1.0"?>'), 'site.xml')).toBeNull();
  });

  it('lets a readable format win over the .rcp extension', () => {
    expect(recogniseUnsupported(bytes('LASF', 200), 'site.rcp')).toBeNull();
  });
});

describe('recognised formats are not loadable formats', () => {
  it('rcs and rcp are not in the source-format registry', () => {
    expect((SOURCE_FORMATS as readonly string[]).includes('rcs')).toBe(false);
    expect((SOURCE_FORMATS as readonly string[]).includes('rcp')).toBe(false);
    expect(isRegisteredFormat('rcs')).toBe(false);
    expect(isRegisteredFormat('rcp')).toBe(false);
  });
});

describe('recognisedUnsupportedMessage', () => {
  it('gives the exact RCS message', () => {
    const r = recogniseUnsupported(bytes('ADOCT'), 'sample.rcs')!;
    expect(r.title).toBe('Autodesk ReCap scan (.rcs) — not supported yet');
    expect(recognisedUnsupportedMessage(r)).toBe(RCS_BODY);
  });

  it('gives the exact RCP message', () => {
    const r = recogniseUnsupported(bytes('x'), 'site.rcp')!;
    expect(r.title).toBe('Autodesk ReCap project (.rcp) — not supported yet');
    expect(recognisedUnsupportedMessage(r)).toBe(RCP_BODY);
  });
});

// Optional local check against a real file. The path comes only from the
// environment; it is unset in CI, so this is skipped there. Only the first
// few bytes are read.
const privateFixture = process.env.OLV_PRIVATE_RCS_FIXTURE;
describe.skipIf(!privateFixture)('recogniseUnsupported — local real-file check', () => {
  it('recognises the file named by OLV_PRIVATE_RCS_FIXTURE as RCS', () => {
    const fd = openSync(privateFixture!, 'r');
    const head = new Uint8Array(64);
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    expect(recogniseUnsupported(head.buffer, 'local.rcs')?.format).toBe('rcs');
  });
});
