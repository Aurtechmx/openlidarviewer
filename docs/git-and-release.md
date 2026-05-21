# Git & Release Runbook

OpenLiDARViewer was built in a sandbox whose filesystem blocked git's internal
operations, so the full history is delivered as a **git bundle**
(`openlidarviewer.bundle`, one folder up from this repo). This runbook covers
adopting it and running the GitHub workflow on your own machine.

## 1. Adopt the clean history

The clean history is 10 atomic Conventional Commits on `main`, tagged `v0.1.0`.

**Option A — fresh clone (recommended; also drops build leftovers):**

```bash
git clone openlidarviewer.bundle openlidarviewer
cd openlidarviewer && npm install
```

**Option B — adopt into your existing folder:**

```bash
cd openlidarviewer
rm -rf .git
git init -b main
git pull ../openlidarviewer.bundle main
git fetch ../openlidarviewer.bundle 'refs/tags/*:refs/tags/*'
```

Verify with `git log --oneline` (10 commits) and `git tag` (`v0.1.0`).

## 2. Branching model — trunk-based / GitHub Flow

- `main` is always releasable and protected.
- Do feature work on short-lived branches: `feature/<description>`, `fix/<description>`.
- Never commit directly to `main` — always open a pull request.

## 3. Commit conventions — Conventional Commits

Format: `<type>(scope): <description>`
Types: `feat` (minor), `fix` (patch), `docs`, `test`, `ci`, `chore`, `refactor`, `perf`.
A `!` after the type or a `BREAKING CHANGE:` footer marks a major change.

## 4. Push to GitHub

```bash
gh repo create openlidarviewer --public --source=. --remote=origin
git push -u origin main --tags
```

(Or create the repo in the web UI, then `git remote add origin <url>` and the push.)

## 5. Branch protection — do this once

GitHub → Settings → Branches → add a rule for `main`:

- Require a pull request before merging.
- Require status checks to pass — select `build-and-test` and `e2e` (from `.github/workflows/ci.yml`).
- Require branches to be up to date before merging.
- Do not allow bypassing / direct pushes.

## 6. Feature work with worktrees

Keep `main` checked out while building a feature in parallel:

```bash
git worktree add ../olv-feature feature/my-feature
cd ../olv-feature        # build, commit, push, open a PR
git worktree remove ../olv-feature   # when merged
```

## 7. Cut the v0.1.0 release

The bundle already carries the `v0.1.0` tag. To publish it as a GitHub release:

1. Confirm `main` is pushed, CI is green, and run `git pull` first.
2. ```bash
   gh release create v0.1.0 \
     --title "OpenLiDARViewer v0.1.0" \
     --notes "First release — six-format drag-and-drop viewer, precision coordinate bridge, in-browser scan validation, WebGPU with a WebGL2 fallback."
   ```
3. Releases are immutable: never delete a tag and reuse it — if `v0.1.0` needs a
   fix, ship `v0.1.1`. When releasing from a non-default branch, pass `--latest=false`.

## 8. Pre-merge checklist (every PR into main)

- All review threads resolved.
- CI green — `build-and-test` and `e2e`.
- Branch rebased on the latest `main`.
