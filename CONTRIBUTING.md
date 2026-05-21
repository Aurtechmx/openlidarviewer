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

Please do not attach confidential scan data. Use a small, non-sensitive sample
instead, or describe the file's structure. See [SECURITY.md](SECURITY.md).

## Suggesting features

Open an issue describing the use case and the problem it would solve. Check
[`docs/roadmap.md`](docs/roadmap.md) first, since it may already be planned.

## Pull requests

Branch from `main` and keep each change focused. Before opening a PR, run:

```bash
npm run typecheck
npm test
npm run build
```

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
code actually supports it. Anything still in progress belongs in
[`docs/roadmap.md`](docs/roadmap.md), not the feature list. Measurement is for
visual inspection, so please do not describe it as survey-grade.

Licensed under MIT. By contributing, you agree your contributions are licensed
the same way.
