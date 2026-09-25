# Reproducibility: OpenLiDARViewer 0.7.0-alpha.1

In development. The pinned toolchain, archive digests and the
release-authoritative test record are written here at freeze. They are absent
now because they do not yet exist.

## Baseline

Develops from v0.6.9, commit `c164e907f50ff49da7233385d92285c53dfb3b8d`.

## Dependency set

`docs/project/DEPENDENCIES.md` records the dependency audit and follows the
lockfile. The runtime set moved in this cycle: three.js and two loaders.gl
loaders advanced, with `@loaders.gl/core` held at 4.4.x because every 4.5.1
loader declares a peer dependency on `@loaders.gl/core` ~4.4.0.

## Evidence identity

Development evidence is generated on a branch and is not release-authoritative.
It names the commit it measured, and that commit is a branch tip rather than a
tag until freeze.
