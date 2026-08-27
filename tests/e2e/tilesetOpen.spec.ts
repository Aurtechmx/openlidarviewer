import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  boxTileset,
  regionTileset,
  TILESET_ORIGIN,
  type TilesetScene,
} from '../fixtures/tileset3d';

/**
 * 3D Tiles end-to-end: a `tileset.json` URL opens, streams and becomes a scan.
 *
 * The path under test is the one a user reaches by pasting a URL. `main.ts`
 * `handleRemoteUrl` routes a `tileset.json` through `isTilesetEntryUrl` to
 * `openRemoteTileset`, which fetches the document, walks it into a
 * `TilesetStreamingSource` and attaches it; the scheduler then culls against the
 * camera and fetches the `.pnts` bodies it needs. Twelve unit suites cover the
 * pieces. None of them runs the shell, so none can say whether a tileset arrives
 * as a scan the rest of the app treats as one.
 *
 * WHY THE FIXTURE IS BUILT RATHER THAN SHIPPED. The COPC specs next door need an
 * 80 MB scan no clone carries, so they `test.skip` on CI and the coverage they
 * claim is not run there. A tileset does not have that problem: the whole
 * dataset here is a few kilobytes of JSON and float32, so `tests/fixtures/
 * tileset3d.ts` builds it and `page.route` serves it. Every test in this file
 * runs on every machine, CI included — there is no `test.skip` and no fixture
 * probe, which is the point.
 *
 * The host is `tiles.example.com`, following `urlOpen.spec.ts`: it is a public
 * name, so it passes the SSRF block-list the entry URL is validated against, and
 * nothing ever leaves the route handler.
 */

/** Serve one or more synthetic datasets, and record every URL the page asks for. */
async function serveTilesets(page: Page, ...scenes: TilesetScene[]): Promise<string[]> {
  const files = new Map(scenes.flatMap((scene) => [...scene.files]));
  const requested: string[] = [];
  await page.route(`**://${new URL(TILESET_ORIGIN).host}/**`, async (route) => {
    const url = route.request().url();
    requested.push(url);
    const file = files.get(url);
    // A 404 rather than an abort: a dataset that names a body this scene does
    // not serve should fail the way a real host fails, not as a network error.
    if (!file) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({
      status: 200,
      contentType: file.contentType,
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(file.body),
    });
  });
  return requested;
}

/** Paste the entry URL into the empty state's open-from-URL field and submit. */
async function openTilesetUrl(page: Page, scene: TilesetScene, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await page.locator('.olv-url-input').fill(scene.entryUrl);
  await page.locator('.olv-url-btn').click();
}

/** The empty state gives way once the tileset is attached and committed. */
async function expectAttached(page: Page): Promise<void> {
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 40_000 });
}

/** The Scan Report body, which lives in a `<details>` that starts collapsed. */
function scanReport(page: Page): Locator {
  return page.locator('.olv-report');
}

/**
 * Points currently drawn, from the `?debug=1` overlay's rendering block.
 *
 * The overlay counts what the RENDERER put on screen this frame, which is not
 * the same claim as the Streaming panel's resident counter below: one says the
 * tiles were drawn, the other says they were decoded and admitted. Both are
 * asserted, because either alone would leave the other unproven.
 */
async function pointsShown(page: Page): Promise<number> {
  const text = (await page.locator('.olv-debug').textContent()) ?? '';
  const match = /points\s+([\d,]+)\s+shown/.exec(text);
  return match ? Number(match[1].replace(/,/g, '')) : -1;
}

/** One labelled row of the Streaming panel — its Scan section or its counters. */
function streamingRow(page: Page, key: string): Locator {
  return page
    .locator('.olv-streaming-panel .olv-streaming-row')
    .filter({ has: page.locator('.olv-streaming-key', { hasText: new RegExp(`^${key}$`) }) });
}

