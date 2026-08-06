# Threat model and attack surface

OpenLiDARViewer runs entirely in the browser. There is no server, no account, no
database, and no telemetry, so whole classes of risk (stolen server credentials,
backend injection, data-at-rest exposure) do not apply. This document names the
surface that does exist and how each part is handled, and is reviewed when a
release changes what the app reads or where it reaches.

## External inputs (the attack surface)

1. User-opened files (LAS/LAZ/E57/PLY/PCD/PTX/OBJ/GLB and so on). Parsed in Web
   Workers, bounded, and failed closed on malformed input. File contents are
   data, never code; nothing in a file is executed.
2. User-supplied remote URLs (COPC `.copc.laz` / EPT `ept.json`). Validated
   before any network request: `validateRemoteEptUrl` and
   `validateRemoteCopcUrl` require `http`/`https`, cap the length, and refuse
   loopback, private, link-local, CGNAT and metadata hosts (`isBlockedHost`,
   including `169.254.169.254`). The Content-Security-Policy restricts
   `connect-src` to `self` and `https:`.

   The validator applies to the URL the user entered, and only to that URL. It
   is a literal check on a string — its own docstring notes it does not resolve
   DNS — so a host that passes can still redirect to a private address, and a
   name that resolves publicly once can resolve privately the next time (DNS
   rebinding). Redirects are followed deliberately: `redirect: 'error'` would
   break the ordinary signed-URL and CDN chains that public LiDAR hosting runs
   on (S3 to CloudFront, GCS signed redirects, DOI resolvers), so the residual
   is accepted rather than traded for a broken feature. What that residual
   amounts to is a blind request: no credentials are attached, CORS stops the
   response from being read, and the CSP is re-evaluated against each redirect
   target, which keeps `http://` destinations out entirely — including cloud
   metadata endpoints, which are http-only. The achievable maximum is an
   unreadable, credential-less GET to an `https` host inside the user's
   network, which is no more than any web page can already do with an `<img>`
   tag pointing at the same address.
3. URL parameters and the embed `postMessage` API. Treated as untrusted input;
   no path leads to dynamic code execution.

## Threats and mitigations

Server-side request forgery via a remote URL is handled by the URL validators
above and the CSP; the validators run before the fetch, not after — which is
also their limit. They see the entered URL and nothing that happens afterwards,
so redirects and DNS rebinding remain out of their reach, and the CSP is what
bounds those. The residual is described under input 2 and is accepted as
equivalent to ambient browser capability.

Cross-site scripting is handled by a strict Content-Security-Policy. The single
`innerHTML` sink is enforced static-only by `lint:unsafe-html`, and there is no
`eval` or `new Function`.

Supply-chain compromise is handled by `npm audit` on every change, a shipped
SBOM, reviewed dependency updates, and no post-install scripts in CI
(`npm ci --ignore-scripts`).

Tampered downloads are handled by the `SHA256SUMS` manifest and the
`release:verify` chain from the signed tag to the commit to each asset digest;
see the [security policy](../.github/SECURITY.md).

Scientific-integrity failure is the project's highest-value risk: a coordinate
that looks reasonable but belongs to the wrong unit, axis, CRS, vertical
reference or datum, because a wrong number is silent rather than a crash. It is
handled by the fail-closed coordinate-integrity model
(see [limitations.md](limitations.md), "Coordinate reference systems are read,
not transformed"), which withholds a metric claim unless the unit and frame are
known.

## Critical paths to protect

The CRS and coordinate pipeline, where a wrong number misplaces a deliverable
without any error; the remote-fetch validators; and the streaming scheduler.
Changes to these carry tests that assert the corrected value or the refusal, not
just that the code path ran.
