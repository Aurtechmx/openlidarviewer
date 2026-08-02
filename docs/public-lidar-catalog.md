# Public LiDAR: verified-dataset picker

OpenLiDARViewer's empty state offers two ways to load public LiDAR without
supplying a URL by hand: a curated dropdown of hand-vetted COPC / EPT datasets,
and a coordinate-based search that queries Microsoft Planetary Computer for US
3DEP COPC tiles near a point. Both feed the same streaming pipeline the manual
URL field uses. Local files stay on the device, and no account is required.

## What the picker does

The empty-state screen carries a labelled section, "or pick a verified public
LiDAR dataset". Its options are the entries in
`src/io/catalog/curatedLocations.ts`, sorted smallest-first. Each carries a place
or dataset name, an inline size tag (file size for COPC, point count for EPT) so
a user can pick by network budget, and a short hint that appears below the
dropdown when the option is focused.

Clicking Open hands the selected URL to `handleRemoteUrl()`, which detects
whether it is an EPT manifest or a COPC file and dispatches to the matching
streaming path. That is the same code the open-from-URL field runs.

## Search by location

Below the dropdown, a "search by location" control (US only, backed by Planetary
Computer) takes coordinates of a US point, or a city pick that auto-fills them,
and asks Microsoft Planetary Computer's public STAC `3dep-lidar-copc` catalog for
COPC tiles near that point. Matching tiles open through the same COPC path.

This is a coordinate search, not an address search. There is no street-address
box and no geocoder. The client sends a small bounding box around the chosen
point to a public STAC endpoint and reads back the tiles that intersect it. The
request is one the user initiates, and it goes to Microsoft's public catalog, not
to any OpenLiDARViewer-operated server. The lazy-loaded client lives in
`src/io/catalog/planetaryComputer.ts`.

## Datasets in the curated list

The shipped list currently holds 12 entries. Two European national programmes
come from FLAI's Open LiDAR Data (Switzerland's swissSURFACE3D and Slovenia's
GURS, each on a verified open licence) on a public EU S3 bucket. The US datasets
(San Francisco, Los Angeles, Denver Metro, Grand Canyon) sit on the USGS and Hobu
west-coast buckets. Sizes run from an 84 MB single COPC file up to
multi-billion-point EPT scans.

Every entry was probed before shipping, with a CORS preflight, a HEAD for size,
and a ranged read of the LAS header, and it ships only if it still returns a
parseable stream. `tests/curatedLocations.test.ts` asserts the shape of each
entry, and the FLAI re-probe script is `tools/verify-flai.sh`. The list itself is
the source of truth: `src/io/catalog/curatedLocations.ts`.

## Privacy contract

- No street-address input, and no geocoder. Earlier builds shipped a Nominatim
  address search; that is gone. The only location affordance is the coordinate
  search above.
- The location search is a third-party request the user starts. Picking a point
  and running the search sends a bounding box to Microsoft Planetary Computer.
  Nothing is sent until the user runs it. The curated dropdown fires no request
  until Open, and then only a direct GET to the public bucket.
- `?notelemetry=1` disables the whole public-LiDAR lookup. With the flag set, the
  panel shows a one-line "lookup is disabled" notice in place of the dropdown and
  search. A per-tile fetch is a categorical access event, so the flag lets a user
  opt out of it.
- A dataset selection records one categorical event in `localStorage`. The
  counter never leaves the device, and the selected URL never leaves it beyond
  the HTTP GET to the bucket.
- The buckets we link to log standard CDN access. The bytes streamed are public
  LiDAR, so the request reveals only that someone fetched a public tile.

## What the picker does not do

- No street-address LiDAR search. Coordinates only, US only, and only for 3DEP
  COPC through Planetary Computer.
- No claim to global coverage. The curated list is what we verified, and the
  coordinate search covers US 3DEP. For anything else, paste a `.copc.laz` or
  `ept.json` URL into the field above the picker.
- No OpenLiDARViewer backend. The viewer never talks to a server we operate.
  Every request goes to a public data source.
- No proxy. A CORS proxy would reach catalogs that block browser requests, at the
  cost of routing user data through third-party infrastructure. We decline.
- No API keys. Every supported source is reachable without authentication.
- No tile caching beyond the browser. Standard HTTP caching applies to the COPC
  bytes through `HttpRangeSource`, as before.

## Removed experimental modules

Earlier versions carried a Nominatim geocoder, a USGS TNM Products API client,
and a generic provider registry (`geocode.ts`, `Usgs3depProvider.ts`,
`SourceRegistry.ts`). The TNM path returned mostly legacy non-streamable LAZ, and
address dispatch depended on geocoder accuracy against 3DEP's incomplete COPC
migration, so most addresses produced no usable coverage. Those modules were
removed in v0.6.0. The coordinate search against Planetary Computer replaces them
for the US case.

## Preparing your own COPC

To host a scan publicly, a small PDAL pipeline is usually enough:

1. Crop with `filters.crop` to the area of interest.
2. Merge sibling tiles with `pdal merge` so the result is one file.
3. Reproject with `filters.reprojection` if downstream consumers expect a
   different CRS.
4. Convert with `writers.copc` to emit a `.copc.laz` ready for range-served
   streaming.

PDAL ships these stages; full docs are at <https://pdal.io/>. The viewer treats
the result the same way it treats a curated entry: paste the URL into the field
above the picker.
