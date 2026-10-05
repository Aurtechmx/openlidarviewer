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
3. URL parameters and the embed `postMessage` API. Treated as untrusted input;
   no path leads to dynamic code execution.

## Threats and mitigations

Server-side request forgery via a remote URL is handled by the URL validators
above and the CSP; the validators run before the fetch, not after. The validators
reject unsupported schemes, embedded credentials, and literal private-network
hosts (localhost, private/link-local/CGNAT IPv4, and unsafe/mapped-private IPv6),
and remote point-cloud fetches use `credentials: 'omit'` with `redirect: 'error'`.
This is a syntactic, pre-fetch check: it does not resolve or pin DNS, so a
public-looking hostname that resolves (or later re-resolves) to a private address
is bounded by the browser (its CORS, Private Network Access controls, and the
`connect-src` CSP) not by this client-side validation. OLV does not claim to be
SSRF-proof or to guarantee a public destination.

Cross-site scripting is handled by a strict Content-Security-Policy. The single
`innerHTML` sink is enforced static-only by `lint:unsafe-html`, and there is no
`eval` or `new Function`.

Supply-chain compromise is handled by `npm audit` on every change, a shipped
SBOM, reviewed dependency updates, and no post-install scripts in CI
(`npm ci --ignore-scripts`).

Tampered downloads are handled by the `SHA256SUMS` manifest and the
`release:verify` chain from the signed tag to the commit to each asset digest;
see the [security policy](../.github/SECURITY.md).

Report integrity has two layers. Every integrity report carries an unkeyed
SHA-256 digest over its body. A match shows the digest agrees with the contents,
which catches accidental edits; anyone who edits a figure can recompute it, so
it is a self-consistency check, not a signature.

A user can also sign a report ("Sign this report" in the Export panel). The
signature is ECDSA P-256 with SHA-256 over the same canonical body the digest
covers, plus the algorithm id, the key id, the signer's claimed time, the app
version, an optional signer label and the digest. The private key is created in
the browser as a non-extractable WebCrypto key and stored in IndexedDB; no key
leaves the device, and nothing is sent over the network.

What the signature protects: a verifier detects any change to the report's
figures or the signed metadata made after signing, and a signature copied onto
another report fails. It covers the parsed values, not the file's bytes, so
whitespace, key order and number spelling can differ without a figure changing.
A file that repeats a member name, writes the signature in a non-canonical form
or carries extra members in the public key is refused. A signature that is valid for the key inside
the report reads as "signed, signer unverified" until the reader supplies a
public key or key id and it matches.

What it does not protect:

- Identity. It shows that the holder of a key signed the report. The signer
  label is free text and is shown as unverified.
- Time. The signing time is the signer's own clock, recorded as a claim.
- Source. The verifier does not compare `sourceSha256` with a source file.
- Correctness. A signed report can hold wrong numbers.
- Removal. Deleting the signature field leaves a report that verifies as an
  unsigned one, so a reader who expects a signature must check that it is
  present.
- A compromised browser profile, extension or page script can ask the stored key
  to sign anything. The key cannot be read out, but it can be used.
- Linking. Every signed report carries the key id and public key, so anyone
  holding two signed reports can tell the same key signed both. Deleting the
  key and creating a new one gives a new key id.
- Private windows. A private window forgets the key when it closes.
- Key loss. Clearing site data deletes the key. Reports signed earlier still
  verify against their embedded public key; a new key has a different key id.

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
