# Release assets — what a published OpenLiDARViewer release contains

The source archive deliberately excludes generated `release/` output, so a
reviewer holding only the source zip cannot see which external assets exist or
how to check them. This page is that index. It is committed, versioned, and
ships inside the archive; the generated hashes live in the attached manifest.

## The closed asset set

A published prerelease attaches exactly these, and nothing else:

| Asset | What it is |
|---|---|
| `openlidarviewer-v<version>-source-<ts>.zip` | The source tree, from `git archive` of the tagged commit |
| `openlidarviewer-v<version>-deploy-<ts>-root.zip` | The built site, contents at the archive ROOT (not wrapped in `dist/`) |
| `sbom.json` | CycloneDX 1.6 SBOM for the production dependency set |
| `test-evidence-v<version>.json` | The authoritative record of the exact-tag gate run |
| `gate.log` | The full gate output the evidence was derived from |
| `gate.log.sha256` | Hash of that log |
| `release-manifest-v<version>.json` | Binds tag, commit, toolchain, and every payload hash |
| `SHA256SUMS` | Hashes of every asset, manifest included |
| `RELEASE_NOTES_v<version>.md` | The human-readable notes |

"Exactly one of each" is enforced, not just expected: a leftover zip from a
previous cut is the failure that survives every other check, because each file
is individually valid and only the SET is wrong.

## How the hashes chain

There is a cycle to avoid here, and the resolution is not guessable, so it is
stated plainly:

```
release-manifest → hashes every PAYLOAD asset (zips, sbom, evidence,
                   gate.log, gate.log.sha256, release notes)
                   — never itself, never SHA256SUMS
SHA256SUMS       → hashes everything, the manifest included
```

Each covers what the other cannot. `npm run release:verify` walks both
directions, so a tampered file fails one side or the other whichever it is.

## Verifying a download

```bash
# 1. every asset is intact and matches the published list
shasum -a 256 -c SHA256SUMS
shasum -a 256 -c gate.log.sha256

# 2. the set is complete and self-consistent — no rebuild required
npm run release:verify -- --dir <downloaded-assets>
```

`release:verify` checks far more than hashes: that the manifest and the evidence
name the same commit as the tag, that the evidence is authoritative and was
produced on the canonical toolchain, that exactly one claim sits at E4 and it is
`SLOPE-RASTER`, that the bundle is under its ceiling, that the source archive
carries its required files and none of the forbidden ones, and that the deploy
archive is the site root.

## Why the evidence is an attached asset, not a committed file

Evidence is collected FROM a gate run. Committing it necessarily creates a new
commit, so a committed record can only ever describe the commit *before* the one
it ships in. That one-commit gap is small and it is exactly the ambiguity that
makes "the tag is the tested commit" unprovable.

The release workflow closes it by never committing the evidence at all: it
checks out the tag, gates that commit, generates the record as an artifact of
that same checkout, packages the same unchanged tree, and attaches all of it.
The tested, packaged, evidenced and manifested commit are then one object.

`docs/validation/test-evidence.json` remains in the repository as the last
committed **development** record. It is marked `releaseAuthoritative: false`
and must not be cited as release evidence.

## Reproducing the source archive

The source archive is byte-reproducible: names and entry timestamps come from
the commit, not the wall clock.

```bash
git checkout v<version>
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" bash scripts/package.sh out --source-only
shasum -a 256 out/*source*.zip     # matches the published hash
```

The deploy archive is **not** claimed to be byte-reproducible — the obfuscator
is free to vary between runs. Verify it by hash against the manifest, not by
rebuilding.
