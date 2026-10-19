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

Email is the only private reporting channel. GitHub's private vulnerability
reporting is not enabled on this repository, so there is no "Report a
vulnerability" button to use; please do not file the details as a public issue
or discussion.

## Verifying what you received

Pull requests merge into `main` as squash commits that GitHub creates and
signs with its web-flow key. GitHub shows a Verified badge beside each one. The
signature records that GitHub made the merge commit; the author named on it is
the pull request author. To check one locally:

```bash
curl -s https://github.com/web-flow.gpg | gpg --import
git verify-commit <sha>
```

Release assets are verified as a set rather than one file at a time:

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive>.zip \
  --repo Aurtechmx/openlidarviewer \
  --signer-workflow Aurtechmx/openlidarviewer/.github/workflows/release.yml \
  --source-ref refs/tags/vX.Y.Z
```

Replace `vX.Y.Z` with the release tag. The two extra flags matter: without them
the command accepts an attestation from any workflow in the repository, on any
ref, as proof of provenance.

`release:verify` walks the chain the release manifest records, from the tag to
the commit to each asset digest, and fails if any link disagrees. The checksums
prove the files arrived intact, and `release:verify` proves they belong to the
release they claim. The release workflow attests build provenance for each
archive and for the SBOM through Sigstore, so `gh attestation verify` shows
that an archive came from that workflow at the tagged commit. `SHA256SUMS` and
the release manifest carry no signature of their own. A published citation
keeps pointing at the bytes it was issued against only while its release tag
stays where it is. Whether tags can be moved or deleted is a repository setting
on GitHub, and this file cannot attest to it (see Release trust).

### Release trust

A release is built only from a commit that is already on `main`. The release
workflow's first job fetches `main` and refuses to continue unless the tagged
commit is an ancestor of it, and `scripts/validate-release-ref.mjs` applies the
same rule, treating an unanswerable question as a refusal. `main` is the branch
that requires a pull request, so a tag pushed on a commit that never went
through that path does not produce a release or an attestation. The publish
job also refuses to touch a release that already exists for the tag: it
creates one as a draft, never replaces assets on an existing release, and
a human publishes it. These checks are in the workflow in this repository; the
repository settings that back them (who may create tags, and whether releases
are immutable) are configured on GitHub and are not something this file can
attest to.

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

Every pull request, every push to `main` and every release tag runs
software-composition analysis (`npm audit --omit=dev --audit-level=high` over
the runtime dependencies), and the required `ci-green` check fails on a high or
critical advisory. The same audit runs weekly on a schedule, and CI verifies
the npm registry signatures of the installed packages. Static analysis (CodeQL
and SonarCloud) runs on pull requests and on `main`; CodeQL is configured
through GitHub's default setup.

Findings are triaged. A High or Critical advisory in the shipped dependency set
is remediated before a release. Code-scanning alerts are triaged and recorded
in the repository's code-scanning alerts: each one is fixed, or dismissed with
the reason written on the alert, for example a false positive on a
null-prototype object or a worker message handler, or an alert in test or build
tooling that never ships. Alerts can be open between triage passes, so neither
an open alert nor a dismissed one is a statement that the code is or is not
exploitable; the dismissal reason is the record. Lower-severity findings are
fixed or recorded with the reason they are accepted. Dependency changes are
reviewed rather than merged automatically.

The Node tools used by the validation image (`validation/oracles/npm`) have
their own manifest and lockfile. They are never part of the shipped archive or
its SBOM, but they are kept current by Dependabot like the rest.

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
