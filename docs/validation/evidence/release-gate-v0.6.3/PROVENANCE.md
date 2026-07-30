# Release-validation run, v0.6.3

One run of the release gate battery, in order, from a clean clone, with the real
exit code of every command recorded.

It exists because the gates had only ever been run piecemeal across a long
session on a working tree with local state in it. No single run demonstrated the
green gate the release notes describe. This is that run, and it is written down
whatever it found.

| Field | Value |
| --- | --- |
| Evaluated commit | 300cfbf82a65aaa9f352c4d782d571ef02fee4cd |
| Tree | `git clone` of the repository, checked out at that commit, `npm ci` from the lockfile |
| Date | 2026-07-30 UTC |
| Host | darwin-arm64, macOS 26.5.2 |
| Outcome | five gates, five exit codes of 0 |
| Tag | none; this run precedes the tag |

This is a local run on one machine, not a workflow artifact, so there is no run
URL to cite and none is implied. What it demonstrates is that the battery passes
end to end on a tree containing only what the repository publishes, which is the
one thing a dirty working tree cannot demonstrate, since a file present locally
and absent from the repository is invisible to it.

`record.json` carries every number in machine-readable form. `summary.md` reads
it back in prose. `gate-logs/` holds the raw output of each command, with two
absolute path prefixes replaced so no tracked file names the machine that ran
it; `record.json` lists the substitutions and the sha256 of each log both before
and after. Those files are `.txt` rather than `.log`, and the directory is
`gate-logs/` rather than `logs/`, because `.gitignore` ignores both `*.log` and
an unanchored `logs`. Renaming them keeps the evidence tracked without touching
a shared ignore rule that other work depends on.

Reproduce with:

```bash
git clone https://github.com/Aurtechmx/openlidarviewer.git && cd openlidarviewer
git checkout 300cfbf82a65aaa9f352c4d782d571ef02fee4cd
npm ci
npx tsc --noEmit
npm run -s test:release
npx playwright test tests/e2e/ --project=deterministic
npm run -s build
```

Four Playwright specs skip themselves without the autzen COPC fixture, which is
not in the repository. A reproduction without that file matches this record.
