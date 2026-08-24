## What this changes

A short description of the change and why it is needed. Link any related issue
(for example, `Closes #12`). If the why is obvious from the title, say what a
reviewer would otherwise have to reconstruct: what was wrong before, what made
it wrong, and what convinced you this is the fix rather than a workaround that
happens to move the symptom.

## Scope

What this PR does not touch, so a reviewer knows where to stop reading.

## Dependencies

Delete the lines that do not apply. A dependency on evidence is not the same as
a dependency on code: a dataset record that a claim cites has to land first even
when no source file connects them.

- Depends on: #NNN (code)
- Depends on: #NNN (evidence: cites a record that PR adds)
- Stacked on: #NNN (branched from that PR, not from `main`)

An empty list means this branch was cut from current `main`.

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / internal change
- [ ] Build, CI, or tooling

## Scientific impact

- [ ] S0: no scientific behaviour
- [ ] S1: provenance, wording, dataset register, or report scope
- [ ] S2: numerical or algorithmic
- [ ] S3: changes a claim, tolerance, evidence level, or an algorithm default

S2 ships with a test that fails before the change and passes after. S3 needs an
evidence review before merge, because the author's own tests were written
against the same understanding that produced the change, so they agree with it
by construction; the question a reviewer answers is whether that understanding
is right.

## Evidence

What you ran and what it said. Paste the numbers, not a summary of them. A gate
you did not run is not a gate that passed, and a reviewer cannot tell the two
apart from prose alone. Exit codes are worth quoting where a command is easy to
misread as green. If a number moved, say by how much and against what. This
section is the part of the PR a future reader trusts when the code has changed
underneath it and the description no longer matches.

- [ ] No tracked baseline, reference run, evidence level, tolerance, or
      registered study result changed.
- [ ] A tracked baseline did change. Which, and why the new value is the
      correct one rather than the one that makes CI pass:

## How it was tested

Describe what you checked. For rendering or navigation changes, note the
browser and backend (WebGPU or WebGL 2).

## Rollback

What reverting this leaves behind. Usually nothing.

## Checklist

- [ ] Branched from current `main`, or the stack is declared above
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] New behavior has unit tests where the logic is pure
- [ ] Docs updated if behavior or formats changed
- [ ] Commits follow Conventional Commits (`type(scope): description`)
