// What these tests would catch:
//
//  - A cancelled or failed remote COPC open leaving the Streaming panel on
//    "Loading metadata…" with nothing streaming behind it.
//  - A failed remote open over a static scan running the full stream close,
//    which cleared the static scan's Dataset Intelligence card.
//  - The shell not wiring the abandon helper into the local and remote opens.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
const fn = (name: string): string => {
  const start = main.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf('\n}\n', start));
};

describe('abandoning an uncommitted streaming open', () => {
  it('hides and resets the panel without touching the open scene\'s cards', () => {
    const body = fn('abandonStreamingOpen');
    expect(body).toContain('streamingUi.endSession()');
    expect(body).not.toContain('clearDatasetIntelligence');
    expect(body).not.toContain('detachStreamingCloud');
  });

  it('is what a remote open runs when it ends with no stream, cancelled or failed', () => {
    const body = fn('handleRemoteCopc');
    expect(body).not.toContain('closeStreaming()');
    expect(body.match(/abandonStreamingOpen\(\)/g) ?? []).toHaveLength(2);
  });

  it('is wired into the local and the remote open dependencies', () => {
    expect(main.match(/abandonStreamingOpen,/g) ?? []).toHaveLength(2);
  });
});
