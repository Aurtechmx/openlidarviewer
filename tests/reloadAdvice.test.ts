/**
 * The reload sentence says what a reload costs, wherever it is shown.
 */
import { describe, expect, it } from 'vitest';
import { chunkFailureText } from '../src/app/staleChunkReload';
import { messageForCategory, RELOAD_ADVICE, RELOAD_COST } from '../src/io/loadErrors';

describe('reload advice', () => {
  it('reads as one sentence that names the cost', () => {
    expect(RELOAD_ADVICE).toBe('Reload the page to try again; a reload closes open scans, so save your session first if you can.');
    expect(RELOAD_ADVICE.endsWith(RELOAD_COST)).toBe(true);
  });

  it('is the advice for a failed chunk and for a failed resource load', () => {
    expect(chunkFailureText('Plan view')).toBe(`Plan view could not load. ${RELOAD_ADVICE}`);
    expect(messageForCategory('resource-load')).toContain(RELOAD_ADVICE);
  });
});
