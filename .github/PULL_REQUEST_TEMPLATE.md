## What this changes

A short description of the change and why it is needed. Link any related issue
(for example, `Closes #12`). Say what was wrong before, what caused it, and why
this is the fix.

## Scope

What this PR does not touch, so a reviewer knows where to stop reading.

## Dependencies

Delete the lines that do not apply. A dataset record that a claim cites has to
land before the claim, even when no source file connects them.

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
evidence review before merge.

## Evidence

What you ran and what it said. Paste the numbers, not a summary of them, and
quote exit codes where a command is easy to misread as passing. If a number
moved, say by how much and against what.

- [ ] No tracked baseline, reference run, evidence level, tolerance, or
      registered study result changed.
- [ ] A tracked baseline did change. Which, and why the new value is correct:

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
