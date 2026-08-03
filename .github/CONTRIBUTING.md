# Contributing to OpenLiDARViewer

Thanks for your interest in improving OpenLiDARViewer. It is an actively
maintained open-source project, and contributions are welcome.

## Getting started

```bash
git clone https://github.com/aurtechmx/openlidarviewer.git
cd openlidarviewer
npm install
npm run dev
```

## Reporting bugs

Open a GitHub issue and include:

- what you expected to happen, and what actually happened
- steps to reproduce
- your browser, OS, and GPU if it is relevant
- the file format involved

A small sample file that reproduces the issue, or a description of the file's
structure, is ideal.

## Suggesting features

Open an issue describing the use case and the problem it would solve. Check
the open issues first, since the same idea may already be under discussion.

## Pull requests

Branch from `main` and keep each change focused. Before opening a PR, run:

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs the whole unit suite. It is large, so it is also split into
five coverage-complete buckets you can run individually (and CI runs in
parallel): `npm run test:unit`, `test:export`, `test:terrain`, `test:ui`, and
`test:slow`.
The buckets always union to the full suite, and a newly added test defaults into
`unit`; `npm run test:buckets:verify` asserts that partition holds. Playwright
specs run via `npm run test:e2e`.

Keep the module boundaries intact: one file per format or concern, and
analysis modules must not import the renderer.

## Testing policy

New functionality ships with automated tests covering it. This is a
requirement of the project, not a preference. It applies to bug fixes too: a
fix comes with a test that fails before the change and passes after. That
second rule matters more than it sounds, because a fix without a failing test
proves only that the code changed, not that the bug was understood, and the
suite stayed green through all eighteen defects corrected in v0.6.2.

The algorithmic core is test-first (Vitest); the renderer is covered by
Playwright. Where a change corrects a published number or a declared unit,
the test asserts the corrected value rather than the code path that produces
it.

Three things enforce this rather than trusting the author:

- CI runs the full suite on every push and pull request, and a red suite
  blocks the merge;
- `npm run test:buckets:verify` asserts the five buckets still union to the
  whole suite, so a new test cannot be added outside what CI runs;
- the release gate refuses to produce an evidence record if any mandatory
  stage did not run, which includes coverage and the unit suite.

A change that genuinely cannot be tested should say so in the pull request and
explain why. Reviewers usually read that as a design question rather than a
testing one, because the parts of this codebase that resist testing are almost
always the parts doing too much at once, and the fix is to split them before
writing the test.

## Coding style

- Strict TypeScript (`verbatimModuleSyntax`, `erasableSyntaxOnly`)
- Conventional Commits: `type(scope): description`
- See the [Developer Manual](../docs/developer-manual.md) for the full standard

## Documentation

Documentation lives in `README.md` and `docs/`. If a change affects behavior,
update the docs in the same pull request.

## Collaborators and access

Write access is granted only to trusted contributors, and access is reviewed
before escalated permissions to sensitive resources (CI secrets,
branch-protection bypass) are granted. A new collaborator starts with the least
access their task needs, reviewed again when their role changes. Branch
protection applies to everyone: pull requests, passing checks, resolved
conversations, and linear history are required, with no direct pushes to `main`.

## A note on honesty

Do not describe a format, feature, or accuracy level as supported unless the
code actually supports it. Anything still in progress should not be listed
as a feature. Measurement is for visual inspection, so please do not
describe it as survey-grade.

Licensed under MIT. By contributing, you agree your contributions are licensed
the same way.
