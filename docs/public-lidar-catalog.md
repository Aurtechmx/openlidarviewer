# Public LiDAR — verified-dataset picker

OpenLiDARViewer v0.3.6 ships a curated picker for verified-working public
LiDAR datasets. The empty-state UI presents a dropdown of hand-vetted
COPC / EPT URLs hosted on public S3 buckets (USGS public LiDAR bucket
+ Hobu's open-data bucket). Each entry was probed at build time and
returns a valid stream.

## What the picker does

The empty-state screen carries a labelled section: **"or pick a verified
public LiDAR dataset"**. The dropdown's options are the entries in
`src/io/catalog/curatedLocations.ts`, each with:

- a clean place / dataset name
- an inline size tag (`77 MB` for COPC files, `22.4B pts` for EPT
  datasets) so users can pick by network budget
- a short hint that updates below the dropdown when the option is
  focused

Clicking **Open** routes the selected URL into `handleRemoteUrl()`,
which detects whether the URL is an EPT manifest or a COPC file and
dispatches to the matching streaming path. The streaming pipeline is
exactly the same one the open-from-URL field uses.

There is no address input. There is no geocoder request. The picker
ships verified URLs — nothing about an arbitrary location is sent to
any third party.

## Why curated, not address-driven

We previously shipped an address-search interface that geocoded a
free-text query via Nominatim and looked up matching tiles via USGS's
TNM Products API. Both halves were unreliable in different ways:

- **The TNM API doesn't surface COPC URLs**. Every public LiDAR tile
  it indexes for the bbox we test against is a legacy `.laz` file, not
  `.copc.laz`. The browser can't range-read legacy LAZ — the address
  workflow returned tiles that wouldn't open.
- **Address coverage was inconsistent**. Even when TNM had relevant
  tiles for a region, mapping an arbitrary street address to those
  tiles relied on Nominatim's geocoder accuracy (variable across
  countries) plus a coarse bbox heuristic. Most addresses returned
  "0 COPC tiles" not because the viewer was broken but because 3DEP's
  COPC migration is incomplete.

The curated picker sidesteps both problems by shipping pre-verified
URLs. Users wanting to load arbitrary data have two paths:
- Paste any `.copc.laz` or `ept.json` URL into the dedicated URL field
  above the picker.
- Use the **"Open scan from device"** button with a local LAS / LAZ /
  PLY / E57 / PTX / PCD / GLB / OBJ file.

## Privacy contract

- **No address input → no geocoder request**. Where the previous
  workflow hit `nominatim.openstreetmap.org/search`, the curated picker
  fires zero third-party requests until the user clicks Open.
- The `?notelemetry=1` URL flag still suppresses the picker — it shows
  a one-line "Public-LiDAR lookup is disabled" notice instead. Even
  though the picker doesn't make exploratory third-party calls, the
  per-tile fetch itself is a categorical access event we let the user
  opt out of.
- A dataset selection records exactly one categorical event in
  `localStorage` (`scan-open: curated:usgs-ept`). The counter never
  leaves the device. The selected URL itself never leaves the device
  beyond the HTTP GET to the bucket.
- The S3 buckets we link to (USGS public LiDAR, Hobu Inc.'s public
  data bucket, Entwine's public bucket) log standard CDN access
  events. The bytes streamed are public-domain LiDAR; the request
  reveals only "someone fetched this public tile".

## Supported datasets (current list)

The shipped picker covers 18 entries spanning ~77 MB to 75 billion
points. The mix favours metropolitan EPT scans (San Francisco, Los
Angeles, Denver Metro, Grand Canyon NP) plus standalone COPC files
(Autzen Stadium, Sofia, Cahokia Mounds, Key Bridge Baltimore, Puerto
Rico FEMA). The `tests/curatedLocations.test.ts` suite asserts the
shape of every entry; a live re-probe runs at release time to confirm
each URL still returns a parseable manifest.

For the current set, see `src/io/catalog/curatedLocations.ts`.

## Experimental modules retained for future work

The following modules exist in the repo but are NOT wired into the
v0.3.6 user flow. They survive as scaffolding for possible future
address-based catalog work, marked **experimental** at the top of each
file:

- `src/io/catalog/geocode.ts` — Nominatim client
- `src/io/catalog/Usgs3depProvider.ts` — USGS TNM Products API client
- `src/io/catalog/SourceRegistry.ts` — generic provider registry

Nothing in the v0.3.6 UI imports them; tree-shaking drops them from the
shell bundle. A future provider that can reliably return COPC tiles
(OpenTopography, AHN, IGN LiDAR HD) could land via the `SourceRegistry`
pattern without breaking the curated-picker UI.

## What the code does NOT do (v0.3.6)

- **No address-based LiDAR search.** Address input + geocoder is not
  exposed to users in v0.3.6.
- **No claim to global coverage.** The picker lists what works; users
  can paste their own URLs for anything else.
- **No cloud backend.** The viewer never talks to an OpenLiDARViewer-
  operated server. Every request goes to a public data source.
- **No proxy.** A CORS proxy would let the viewer reach catalogs that
  block browser requests, at the cost of routing user data through
  third-party infrastructure. We decline.
- **No API keys.** Every supported source is reachable without
  authentication.
- **No tile caching.** Browser HTTP caching applies to the underlying
  COPC bytes via `HttpRangeSource` as it did before.

## Preparing your own COPC

Users who want to host their own scan publicly typically run a small
PDAL pipeline first to normalise, reproject, and convert to COPC:

1. **Crop** with `filters.crop` to the area of interest.
2. **Merge** sibling tiles with `pdal merge` so the final COPC is a
   single file.
3. **Reproject** with `filters.reprojection` if downstream consumers
   expect a different CRS.
4. **Convert** with `writers.copc` to emit a `.copc.laz` ready for
   range-served streaming.

PDAL ships these stages out of the box; full docs at
<https://pdal.io/>. The viewer treats the resulting file the same way
it treats the curated entries — paste the URL into the URL field above
the picker.
