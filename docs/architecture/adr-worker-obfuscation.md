# ADR: Single-source worker declarations for the live build

Status: accepted
Date: 2026-08-05

## Context

The app ships five Web Workers: the file parser, the COPC tile decoder, the EPT
laszip decoder, the terrain-core compute worker, and the classification derive
worker. Each worker reaches its module through `new Worker(new URL('./x.ts',
import.meta.url))`, and the live deployment build (`npm run build:live`) runs a
JavaScript source transform over the app's own TypeScript.

The transform's stringArray pass rewrites string literals. Applied to a module
that holds a worker URL or a dynamic `import()` of a worker client, it scrambles
the specifier, Vite can no longer read it statically, and the worker chunk never
emits. At runtime the dynamic import 404s, which surfaces as `vite:preloadError`
and forces a full page reload. This is the #266 production crash.

`vite.config.ts` guarded against this with two hand-maintained lists: the
transform `exclude` patterns and the chunk-emission pin list. Both named workers
by hand. A worker added to the codebase but missed from either list shipped
broken. The lists were parallel, unenforced, and drifted apart as workers grew,
so the crash class stayed live even after each individual fix.

## Decision

Declare every worker once, in `src/workers/workerRegistry.ts`. Each entry names
the worker module, its emitted chunk, the client module that constructs it, and
any async bridge that imports the client. `vite.config.ts` derives both the
transform `exclude` patterns and the chunk-emission pins from that registry
through `workerExcludePatterns()` and `workerChunkPins()`. No worker name is
copied by hand into two places.

Two guards enforce completeness:

- `scripts/lint-worker-registry.mjs` and `tests/workerRegistry.test.ts` fail if a
  worker module exists under `src/` but is absent from the registry, if a module
  constructs a worker without being declared, or if `vite.config.ts` hand-lists a
  worker name instead of deriving it.
- `tests/chunkIsolation.test.ts` and the in-Vite chunk-emission guard assert that
  every registered worker chunk emits in the build output.

A new worker is covered the moment its entry lands. A worker missing from the
single source fails the build and the test suite rather than shipping a 404.

## Consequences

Adding a worker means appending one registry entry. The obfuscation exclude, the
chunk pins, and the emission assertions follow from it. The parallel-list drift
that produced #266 can no longer occur.

This change does not touch the transform itself. The live build still obfuscates
the app's own source.

## The larger option: remove obfuscation from the official live build

The audit raised a broader question this ADR does not decide: whether the
official live build should obfuscate at all.

The obfuscation is source-hiding, not a security control. The readable source
lives on GitHub under the project's licence, so the transform hides nothing an
interested reader cannot already get. Against that, it carries real cost. It is
the direct cause of the #266 crash class. It forces a growing exclude list of
per-point hot loops that would otherwise run slower on the deployed site. It adds
build time and bundle weight. The registry removes the worst failure mode but not
the underlying liability.

Removing the transform would delete that liability outright: no worker exclude
list to keep complete, no per-point performance carve-outs, a smaller and faster
deployed bundle, and one build path instead of two.

This ADR recommends removing JS obfuscation from the official live build, but
does not do it. That change alters the shipped artifact and is the maintainer's
call. It should be a separate, deliberate change with its own review, not a side
effect of this reliability fix.
