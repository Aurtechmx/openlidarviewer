# CodeQL advanced setup

This directory holds the CodeQL configuration for the advanced (workflow-driven)
setup in [`../workflows/codeql.yml`](../workflows/codeql.yml). It replaces the
repository's managed *default* CodeQL setup.

## Why the switch

Default setup analyses the code well, but it cannot read a configuration file,
so there is no way to tell it about the remote loader's URL validator. The
result is that `js/client-side-request-forgery` keeps flagging the same guarded
`fetch` and re-raises the alert whenever the surrounding code is moved or
renamed. Alert #40 is the current instance; #12 was the identical finding on the
old `main.ts` and the maintainer already dismissed it. Advanced setup accepts
[`codeql-config.yml`](./codeql-config.yml), which lets us handle that one rule
deliberately instead of dismissing a fresh copy of it after every refactor.

Everything else about the analysis is kept the same as default setup:

- Languages: `actions` and `javascript-typescript` (default setup reports
  `actions`, `javascript`, `javascript-typescript`, `typescript`; advanced setup
  folds JS and TS into the single `javascript-typescript` identifier).
- Suite: `security-extended` (default setup's "extended").
- Triggers: push to `main`, pull requests into `main`, and a weekly schedule.

## The one exclusion, and the alternative

The config scopes out `js/client-side-request-forgery` by id, and nothing else.

That rule flags a user-provided URL reaching `fetch`. In this client-only
viewer, that happens in exactly two places, the remote EPT and remote COPC
loaders in `src/main.ts`, and both send the URL through `validateRemoteEptUrl`
/ `validateRemoteCopcUrl` first. Those reject non-`http(s)`, over-length,
credentialed, and (via `isBlockedHost` in `src/io/range/RangeSource.ts`)
loopback, RFC 1918, link-local, CGNAT, and cloud-metadata (`169.254.169.254`)
hosts before any request is made. The finding is a false positive.

The more precise fix would be a Models-as-Data barrier. CodeQL 2.25.2 and later
do support `barrierModel` / `barrierGuardModel` for JavaScript, so this was the
first thing evaluated. It does not fit here: those models anchor on a package or
global type (`codeql/javascript-all`, or an npm package name such as `axios`),
and our validator is a first-party local module with no package identity in the
API graph. There is no dependable `type` to bind the barrier to, and no way to
confirm a binding without running CodeQL. The scoped `query-filter` is the
reliable mechanism instead. Because it is the only filter and it is an
`exclude`, every other query stays active; the cost is that this single rule is
off across the whole repository rather than only on those two functions, which
is acceptable because those two functions are the app's only user-URL→`fetch`
surface.

## How to activate

Advanced and default CodeQL setup cannot both run on a repository, so the
maintainer has to turn default setup off before this workflow can analyse
anything.

1. Merge this PR. On its own, merging changes nothing about scanning yet.
2. In the repository, go to **Settings → Code security → Code scanning →
   CodeQL analysis**, open the **⋯** menu, and choose to **disable** default
   setup (it switches to advanced).
3. The `CodeQL` workflow then runs on the next push to `main` and on the
   schedule. Re-running it against the commit that carried alert #40 clears the
   alert, and the guarded pattern no longer re-flags.

## What is verified, and what is not

Verified locally, before opening the PR:

- YAML parses and `actionlint` passes on the workflow.
- Every action is pinned to a full commit SHA (`actions/checkout` reusing the
  repo's existing pin; `github/codeql-action/init` and `.../analyze` at the
  `v3.37.5` commit).
- The language set and suite match the live default setup, read back from
  `repos/Aurtechmx/openlidarviewer/code-scanning/default-setup`.
- `js/client-side-request-forgery` is the exact, current query id in the CodeQL
  JavaScript pack, so the filter is not a no-op.

Needs CI and the activation above to confirm, since CodeQL cannot be run in this
environment:

- That the query-filter actually removes the finding on a real scan.
- That the two-language advanced run reports the same coverage as default setup.

One expected quirk: while default setup is still enabled, the CodeQL job on this
PR (and on `main`) fails at the SARIF upload step with a "default setup is
enabled" conflict. That is the platform refusing to accept results from two
setups at once, not a fault in the workflow, and it clears the moment default
setup is disabled. The workflow's YAML is validated independently by
`actionlint` in the meantime.
