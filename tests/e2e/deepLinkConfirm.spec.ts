import { test, expect, type Page } from '@playwright/test';

/**
 * A `?copc=<url>` deep link names a host the user never chose, so the viewer
 * asks before the first request: "Open remote dataset from <host>?" with Open
 * and Cancel. Every request to the fake host is counted by `page.route`; the
 * count must stay at zero until Open, and Cancel must leave the app idle.
 */

const HOST = 'data.example.org';
const DEEP = `/?copc=${encodeURIComponent(`https://${HOST}/private/path/scan.copc.laz?sig=token`)}`;

function countHost(page: Page): { readonly n: () => number } {
  let n = 0;
  void page.route(`**://${HOST}/**`, (route) => {
    n++;
    void route.fulfill({ status: 404, body: '' });
  });
  return { n: () => n };
}

test.describe('deep-linked remote dataset', () => {
  test('asks for the host and fetches nothing until confirmed', async ({ page }) => {
    const hits = countHost(page);
    await page.goto(DEEP);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Open remote dataset from ${HOST}?`);
    // Host only: the path and the signed query never reach the prompt.
    await expect(dialog).not.toContainText('/private/path');
    await expect(dialog).not.toContainText('token');
    await page.waitForTimeout(1500);
    expect(hits.n()).toBe(0);

    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect.poll(() => hits.n(), { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test('Cancel leaves the app idle with no request made', async ({ page }) => {
    const hits = countHost(page);
    await page.goto(DEEP);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(1500);
    expect(hits.n()).toBe(0);
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await expect(page.locator('.olv-toast')).not.toContainText('Opening');
  });

  test('a refused deep-link URL never prompts and never fetches', async ({ page }) => {
    const hits = countHost(page);
    await page.goto(`/?copc=${encodeURIComponent(`https://user:pw@${HOST}/scan.copc.laz`)}`);
    await expect(page.locator('.olv-toast')).toContainText('refused', { timeout: 10_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(hits.n()).toBe(0);
  });
});
