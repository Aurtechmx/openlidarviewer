import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build served by `vite preview`.
 * Run locally with `npm run test:e2e` (install browsers first with
 * `npx playwright install --with-deps chromium`).
 */
/**
 * The port the smoke's web server binds. Deploy-root runs are handed a
 * kernel-assigned free port so two runs, or a stray process, cannot collide.
 */
const DEPLOY_PORT = Number(process.env.OLV_DEPLOY_PORT ?? 4173);

/**
 * The one origin the web server binds and every spec navigates against.
 *
 * 127.0.0.1 rather than `localhost` in deploy-root mode, because that server
 * binds loopback explicitly and a `localhost` resolving to ::1 first would find
 * nothing there. Defined once: baseURL and webServer.url disagreeing is how the
 * whole suite ended up pointed at a dead port.
 */
const SERVER_URL = process.env.OLV_DEPLOY_ROOT
  ? `http://127.0.0.1:${DEPLOY_PORT}`
  : `http://localhost:${DEPLOY_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // `list` for readable console output; in CI also emit an `html` report so the
  // on-first-retry trace + failure screenshot are bundled into playwright-report/
  // and uploadable (the advisory browser jobs are continue-on-error, so their
  // failures are only diagnosable from an uploaded trace).
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Follows the web server: deploy-root runs get a kernel-assigned free port
    // and a loopback address, and a hardcoded 4173 here sent every spec to a
    // port nothing was listening on.
    baseURL: SERVER_URL,
    trace: 'on-first-retry',
    // Pre-seed localStorage so the onboarding tour overlay (which
    // auto-launches on first session per browser and intercepts
    // pointer events) is treated as already-completed for every
    // test. The key string mirrors `STORAGE_KEY` in
    // src/ui/onboarding/tourSteps.ts; if that constant changes,
    // update this string too. Without this seeding the first click
    // in any spec hits the tour backdrop instead of the target.
    storageState: {
      cookies: [],
      origins: [
        {
          // Must be the origin actually served, or the seed lands on a
          // different origin and the tour overlay is back. Deploy-root runs
          // move both host and port.
          origin: SERVER_URL,
          localStorage: [{ name: 'olv:tour:v1:completed', value: '1' }],
        },
      ],
    },
  },
  // Two projects split the suite by whether a spec's result depends on the
  // runner's GPU. `deterministic` is the BLOCKING gate: DOM, layout, routing,
  // export and streaming-logic flows that must pass identically everywhere.
  // `gpu` is advisory: specs whose outcome varies with the WebGPU adapter a CI
  // runner happens to expose. Tag a spec into the advisory set by putting
  // `@gpu` in its describe/test title — untagged specs block, which is the safe
  // default (a new spec gates until proven GPU-variable).
  //
  // `firefox` and `webkit` run the same deterministic set on the other two
  // engines. A viewer that renders through WebGPU with a WebGL2 fallback cannot
  // claim to work in a browser nobody ran it in, and this project tested one.
  // They are ADVISORY in CI, not required: a new leg that goes red would
  // otherwise block every unrelated change while its failures are triaged.
  projects: [
    { name: 'deterministic', use: { ...devices['Desktop Chrome'] }, grepInvert: /@gpu|@bench|@soak/, testIgnore: /firefoxWebglPreflight/ },
    { name: 'gpu', use: { ...devices['Desktop Chrome'] }, grep: /@gpu/, grepInvert: /@bench|@soak/, testIgnore: /firefoxWebglPreflight/ },
    // Navigation benchmark runs. They measure frame pacing and replay whole
    // trajectories, which only means something on a real GPU and outlasts the
    // test timeout on a software renderer, so no CI job selects this project.
    { name: 'bench', use: { ...devices['Desktop Chrome'] }, grep: /@bench/, testIgnore: /firefoxWebglPreflight/ },
    // Long-session soak (golden journey repeated). Minutes long, so no CI job
    // selects it; run with `npm run test:e2e:soak`.
    { name: 'soak', use: { ...devices['Desktop Chrome'] }, grep: /@soak/, testIgnore: /firefoxWebglPreflight/ },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        // Firefox's HEADLESS widget on Linux has no GL compositor, so
        // `canvas.getContext('webgl2')` returns null no matter how much of
        // Mesa is installed. That single fact caused every one of the 111
        // failures this leg reported: the viewer logs "GPU backend
        // initialisation failed. Neither WebGPU nor WebGL 2 produced a
        // usable context", the smoke specs trip their no-console-error
        // assertion, and everything that loads a scan waits for a frame
        // that never arrives.
        //
        // Measured on ubuntu 24.04 with a full Mesa stack present:
        //   headless, default prefs .................. webgl2 = null
        //   headless + webgl.force-enabled ........... webgl2 = null
        //   headless + LIBGL_ALWAYS_SOFTWARE=1 ....... webgl2 = null
        //   HEADFUL under Xvfb, default prefs ........ webgl2 = llvmpipe ✓
        // No pref makes headless work, and no pref is needed once it is
        // headful — so the fix is the window, not the configuration. Adding
        // Mesa packages on their own does nothing either; that was measured
        // too, and headless stayed null with the full stack installed.
        //
        // Only Linux is switched: macOS and Windows produce a context in
        // headless mode already, and going headful there would just pop a
        // real window open on a developer's desktop for every test. CI
        // wraps this leg in `xvfb-run` (see .github/workflows/browsers.yml),
        // which is what supplies the display.
        headless: process.platform !== 'linux',
      },
      grepInvert: /@gpu|@bench|@soak/,
      testIgnore: /firefoxWebglPreflight/,
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grepInvert: /@gpu|@bench|@soak/, testIgnore: /firefoxWebglPreflight/ },
    // iPhone WebKit: the same engine family as Mobile Safari, with a phone
    // viewport, a device pixel ratio of 3 and real touch events. It is the
    // closest an install-free local gate gets to an iPhone, and it is NOT an
    // iPhone: Playwright's WebKit is built from mainline rather than shipped as
    // Safari, and it renders on this machine's GPU rather than a mobile one.
    // So it gates layout, hit targets and touch, and it cannot speak to iOS
    // WebGL 2 limits, memory pressure on a large cloud, or WebGPU availability
    // on a real device. Those need a physical iPhone or a device farm.
    //
    // The failure mode is worse than missing coverage, and it was measured
    // rather than assumed. Probed here, this project reports `webgl2: true`,
    // `renderer: "WebKit WebGL"`, `navigator.gpu` present, `devicePixelRatio`
    // 3 and an iPhone OS 17_5 user agent. The GPU answers come from this
    // machine's adapter, so a capability check that passes here can still fail
    // on the device: WebGPU in particular is version-gated in Mobile Safari.
    // Treat a pass as evidence about layout and never as evidence about the
    // renderer.
    //
    // Advisory like the other engine legs, and scoped to the mobile viewport
    // contract rather than the whole deterministic set, so it stays a fast gate
    // instead of a second full suite that has to be triaged.
    {
      name: 'webkit-mobile',
      use: { ...devices['iPhone 15'] },
      testMatch: /visualsStudioMobile|smoke\.spec|touchGesture/,
    },
    // The graphics preflight is its own project so it can be run before the
    // suite without joining any project's default set. `deterministic` is a
    // required check, and an advisory leg must not move its test count.
    { name: 'firefox-preflight', use: { ...devices['Desktop Firefox'], headless: process.platform !== 'linux' }, testMatch: /firefoxWebglPreflight/ },
  ],
  webServer: {
    // SMOKE_LIVE boots the OBFUSCATED live artifact (the build users actually
    // get) so the smoke gate catches live-only breakage — scrambled
    // dynamic-import / worker-URL string literals, chunk-isolation regressions —
    // that the plain build can never surface. Default stays the plain build for
    // the fast e2e loop.
    // OLV_DEPLOY_ROOT serves an already-extracted deploy bundle and builds
    // NOTHING. It is how the smoke reaches the bytes that actually ship: the
    // normal legs test a build, packaging then produces a second build, and the
    // archive users download had never been started. See
    // scripts/smoke-deploy-zip.mjs, which sets this and binds the run to the
    // archive's SHA-256.
    // The directory and port travel in the environment, never in this command
    // string: `command` is shell text, and an extraction path containing a
    // space would split into two arguments. serve-deploy-bytes.mjs reads
    // OLV_DEPLOY_ROOT / OLV_DEPLOY_PORT itself.
    command: process.env.OLV_DEPLOY_ROOT
      ? 'node scripts/serve-deploy-bytes.mjs'
      : process.env.SMOKE_LIVE
        ? 'npm run build:live && npm run preview'
        : 'npm run build && npm run preview',
    // The `?test=1` seam (`window.__OLV_TEST_API__`) is compiled in only when
    // OLV_TEST_SEAM=1 is set at build time; without it the block is dropped by
    // the minifier and every spec that drives the viewer programmatically
    // fails. The SMOKE_LIVE build is deliberately left without it: that leg
    // boots the artifact users are served, and its two specs never use the
    // seam. Playwright merges this over process.env for the spawned command.
    env: process.env.SMOKE_LIVE || process.env.OLV_DEPLOY_ROOT ? {} : { OLV_TEST_SEAM: '1' },
    // 127.0.0.1, not `localhost`, in deploy-root mode: the static server binds
    // loopback explicitly, and a `localhost` that resolves to ::1 first would
    // find nothing listening there.
    url: SERVER_URL,
    // Deploy-root mode NEVER reuses a server, in CI or out of it. The whole
    // claim of that mode is "these archive bytes were started and driven"; a
    // server someone left on the port answers every request, the specs pass,
    // and the archive is never opened. Reuse is a convenience for the local
    // build loop and is wrong here at any cost in start-up time. With reuse
    // off, an occupied port fails the run instead of silently satisfying it —
    // and scripts/smoke-deploy-zip.mjs asks the kernel for a free port anyway.
    reuseExistingServer: process.env.OLV_DEPLOY_ROOT ? false : !process.env.CI,
    timeout: 180_000,
  },
});
