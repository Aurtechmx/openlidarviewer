// What these tests would catch:
//
//  - A stream opened beside a static layer publishing its own coordinate
//    system while the static layer stayed the active scan, so that layer's
//    measurements read in the stream's units with nothing said.
//  - The notice firing when the two frames agree, or when nothing changed.

import { describe, it, expect } from 'vitest';
import { streamFrameNotice } from '../src/app/heavyReplace';

const feet = { name: 'NAD83 / Texas Central (ftUS)', epsg: 2277, linearUnit: 'us-foot' };
const metres = { name: 'WGS 84 / UTM zone 14N', epsg: 32614, linearUnit: 'metre' };

describe('streamFrameNotice', () => {
  it('says nothing when the frames agree', () => {
    expect(streamFrameNotice(feet, { ...feet })).toBeNull();
    expect(streamFrameNotice(null, null)).toBeNull();
    // No EPSG on either side: the same name and unit is the same frame.
    expect(streamFrameNotice({ name: 'Local grid', linearUnit: 'metre' }, { name: 'Local grid', linearUnit: 'metre' })).toBeNull();
  });

  it('names both frames and says which measurements to check when they differ', () => {
    const notice = streamFrameNotice(feet, metres);
    expect(notice).toContain('EPSG:32614');
    expect(notice).toContain('EPSG:2277');
    expect(notice).toMatch(/measurements on the earlier scan/i);
    expect(notice).toMatch(/stream's units/i);
  });

  it('treats a scan with no CRS against a stream with one as a change', () => {
    const notice = streamFrameNotice(null, metres);
    expect(notice).toContain('no CRS');
    expect(notice).toContain('EPSG:32614');
    expect(streamFrameNotice(feet, null)).toContain('no CRS');
  });

  it('falls back to the name when a frame has no EPSG code', () => {
    expect(streamFrameNotice({ name: 'Site grid', linearUnit: 'metre' }, metres)).toContain('Site grid');
  });
});
