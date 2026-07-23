/**
 * remoteSourceNaming.test.ts — naming and error text for remote scans.
 *
 * These were three helpers inside main.ts: derive a display name from an EPT or
 * COPC url, and turn a range-read failure into an honest message. Pure string
 * and URL work, and exactly where edge cases bite — percent-encoded segments, a
 * trailing slash, a url with no path, a garbage url that must not throw — yet
 * none of it had a test. A wrong branch here shows the user a misleading file
 * name or the wrong remedy for a failure.
 */

import { describe, it, expect } from 'vitest';
import {
  remoteEptName,
  remoteCopcName,
  describeRemoteCopcError,
  shortHost,
} from '../src/app/remoteSourceNaming';
import { RangeReadError } from '../src/io/range/RangeSource';

describe('remoteEptName', () => {
  it('names the dataset folder above ept.json, with the (EPT) tag', () => {
    expect(remoteEptName('https://s3.example.com/data/autzen/ept.json')).toBe('autzen (EPT)');
  });

  it('is case-insensitive about the ept.json suffix', () => {
    expect(remoteEptName('https://h/data/Site/EPT.JSON')).toBe('Site (EPT)');
  });

  it('decodes a percent-encoded folder name', () => {
    expect(remoteEptName('https://h/tiles/North%20Ridge/ept.json')).toBe('North Ridge (EPT)');
  });

  it('falls back when the url has no usable path', () => {
    expect(remoteEptName('https://h/ept.json')).toBe('remote.ept');
  });

  it('falls back rather than throwing on a malformed url', () => {
    expect(remoteEptName('not a url')).toBe('remote.ept');
  });
});

describe('remoteCopcName', () => {
  it('takes the file name from the url path', () => {
    expect(remoteCopcName('https://h/scans/site.copc.laz')).toBe('site.copc.laz');
  });

  it('decodes a percent-encoded file name', () => {
    expect(remoteCopcName('https://h/a/my%20scan.copc.laz')).toBe('my scan.copc.laz');
  });

  it('falls back on a trailing slash (no file segment)', () => {
    expect(remoteCopcName('https://h/scans/')).toBe('remote.copc.laz');
  });

  it('falls back rather than throwing on a malformed url', () => {
    expect(remoteCopcName('::::')).toBe('remote.copc.laz');
  });
});

describe('shortHost', () => {
  it('reduces a url to its host', () => {
    expect(shortHost('https://data.example.com/a/b/c.laz?x=1')).toBe('data.example.com');
  });

  it('returns the input unchanged when it is not a url', () => {
    expect(shortHost('garbage')).toBe('garbage');
  });
});

describe('describeRemoteCopcError', () => {
  const URL_ = 'https://data.example.com/scan.copc.laz';

  it('adds a hosting hint for an unsupported-range host', () => {
    const e = new RangeReadError('range-unsupported', 'The host does not support range requests.');
    const msg = describeRemoteCopcError(e, URL_);
    expect(msg).toContain('range requests');
    expect(msg).toContain('S3');
  });

  it('adds a CORS hint for a transport failure', () => {
    const e = new RangeReadError('transport', 'Could not reach the host.');
    expect(describeRemoteCopcError(e, URL_)).toContain('CORS');
  });

  it('adds a retry hint for a timeout', () => {
    const e = new RangeReadError('timeout', 'The request timed out.');
    expect(describeRemoteCopcError(e, URL_)).toContain('again');
  });

  it('passes an unrecognised range code through with its own message', () => {
    // 'aborted' and 'out-of-range' are valid codes the message switch does not
    // special-case, so they return err.message verbatim with no appended hint.
    const e = new RangeReadError('aborted', 'The load was cancelled.');
    expect(describeRemoteCopcError(e, URL_)).toBe('The load was cancelled.');
  });

  it('for a non-range error, names the host and says it is not a valid COPC', () => {
    const msg = describeRemoteCopcError(new Error('bad magic'), URL_);
    expect(msg).toContain('data.example.com');
    expect(msg).toContain('could not be read as a COPC');
    expect(msg).toContain('bad magic');
  });

  it('does not throw on a non-Error thrown value', () => {
    const msg = describeRemoteCopcError('a bare string', URL_);
    expect(msg).toContain('unknown error');
  });
});
