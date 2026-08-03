# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in OpenLiDARViewer, please report it
**privately** rather than opening a public issue. Email **info@aurtech.mx**
with:

- a description of the issue,
- steps to reproduce it, and
- the affected version or commit.

You can expect an acknowledgement and, where applicable, a fix or mitigation
plan. This is a single-maintainer project, so a report may sit for a few days
before it gets a considered reply rather than a fast one, and a fix that
changes measured output has to clear the release gate before it ships. If a
report affects data a user already exported, the fix is published with an
erratum describing what changed and how to tell whether your own output was
affected.

## Verifying what you received

Commits on `main` are signed with an SSH key registered to the maintainer's
GitHub account, so a commit carries evidence of who wrote it rather than only
a name and address that anyone can set. To check one locally:

```bash
git verify-commit <sha>
```

GitHub shows the same result as a Verified badge beside the commit. An
unsigned commit, or one signed by a key the account does not hold, will not
carry that badge.

Release assets are verified as a set rather than one file at a time:

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

`release:verify` walks the chain the release manifest records, from the tag to
the commit to each asset digest, and fails if any link disagrees. Release tags
cannot be moved or deleted once published, so a published citation keeps
pointing at the bytes it was issued against. If you are checking a release for
the first time, run both commands: the checksums prove the files arrived
intact, and `release:verify` proves they belong to the release they claim.

## Local-first data handling

OpenLiDARViewer is designed around local-first inspection. Scan files are read,
parsed, and rendered entirely in the browser, and there is no server to upload
them to. The security of
your data also depends on how and where you choose to deploy and run the app.

## Secrets and credentials

OpenLiDARViewer is a client-only static web app. It ships no server, database,
or user authentication, and the built artifact contains no secrets. The release
gate scans the tree and the archive for them, and the SBOM covers the shipped
dependency set. The only secrets are CI-only GitHub Actions secrets, such as the
mutation-dashboard key. They live in GitHub's encrypted secret store, are
referenced by name from workflows, are never written into the repository or the
bundle, and are rotated if exposure is suspected. Every workflow declares
least-privilege `permissions`.

## Dependency and code scanning

Every push and pull request runs software-composition analysis (`npm audit` over
the runtime dependencies) and static analysis (CodeQL and SonarCloud). Findings
are triaged: a High or Critical result is remediated, or documented as not
exploitable, before the next release, and the maintainer does not cut a release
with an open High or Critical dependency or code-scanning alert. Lower-severity
findings are fixed or recorded with the reason they are accepted. Dependency
changes are reviewed rather than merged automatically.

## Supported versions

OpenLiDARViewer is actively maintained. Security fixes are applied to the
latest version on the default branch, and there is no long-term support branch
for older releases. Older tagged releases stay published and verifiable, since
the archived assets are what a citation points at, but they do not receive
backported fixes. If you depend on a specific version for a published result,
cite that version and record the commit rather than expecting it to be
maintained.

| Version | Supported |
|---|---|
| Latest (`main`) | Yes |
| Older versions | Best effort |
