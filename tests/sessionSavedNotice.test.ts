import { describe, it, expect } from 'vitest';
import { sessionSavedNotice, sessionSavedWorkFromText } from '../src/export/exportScanIdentity';

describe('the session-saved notice', () => {
  it('counts what the file holds', () => {
    const text = JSON.stringify({ measurements: [{ id: 'a' }], annotations: [], views: [{ name: 'v1' }, { name: 'v2' }] });
    expect(sessionSavedWorkFromText(text)).toEqual({ measurements: 1, annotations: 0, views: 2 });
    expect(sessionSavedWorkFromText('not json')).toEqual({ measurements: 0, annotations: 0, views: 0 });
  });

  it('carries the sentence about work left out, so one toast does not replace the other', () => {
    const notice = sessionSavedNotice({ measurements: 1, annotations: 0, views: 2 }, false, '1 measurement or annotation left out of the session: its scan is closed.');
    expect(notice).toMatch(/^Session saved: 1 measurement, 0 annotations, 2 saved views\./);
    expect(notice).toMatch(/1 measurement or annotation left out of the session: its scan is closed\.$/);
    expect(sessionSavedNotice({ measurements: 1, annotations: 0, views: 2 }, false)).not.toMatch(/left out/);
  });
});
