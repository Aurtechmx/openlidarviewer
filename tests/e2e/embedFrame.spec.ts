import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Framing policy for the viewer on a host that sends no `frame-ancestors`
 * header (GitHub Pages, a bucket). The page that frames the viewer chooses the
 * viewer's URL, so `?embedParent=` cannot authorise it: the viewer runs only
 * when framed by its own origin or by a build-time allow-listed origin, and
 * otherwise shows a notice and stays silent.
 *
 * The deploy-bytes leg serves the shipped `_headers`, whose `frame-ancestors
 * 'self'` stops the browser framing the page at all, so the cross-origin test
 * has nothing to observe there.
 */

const HOST_PAGE = (viewerUrl: string): string => `<!doctype html><meta charset="utf-8">
<iframe id="v" src="${viewerUrl}" style="width:900px;height:600px"></iframe>
<script>
  window.__msgs = [];
  addEventListener('message', (e) => window.__msgs.push(e.data));
</script>`;

test('a page that frames the viewer cannot authorise itself with ?embedParent', async ({ page, baseURL }) => {
  test.skip(!!process.env.OLV_DEPLOY_ROOT, 'the shipped headers already refuse cross-origin framing');
  // A real second origin on the same machine (127.0.0.1 against localhost): a
  // fulfilled route is treated as a public page and cannot frame a loopback one.
  let server: Server | undefined;
  try {
    let attacker = '';
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(HOST_PAGE(`${baseURL}/?embed=1&embedParent=${encodeURIComponent(attacker)}`));
    });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    attacker = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.goto(attacker);
    const viewer = page.frameLocator('#v');

    // The viewer withholds its interface behind a notice with a link to its own tab.
    await expect(viewer.getByText('not shown inside this page')).toBeVisible({ timeout: 20_000 });
    const link = viewer.getByRole('link', { name: 'Open the viewer in its own tab' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('href', `${baseURL}/`);
    await expect(viewer.locator('.olv-canvas')).toHaveCount(0);

    // It never announced itself, and a command from the framing page does nothing.
    await page.evaluate(() => {
      const frame = document.getElementById('v') as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ type: 'load-file', name: 'x.ply', buffer: new ArrayBuffer(8) }, '*');
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs)).toEqual([]);
    await expect(viewer.locator('.olv-layer')).toHaveCount(0);
  } finally {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  }
});

test('a same-origin page can still frame the viewer and receive its ready message', async ({ page, baseURL }) => {
  await page.route(`${baseURL}/__frame-host.html`, (route) =>
    route.fulfill({ contentType: 'text/html', body: HOST_PAGE('/?embed=1') }),
  );
  await page.goto('/__frame-host.html');
  const viewer = page.frameLocator('#v');
  await expect(viewer.locator('.olv-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByText('not shown inside this page')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __msgs: Array<{ type?: string }> }).__msgs.map((m) => m.type)))
    .toContain('ready');
});
