/**
 * heavyLasFullReveal.test.ts — a committed out-of-core LAS opens with the full
 * streaming surface, not just the dock and inspector chrome.
 *
 * The bridge (`#657`) attached an `OlvTileSource` and turned on the dock, the
 * nav bar and the `olv-has-scan` body class through `revealStreamingScanChrome`,
 * but stopped there: the streaming panel never showed, the Inspector kept its
 * static layout, image export stayed dark, the Analyse rail never opened and no
 * streaming Scan Report was published. COPC, EPT and 3D Tiles all reveal those
 * after their commit. These cases pin that an out-of-core LAS now reveals the
 * same surfaces, routed through the shared helpers, and — the anti-blind-copy
 * guard — that the two surfaces this source cannot honestly fill are omitted.
 *
 * The build path is faked exactly as `heavyLasBridgeStreaming.test.ts` fakes it:
 * a real in-process build against `fakeOpfs`, driven through a counting range.
 * The streaming reveal deps are spies, so each reveal call is asserted directly.
 */
import { describe, it, expect } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { openLocalHeavyLas } from '../src/app/openLocalHeavyLas';
import { counting, lasBytes, makeDeps, makeEnv, spyFile } from './support/heavyLasFakes';

async function openHeavy(n = 200_000) {
  const range = counting(new ArrayBufferRangeSource(lasBytes(n)));
  const { deps, s } = makeDeps();
  const file = spyFile('heavy.las', 999_999_999);
  const result = await openLocalHeavyLas(file, new AbortController().signal, deps, makeEnv(range));
  return { result, s, n };
}

describe('heavy-LAS full streaming reveal', () => {
  it('reveals the streaming panel and publishes a streaming Scan Report', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');

    // The streaming panel is shown with its live controls populated.
    expect(s.streamingPanel.show).toHaveBeenCalledTimes(1);
    expect(s.streamingPanel.setColorModes).toHaveBeenCalledTimes(1);
    expect(s.streamingPanel.setQuality).toHaveBeenCalledTimes(1);

    // The Inspector and Export panel switch to streaming layout and image
    // export opens.
    expect(s.inspector.setStreamingMode).toHaveBeenCalledWith(true);
    expect(s.exportPanel.setStreamingMode).toHaveBeenCalledWith(true);
    expect(s.exportPanel.setImageExportEnabled).toHaveBeenCalledWith(true);
    expect(s.exportPanel.setImageExportAvailability).toHaveBeenCalled();

    // A streaming Scan Report is built and published for THIS scan.
    expect(s.runStreamingModules).toHaveBeenCalledTimes(1);
    expect(s.inspector.setReport).toHaveBeenCalledTimes(1);
    expect(s.setLastStreamingReportCloud).toHaveBeenCalledTimes(1);

    // The Analyse rail, export pre-warm and status poll all start.
    expect(s.revealAnalysePanel).toHaveBeenCalledTimes(1);
    expect(s.prewarmExportStudio).toHaveBeenCalledTimes(1);
    expect(s.startStreamingStatusPolling).toHaveBeenCalledTimes(1);
  });

  it('states the REAL point total in the Scan Report and the detail row', async () => {
    const { result, s, n } = await openHeavy();
    expect(result.status).toBe('attached');

    // Unlike a 3D Tiles tileset (which states no total), an OlvTileSource states
    // its tile-store total, so the report cloud carries the measured count and
    // the Inspector detail row shows it — not "not stated by the source".
    const report = s.getLastReport();
    expect(report).not.toBeNull();
    expect(report?.sourcePointCount).toBe(n);
    expect(report?.sourcePointCount).not.toBeNull();
    // The total is the SOURCE figure. What is resident is a separate count off
    // the same store, so the readout can state residency instead of claiming
    // the whole store is on the GPU.
    expect(s.inspector.setStreamingDetail).toHaveBeenCalledWith({
      residentPointCount: 0,
      sourcePointCount: n,
      sourcePointCountKnown: true,
    });
    expect(s.inspector.setDetail).not.toHaveBeenCalled();
  });

  it('omits the two surfaces a local out-of-core store cannot honestly fill', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');

    // No publisher URL: the store is built from a LOCAL file, so the credited
    // Source row is not offered (COPC guards the same call behind http-range).
    expect(s.streamingPanel.setSourceUrl).not.toHaveBeenCalled();

    // No honest format tag: the panel's summary vocabulary is copc|ept|3dtiles,
    // none of which names a decoded out-of-core LAS store, so the summary row is
    // omitted rather than mislabelled. The real count still reaches the user via
    // the Scan Report and the detail row.
    expect(s.streamingPanel.setSummary).not.toHaveBeenCalled();
  });

  it('resets the classification UI as a fillable legend, not an inapplicable one', async () => {
    // Classification IS a real channel on an out-of-core store (every tile record
    // carries it by layout), so the reset is the empty-and-waiting COPC case,
    // seeded lazily as classified nodes stream in.
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');
    expect(s.classLegendPanel.setClasses).toHaveBeenCalledTimes(1);
    expect(s.classLegendPanel.hide).toHaveBeenCalledTimes(1);
  });
});
