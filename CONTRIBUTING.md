# Contributing to OpenLiDARViewer

Thanks for your interest in improving OpenLiDARViewer. It is an R&D-stage,
open-source project, and contributions are welcome.

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
four coverage-complete buckets you can run individually (and CI runs in
parallel): `npm run test:unit`, `test:terrain`, `test:ui`, and `test:slow`.
The buckets always union to the full suite — a newly added test defaults into
`unit`; `npm run test:buckets:verify` asserts that partition holds. Playwright
specs run via `npm run test:e2e`.

Add or update tests with your change. The algorithmic core is test-first
(Vitest), and the renderer is covered by Playwright. Keep the module
boundaries intact: one file per format or concern, and analysis modules must
not import the renderer.

## Coding style

- Strict TypeScript (`verbatimModuleSyntax`, `erasableSyntaxOnly`)
- Conventional Commits — `type(scope): description`
- See the [Developer Manual](docs/developer-manual.md) for the full standard

## Documentation

Documentation lives in `README.md` and `docs/`. If a change affects behavior,
update the docs in the same pull request.

## A note on honesty

Do not describe a format, feature, or accuracy level as supported unless the
code actually supports it. Anything still in progress should not be listed
as a feature. Measurement is for visual inspection, so please do not
describe it as survey-grade.

Licensed under MIT. By contributing, you agree your contributions are licensed
the same way.
