# Cross-platform reproducibility evidence

These files are the output of the `Benchmark portability` workflow, copied here
so the result is tracked in the repository rather than living only as a CI
artifact with a retention window.

| Field | Value |
| --- | --- |
| Workflow run | https://github.com/Aurtechmx/openlidarviewer/actions/runs/30221805663 |
| Evaluated commit | 50e76d22d405f716386dea50138e684fbe5a6911 |
| Status | reproduced |
| Platforms | darwin-arm64, linux-x64 |

`benchmark-results/` is untracked, so a local run produces only the platform it
ran on and reports `single-platform`. That is the correct verdict for one leg
and is not the verdict this evidence carries: both legs ran on the workflow
above.

Regenerate with `gh workflow run "Benchmark portability" --ref <ref>`, then
replace this directory with the run's `portability-comparison` artifact and
update the run URL and commit above.
