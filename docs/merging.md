# Merging several branches at once

Per-branch CI answers one question: does this branch pass on top of `main`. It
cannot answer whether two branches pass *together*, and two branches that each
pass alone can fail as a pair. `scripts/integration-merge.mjs` merges a set of
branches into a scratch worktree and runs the gate once over the result.

## When an integration merge is required

Merge directly when one branch is open and nothing else is in flight.

Run an integration merge first when any of these is true:

- Two or more branches are open at the same time and touch the same directory.
- One branch adds a file that another branch's code reads: a register, a
  manifest, a schema, a fixture, a dataset. Presence of a file is enough to
  change behaviour, so no overlap in the diffs is needed for a pair to break.
- A branch changes a gate script, a lint, or `package.json` scripts.
- More than three branches are open, whatever they touch.

## Commands

```sh
# the cheap gate: typecheck, every lint:*, vitest run. About two minutes.
npm run integration:merge:quick -- wave1/preset-truth wave1/queue-hardening 126

# the full release gate, npm run test:release:execute
npm run integration:merge -- 126 127 128

node scripts/integration-merge.mjs --help
```

Inputs mix freely. `wave1/preset-truth` is a branch, `126` and `#126` and a
pull-request URL are PR numbers resolved with `gh pr view`. Without `gh` on
`PATH`, PR numbers are refused with a message naming the alternative and branch
names still work.

The run happens in a temporary worktree under the system temp directory and is
deleted afterwards. The checkout you invoke it from is never modified, including
when the run fails. `--keep` leaves the worktree and prints the two commands
that remove it.

## Reading the output

```
═══ INTEGRATION MERGE SUMMARY ═══
base          origin/main @ dced38c
merge order   wave1/preset-truth → wave1/queue-hardening → wave2/stats-core
              sorted by branch name, then sha — determined by the input set, not argv order

#  BRANCH                 SHA      RESOLVED FROM                 MERGE
1  wave1/preset-truth     564fb16  origin/wave1/preset-truth     clean
2  wave1/queue-hardening  f8e1ce4  origin/wave1/queue-hardening  clean
3  wave2/stats-core       57d7d2f  origin/wave2/stats-core       clean

gate          npm run typecheck && ... && npx vitest run
gate exit     0
ignored files 0 tracked-but-ignored added by this merge, 1 already at base

RESULT        PASS — this combination is armed for auto-merge (exit 0)
```

- `merge order` is derived from the input set, sorted by branch name and then by
  commit sha. The order you typed the arguments in does not affect it, so the
  same set of branches produces the same tree for everyone.
- `RESOLVED FROM` names the ref each branch resolved to. `origin/<name>` is
  preferred because that is the commit `main` would receive. `<name> (local)`
  means no remote ref existed, so the run tested unpushed work.
- `gate exit` is the literal exit code of the gate command.
- `ignored files` counts files that are tracked and also matched by
  `.gitignore`, which is how 22 files of editor-plugin scaffolding once broke
  archive-portability verification while the pull request stayed green. The count
  is measured against the base, because the absolute count is neither zero nor
  platform-independent on this repository: `.gitignore`'s `*AUDIT*.md` pattern
  matches a tracked audit note under `docs/_audit/` where `core.ignorecase` is
  on, so macOS sees one pre-existing hit and Linux sees none. `--strict-ignored`
  demands an absolute zero.

Exit codes: `0` pass, `2` usage, `3` a ref did not resolve, `4` merge conflict,
`5` gate failed, `6` tracked-but-ignored files. A gate exit of 1 is reported as
script exit 5, so a caller can tell a failing suite from a conflict.

## When a branch conflicts

The run aborts that branch's merge, leaves the index clean, prints the
conflicting paths, and stops without attempting the remaining branches:

```
RESULT        FAIL [conflict] 1 branch(es) conflicted: tmp/conflict-b (exit 4)
```

Fix it on the branch, not in the scratch worktree, which is deleted when the run
ends. Rebase the branch reported as conflicting onto current `origin/main`, or
merge `main` into it, push, then re-run. The branch named is the later one in the
merge order; the conflict belongs to the pair, so either branch can carry the
resolution.

## When the combined gate fails and every branch passed alone

This is the case per-PR CI cannot reach. Worked example, from this repository:

- `wave2/dataset-register` adds `validation/datasets/dataset-register.yaml`.
- `wave2/xstudy-manifest`, at commit `f858ecb`, adds a study verifier that checks
  dataset ids by shape when that register is absent and by membership when it is
  present.
- Each branch alone: `--quick` exits 0.
- The pair: 17 tests fail in `tests/crossImplementationManifest.test.ts`, the
  gate exits 1, the script exits 5. The first assertion to break reports rule
  `R2-DATASET-ID` firing in a case that expected only `R7-UNCOUNTED-CARRIES-RESULT`,
  which is membership enforcement switching itself on.

```sh
npm run integration:merge:quick -- wave2/dataset-register wave2/xstudy-manifest
```

That command now exits 0. `wave2/xstudy-manifest` took the register as an
explicit argument instead of inferring it from the file being there, which is the
fix this section describes. Reproducing the failure needs the branch at the
commit above.

How to work it out from a failing run:

1. Read the failing test names. They name the subject, here the study verifier.
2. Find what the verifier does differently. A test called "reports that
   membership is unenforced while the register is absent" states the switch
   directly.
3. Search the other branches' diffs for the file the switch depends on:
   `git diff origin/main...<branch> --name-only`, then grep the verifier for that
   path.

The branch that reads the file owns the fix. It must state its rule rather than
infer it from a file existing: enforce membership always and ship the entries it
needs, or gate the strict rule on something explicit such as a flag in the
register itself. Land the fix, re-run the integration merge, and confirm exit 0
before either branch merges.

Both branches passing their own CI is not evidence about the pair, so do not
merge the first one on the theory that the second one can adapt afterwards. That
puts a broken `main` between the two merges.

## Running it on a runner

The `Integration merge` workflow does the same thing from the Actions tab, on
`workflow_dispatch` only. Supply the PR numbers or branch names in one field,
space or comma separated, and pick `quick` or `full`. It has no `pull_request`
trigger: a single-PR event carries one branch and no way to name the others, so
the question this tool asks cannot be expressed there. It is not a required
check either. Nothing about it replaces the per-PR gate.

## Arming a branch for auto-merge

A branch is armed only after it has been part of a green integration run that
contained every other branch open at the time.

The run goes stale when the set changes. Opening a new branch, pushing to an
armed branch, and `main` moving all invalidate it. Re-run before merging. Any
`FAIL` result disarms every branch in that run, not only the one named.
