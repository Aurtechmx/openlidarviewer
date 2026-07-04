import { test, expect, type Page } from '@playwright/test';

/**
 * v0.4.4 Open-from-URL — empty-submit warning, the in-flight Cancel
 * control, and the one-load-at-a-time guard.
 *
 * The URL field lives at the bottom of the empty state
 * (src/ui/Stage.ts `_buildUrlRow` / `_handleUrlSubmit`):
 *   - submitting an EMPTY input shows an inline warning in
 *     `.olv-url-message` instead of silently doing nothing;
 *   - while a load is pending the Open button (`.olv-url-btn`) flips to a
 *     Cancel control (`_setUrlLoading`), and clicking it aborts the
 *     load's AbortSignal, which main.ts threads into the remote fetches;
 *   - while one load is in flight, any second open attempt is rejected by
 *     `handleRemoteCopc` (src/main.ts) with the shared lasso toast.
 *
 * Remote loads are stalled with `page.route`: `handleRemoteCopc` probes
 * the URL first (`HttpRangeSource.probe()` — a HEAD request, with a
 * `Range: bytes=0-0` GET fallback; src/io/range/HttpRangeSource.ts), so
 * intercepting every request to the fake host and never fulfilling parks
 * the load at the probe before any COPC bytes are needed. The fake URL
 * must pass `validateRemoteCopcUrl` (http/https, no credentials, not a
 * private/loopback host — src/io/range/RangeSource.ts), which
 * https://example.com/… does.
 */

const STALLED_URL = 'https://example.com/test.copc.laz';

/** Park every request to the fake host — pending until the page aborts it. */
async function stallRemoteHost(page: Page): Promise<void> {
  await page.route('**://example.com/**', () => {
    // Never fulfil and never continue: the probe fetch stays pending, so
    // the load is reliably "in flight" until cancelled or the page closes.
  });
}

/**
 * Start a load against the stalled host and wait until it is genuinely in
 * flight: the DropZone toast reads the blue "Opening <name>…" state (v0.5.6
 * unified the remote-open toast with the device-open wording) only after
 * main.ts has claimed the `loading` flag and entered the probe.
 */
async function startStalledLoad(page: Page): Promise<void> {
  await stallRemoteHost(page);
  await page.goto('/');
  await page.locator('.olv-url-input').fill(STALLED_URL);
  await page.locator('.olv-url-btn').click();
  await expect(page.locator('.olv-toast')).toContainText(
    'Opening test.copc.laz',
    { timeout: 20_000 },
  );
}

test.describe('open from URL — empty submit', () => {
  test('submitting an empty URL shows the exact warning and starts no load', async ({
    page,
  }) => {
    await page.goto('/');
    const button = page.locator('.olv-url-btn');
    await button.click();

    // The inline message slot under the input carries the warning verbatim
    // (Stage._handleUrlSubmit's empty-input branch).
    const message = page.locator('.olv-url-message');
    await expect(message).toBeVisible();
    await expect(message).toHaveText(
      'Enter a URL to a .copc.laz file or an EPT dataset (ept.json).',
    );
    await expect(message).toHaveClass(/olv-url-message-warning/);

    // No load started: the button never flipped to its Cancel state and
    // the DropZone progress toast stayed hidden.
    await page.waitForTimeout(500);
    await expect(button).toHaveText('Open');
    await expect(page.locator('.olv-toast')).toHaveClass(/olv-hidden/);
  });
});

test.describe('open from URL — cancel mid-load', () => {
  test('the Open button becomes a Cancel control, and cancelling frees the field for a new attempt', async ({
    page,
  }) => {
    await stallRemoteHost(page);
    await page.goto('/');
    const input = page.locator('.olv-url-input');
    const button = page.locator('.olv-url-btn');

    await input.fill(STALLED_URL);
    await button.click();

    // Stage flips the submit button into the Cancel control synchronously
    // on submit (Stage._setUrlLoading).
    await expect(button).toHaveText('Cancel');
    await expect(button).toHaveClass(/olv-url-btn-loading/);

    // Wait until the load is genuinely in flight (past the lazy Viewer
    // chunk, holding the `loading` flag, parked on the stalled probe) —
    // otherwise the post-cancel reopen below could race the flag release.
    await expect(page.locator('.olv-toast')).toContainText(
      'Opening test.copc.laz',
      { timeout: 20_000 },
    );

    // Cancel: the control reverts and the input (value preserved) is usable.
    await button.click();
    await expect(button).toHaveText('Open');
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(STALLED_URL);

    // The abort rejects the stalled probe, and handleRemoteCopc's `finally`
    // releases the one-load-at-a-time flag — so a fresh open attempt is
    // accepted (Cancel control again) instead of being rejected.
    await page.waitForTimeout(500);
    await button.click();
    await expect(button).toHaveText('Cancel');
    await page.waitForTimeout(800);
    // The lasso toast is mounted lazily (showLassoToast creates it on
    // first use), so when the reopen is accepted cleanly the element may
    // not exist at all — and a negative text matcher fails on a missing
    // element. Count the rejection text instead: pass whether the toast
    // was never mounted or exists without "Already loading".
    await expect(
      page.locator('.olv-lasso-toast', { hasText: 'Already loading' }),
    ).toHaveCount(0);
  });

  // Regression pin for the v0.4.4 silent-cancel contract: a cancel landing
  // while the probe fetch is in flight surfaces as `RangeReadError` with
  // code 'aborted' (HttpRangeSource wraps the platform abort), and
  // `isAbortError` in main.ts recognises that shape alongside the plain
  // DOMException `AbortError` — neither may produce an error toast.
  test('a user cancel surfaces no error toast', async ({ page }) => {
    await startStalledLoad(page);
    const button = page.locator('.olv-url-btn');
    await expect(button).toHaveText('Cancel');
    await button.click();
    await expect(button).toHaveText('Open');

    // No error surface may appear after a user-initiated cancel: the
    // DropZone toast must not enter its error state (class + role swap in
    // DropZone.setError), and the inline URL message must stay hidden.
    await page.waitForTimeout(2000);
    const toast = page.locator('.olv-toast');
    await expect(toast).not.toHaveClass(/olv-toast-error/);
    await expect(toast).not.toHaveAttribute('role', 'alert');
    await expect(page.locator('.olv-url-message')).toHaveClass(/olv-hidden/);
  });
});

test.describe('open from URL — concurrent open rejection', () => {
  test('a second open while loading shows the "Already loading" toast', async ({
    page,
  }) => {
    await startStalledLoad(page);

    // Re-submit the URL field while the first load holds the `loading`
    // flag. The button is the Cancel control now, so submit via Enter in
    // the input (implicit form submission — the form's submit handler
    // routes to the same _handleUrlSubmit → onOpenUrl path).
    await page.locator('.olv-url-input').press('Enter');

    const lassoToast = page.locator('.olv-lasso-toast');
    await expect(lassoToast).toBeVisible();
    await expect(lassoToast).toHaveText(
      'Already loading — cancel the current load first.',
    );
  });
});