test.describe('3D Tiles — opening a tileset from a URL', () => {
  test('streams the tiles into the scene and puts a point under the cursor', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const scene = boxTileset();
    const requested = await serveTilesets(page, scene);

    await openTilesetUrl(page, scene, '?debug=1');
    await expectAttached(page);

    // Every point of the dataset reaches the renderer. `points N shown` is the
    // renderer's own count of what it drew this frame, so this is not "the open
    // did not throw": it is the fixture's tiles, decoded, uploaded and drawn.
    await expect
      .poll(() => pointsShown(page), { timeout: 40_000 })
      .toBe(scene.totalPoints);

    // The Streaming panel is the surface that reports the load, and this open
    // populated it — colour modes, quality, source URL, phase — and then never
    // showed it, so none of it was reachable and the ~4 Hz counters below ran
    // into a hidden panel. It names this format, and its Scan section states
    // the point total as absent rather than carrying a previous scan's figure.
    const panel = page.locator('.olv-streaming-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.olv-streaming-title')).toHaveText('Streaming 3D Tiles');
    await expect(streamingRow(page, 'Source')).toContainText('Unknown from source metadata');
    await expect(streamingRow(page, 'Format')).toContainText('3D Tiles');
    // The live counter, against the same total the renderer drew. `Unknown` is
    // the right-hand side because the source states no total.
    await expect
      .poll(async () => (await streamingRow(page, 'Points').textContent()) ?? '', {
        timeout: 40_000,
      })
      .toContain(`${scene.totalPoints} / Unknown`);
    // The controls that ride with the panel: Pause, Clear cache, the full-cloud
    // grade and the colour / quality chips were all unreachable with it hidden.
    await expect(panel.locator('.olv-streaming-btn', { hasText: 'Pause' })).toBeVisible();
    await expect(panel.locator('.olv-streaming-btn', { hasText: 'Clear cache' })).toBeVisible();

    // And they are really in the scene, not merely counted: Inspect raycasts the
    // resident nodes, so a card with per-point rows means a click landed on a
    // decoded tile point. Clicking in a poll waits on the condition (a hit)
    // rather than on a duration — the framing tween is still settling early on,
    // so the first click can legitimately miss.
    await page.locator('.olv-tool', { hasText: 'Inspect' }).click();
    const canvas = page.locator('.olv-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('the canvas has no bounding box');
    const card = page.locator('.olv-inspect-card');
    const offsets = [0.5, 0.46, 0.54, 0.42, 0.58];
    let attempt = 0;
    await expect
      .poll(
        async () => {
          const f = offsets[attempt++ % offsets.length];
          await canvas.click({ position: { x: box.width * f, y: box.height * f } });
          return card.isVisible();
        },
        { timeout: 40_000, message: 'no Inspect click landed on a tileset point' },
      )
      .toBe(true);
    // The card names the layer it hit — this tileset, not a leftover scan.
    await expect(card).toContainText('tileset.json');
    await expect(card.locator('.olv-inspect-row').first()).toBeVisible();

    // The scheduler fetched tile bodies, so the open really streamed rather
    // than drawing something the entry document alone could supply.
    for (const tile of scene.tileUrls) expect(requested).toContain(tile);
  });

  test('is a first-class scan: the measurement tools are offered, not refused', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Regression pin for the shell reading a null `sourcePointCount` as "no
    // scan": a tileset states no point total, and while that absence was read as
    // absence-of-scan every measurement preflight refused with NO_SCAN_LOADED
    // over a tileset that was drawn and pickable.
    const scene = boxTileset();
    await serveTilesets(page, scene);
    await openTilesetUrl(page, scene);
    await expectAttached(page);

    // The dock's Measure tool is live and opens the measurement bar.
    const measure = page.locator('.olv-tool', { hasText: 'Measure' });
    await expect(measure).toBeEnabled();
    await measure.click();
    await expect(page.locator('.olv-measure-bar')).toBeVisible();
    await expect(page.locator('.olv-mkind', { hasText: /^Distance$/ })).toBeVisible();

    // The left rail is available: `.olv-left-panels:not(.olv-ws-ready)
    // .olv-ws-body { display: none }` hid the whole mode body until a scan
    // opened, and only the Analyse-panel reveal flips that flag. Without it
    // every panel below was present in the DOM and invisible on screen.
    const rail = page.locator('.olv-left-panels');
    await expect(rail).toHaveClass(/olv-ws-ready/, { timeout: 20_000 });
    await expect(rail.locator('.olv-ws-tabs')).toBeVisible();

    // Process Studio is where a withheld tool says WHY, so it carries the
    // preflight verdict this regression was about. Its rows are asserted
    // VISIBLE, which is what the rail reveal makes possible: the Analyse mode
    // is one tab away rather than behind a body nothing displays.
    await rail.locator('.olv-ws-tab', { hasText: 'Analyse' }).click();
    const studio = page.locator('.olv-process-studio');
    await expect(studio).toBeVisible();
    const tools = studio.locator('.olv-ps-tool');
    await expect(tools).toHaveCount(4, { timeout: 20_000 });
    const distance = studio.locator('.olv-ps-tool', { hasText: 'Distance' });
    await expect(distance).toBeVisible();
    await expect(distance).not.toHaveClass(/olv-ps-blocked/);
    // The exact sentence the refusal used to carry, on any tool row.
    await expect(
      studio.locator('.olv-ps-tool', { hasText: 'No scan is loaded' }),
    ).toHaveCount(0);

    // The class legend rides in the Data mode next door. A point tile carries no
    // LAS classification, so it must not be offering class filters here — least
    // of all a previous scan's, which is what a rail reveal without the reset
    // would have surfaced.
    await rail.locator('.olv-ws-tab', { hasText: 'Data' }).click();
    await expect(page.locator('.olv-class-panel')).toBeHidden();
  });

  test('publishes a Scan Report for the tileset, and says up was never established', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Two regressions in one open, because they share it. The report was never
    // published on this path at all, so the Inspector kept the previously opened
    // scan's rows. And a tileset whose volumes are all `box` declares no
    // geocentric frame, which draws exactly like one that does — the report is
    // the only place the difference can appear.
    const scene = boxTileset();
    await serveTilesets(page, scene);
    await openTilesetUrl(page, scene);
    await expectAttached(page);

    await expect
      .poll(() => page.locator('.olv-report-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    const report = scanReport(page);
    // The report is about THIS scan: a tileset's own format, and the point total
    // it does not state, rather than a figure carried over or invented.
    await expect(report).toContainText('3D Tiles (point tiles)');
    await expect(report).toContainText('not stated by the source');
    // The frame statement for a `box` tileset.
    await expect(report).toContainText('Frame not established, no vertical reference, metres');
    await expect(report).toContainText('which way is up is not established');
  });

  test('a region tileset reads as ellipsoidal, and raises no unestablished-frame notice', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // A `region` is stated in EPSG:4979, which fixes the root frame as WGS84
    // geocentric. That establishes up, and it establishes it no more strongly
    // than the document allows: 3D Tiles carries no vertical datum, so the
    // height is ellipsoidal and naming an orthometric one would be a second lie
    // in place of the first.
    const scene = regionTileset();
    await serveTilesets(page, scene);
    await openTilesetUrl(page, scene);
    await expectAttached(page);

    await expect
      .poll(() => page.locator('.olv-report-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    const report = scanReport(page);
    await expect(report).toContainText('Local east-north-up, ellipsoidal height, metres');
    await expect(report).toContainText(
      'region bounding volume (EPSG:4979), which fixes the root frame as WGS84 geocentric',
    );
    await expect(report).not.toContainText('Frame not established');
    await expect(report).not.toContainText('which way is up is not established');
    // Never an orthometric datum: the format states none, so none may be named.
    await expect(report).not.toContainText(/orthometric|geoid|EGM\d|NAVD|mean sea level/i);
  });

  test('refuses a tileset carrying mesh content, by name, before fetching a tile', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // A `.b3dm` is real 3D Tiles content this viewer has no decoder for. Drawing
    // the rest would be a scene with a piece silently missing, so the open is
    // refused — and the refusal has to reach the user as words rather than as a
    // blank canvas or a generic "decoding failed".
    const scene = boxTileset({ childContentUri: 'child-a.b3dm', path: '/mesh' });
    const requested = await serveTilesets(page, scene);
    await openTilesetUrl(page, scene);

    const toast = page.locator('.olv-toast');
    await expect(toast).toHaveClass(/olv-toast-error/, { timeout: 40_000 });
    await expect(toast).toContainText(
      'This tileset has 1 tile(s) this reader cannot serve, so opening it would leave part of the scene missing.',
    );
    await expect(toast).toContainText(
      'child-a.b3dm: not a point tile, and this viewer decodes no other content.',
    );

    // The user is left where they started rather than staring at a blank scene.
    await expect(page.locator('.olv-empty')).toBeVisible();
    // Never partially mounted: a refused tileset causes no tile fetch at all,
    // which is a claim about what was NOT requested.
    expect(requested).toEqual([scene.entryUrl]);
  });

  test('offers the Normal chip and the Normal Map export once a tile has stated normals', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // A tileset states its channels PER TILE, so the chip row and the image
    // export gate are both published at open, before any tile exists, from an
    // answer that offers neither colour nor normals. Published once, that empty
    // answer was the whole session's offer: the tiles here carry a float32
    // NORMAL accessor that reaches the renderer, and nothing a user could click
    // ever said so.
    const scene = boxTileset({ normals: true, colour: 'none' });
    await serveTilesets(page, scene);
    await openTilesetUrl(page, scene);
    await expectAttached(page);

    const chips = page.locator('.olv-streaming-panel .olv-streaming-chips').first();
    await expect(chips.locator('.olv-chip', { hasText: /^Normal$/ })).toBeVisible({
      timeout: 40_000,
    });
    // The user's mode survives the republish: the row opened on Height, which
    // is what the layer could serve before a tile had been read, and the chip
    // that arrives beside it must not steal the selection.
    await expect(chips.locator('.olv-chip-active')).toHaveText('Height');

    // And the export that reads the same answer. `hasNormals()` returned false
    // for every streaming source, so this button was dark over a scan whose
    // tiles carry measured directions.
    const normalMap = page.locator('.olv-export-btn', { hasText: /^Normal map$/ });
    await expect(normalMap).toBeEnabled({ timeout: 40_000 });
  });

  test('offers neither, for a tileset whose tiles state no normals', async ({ page }) => {
    test.setTimeout(90_000);
    // The half that matters as much: a chip that resolves to another channel,
    // or an export that renders a uniform grey image, says the scan holds a
    // reading it does not.
    const scene = boxTileset();
    await serveTilesets(page, scene);
    await openTilesetUrl(page, scene);
    await expectAttached(page);

    // Waited on through a surface that DOES move, so this is not asserting an
    // absence before anything could have appeared: Points only reaches the
    // total once every tile has been decoded and reported to the source.
    await expect
      .poll(async () => (await streamingRow(page, 'Points').textContent()) ?? '', {
        timeout: 40_000,
      })
      .toContain(`${scene.totalPoints} / Unknown`);

    const chips = page.locator('.olv-streaming-panel .olv-streaming-chips').first();
    await expect(chips.locator('.olv-chip', { hasText: /^Normal$/ })).toHaveCount(0);
    await expect(page.locator('.olv-export-btn', { hasText: /^Normal map$/ })).toBeDisabled();
  });

  test('tells the user why a tileset whose tiles disagree about colour keeps one meaning', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // The root tile carries RGB and the children carry none. A streaming reader
    // sees one tile at a time, so the first tile with points settles the layer's
    // colour meaning and every later tile is drawn in that meaning. Which tile
    // decodes first is the scheduler's business, so this asserts what both
    // outcomes must say rather than picking one.
    const scene = boxTileset({ colour: 'mixed' });
    await serveTilesets(page, scene);
    await openTilesetUrl(page, scene);
    await expectAttached(page);

    const notice = page.locator('.olv-lasso-toast');
    await expect(notice).toBeVisible({ timeout: 40_000 });
    await expect(notice).toContainText(
      'Some tiles in this tileset carry colour and others do not.',
    );
    await expect(notice).toContainText('so the scene keeps one colour meaning');
  });
});
