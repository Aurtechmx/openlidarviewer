# Pinned validation oracles

Every E4 claim in `validation/` rests on a second implementation having produced
the reference. Until now that implementation was whatever the workstation had
installed, and the records say so: each one carries
`containerPinning: "not-executed"` with a reason naming a stopped Docker daemon.

Two failures inside one hour showed the cost.

1. A package upgrade moved GDAL from 3.13.1 to 3.13.3. The corpus cites 3.13.1
   in hundreds of places. Nothing checked, because every study compares
   committed artifacts against recomputed candidate output and never looks at
   the tool.
2. PDAL 2.10.2 began aborting in the dynamic loader, because a library it links
   was upgraded underneath it. PDAL is the reference for several E4 legs. It was
   not producing wrong answers, it was producing none.

This directory holds the image that pins the oracles.
`scripts/verify-oracle-versions.mjs` is the check that catches both failures,
and it works whether or not the image is ever built.

## Why the files live here

The image exists to produce validation references and nothing else. `validation/`
already holds the corpus, the protocols, the studies and the `reference-runs*.json`
records that name tool versions, so the pins sit beside the records that cite
them. `scripts/` is Node tooling for the project itself, and a Dockerfile at the
repository root would read as "how to build the application", which this is not.

The guard is the exception: it lives at `scripts/verify-oracle-versions.mjs`
with the other `lint-*` and `verify-*` scripts, because it is a check over the
corpus rather than part of the image.

## Contents

| File | What it is |
| --- | --- |
| `Dockerfile` | The image. Base pinned by digest, packages by lock. |
| `conda-linux-64.lock` | 209 conda packages, each a URL with its sha256. |
| `requirements-pypi.txt` | `laszip` bindings, hash-pinned, the one thing conda-forge does not package. |
| `npm/package.json`, `npm/package-lock.json` | `3d-tiles-validator@0.6.1`, isolated from the project's own manifest. |
| `wbt-settings.json` | The WhiteboxTools settings the image installs read-only. |
| `oracle-pins.json` | Every pin in one machine-readable file. The guard reads `oracleVersions`. |
| `solve-lock.mjs` | Regenerates the lock and the conda half of the pins. |
| `record-oracle-versions.mjs` | Writes the `environment` block a reference run records. |
| `entrypoint.sh` | Records the environment, then runs the command. |

## Build and run

```sh
docker build --platform=linux/amd64 --build-arg BUILT_AT=$(date -u +%F) \
  -t olv-oracles:1 validation/oracles

# what the oracles are
docker run --rm --platform=linux/amd64 olv-oracles:1

# a reference run, recording its environment first
docker run --rm --platform=linux/amd64 -v "$PWD":/repo -w /repo \
  -e OLV_ORACLE_ENV_OUT=/repo/oracle-environment.json \
  olv-oracles:1 node scripts/run-pdal-reference.mjs
```

The platform is named rather than inherited. conda-forge's PDAL stops at 2.7.2
for `linux-aarch64`, and the version this corpus cites, 2.10.2, exists for
`linux-64` only. An arm64 image would have to change the oracle, which is the
thing being pinned, so on an arm64 host the image runs under emulation.

## What is pinned

| Oracle | Version | Pinned by |
| --- | --- | --- |
| base image | `mambaorg/micromamba:2.9.0-debian13-slim` | `sha256:1c1922d3417931f17fb45ec7306e83fcaf58c7af2324ffe242448557b78bdd9f` |
| PDAL | 2.10.2 | conda lock, `pdal-2.10.2-hc364b38_0` |
| GDAL | 3.13.1 | conda lock, `libgdal-core-3.13.1-hd345f60_8` |
| WhiteboxTools binary | 2.4.0 | conda lock, `whitebox_tools-2.4.0-py312h0ccc70a_2` |
| whitebox wrapper | 2.3.6 | conda lock, `whitebox-2.3.6-pyhd8ed1ab_0` |
| laspy | 2.7.0 | conda lock |
| lazrs | 0.8.2 | conda lock |
| laszip bindings | 0.3.0 | PyPI wheel sha256 |
| Node | 22.23.2 | conda lock |
| 3d-tiles-validator | 0.6.1 | `npm/package-lock.json` |

## The traps this directory exists to close

### The whitebox package does not ship the binary

On first import it fetches
`https://www.whiteboxgeo.com/WBT_Linux/WhiteboxTools_linux_amd64.zip`, a URL
carrying no version and no checksum, and the downloader verifies no hash.
Pinning `whitebox==2.3.6` pins the wrapper alone. Upstream's GitHub releases
v2.0.0 through v2.4.0 carry no binary assets, so there is no versioned download
to point at instead. The image installs conda-forge's `whitebox_tools`, which is
built from source and hashed in the lock, and never reaches that URL. The two
versions disagree on purpose: the wrapper is 2.3.6 and the binary reports 2.4.0,
and the binary is what computes.

### WBT_PATH does not do what its name suggests

It makes the wrapper's
downloader return early, and that is all. The wrapper still sets its executable
directory to its own package directory and chdirs there before running
`./whitebox_tools`, so the image links the binary into that directory as well.

### settings.json is hidden mutable state

It sits beside the executable and
persists `compress_rasters` (default true) and `max_procs` (default -1), both of
which change output bytes. The copy shipped inside the Python package carries the
upstream author's own home directory as `working_directory`. The image writes it
deterministically and takes the write bit away. Two caveats survive that:
WhiteboxTools applies `--max_procs` per tool rather than globally, so
`max_procs: 1` has to be verified for each tool a study uses; and the Python
wrapper reads `settings.json` from the current working directory at construction
time, not from beside the executable, so a reference run should leave no
`settings.json` in its working directory.

### Two LAZ backends, only one of which is independent

lazrs and WhiteboxTools
both wrap laz-rs, the same upstream decoder, so a laspy-with-lazrs result
compared against WhiteboxTools is one implementation compared against itself.
LASzip is a separate codebase. Both backends are installed, and
`record-oracle-versions.mjs` records which were available and which laspy picked,
because that is what decides whether a leg is cross-implementation at all.

### Node 22, not 26

`3d-tiles-validator@0.6.1` pulls `better-sqlite3@11.10.0`
transitively, which has no prebuilt binary for Node 26 and falls back to a
node-gyp build that fails.

## What is not in the image

- GRASS 8.5.0. conda-forge's build requires proj `>=9.7.1,<9.8.0` and
  resolves against libgdal-core 3.12.3, while GDAL 3.13.1 requires proj
  `>=9.8.1,<9.9.0`. They cannot share one environment. A GRASS-only linux-64
  solve is 171 packages and 260 MB of downloads, so it would be a second prefix
  or a second image.
- CloudCompare, unless `--build-arg WITH_CLOUDCOMPARE=1` is passed. Debian
  trixie main, which is this base image's distribution, carries
  `cloudcompare 2.13.2+git20240821+ds-1`, and it does run headless. Tested in
  this image on 2026-08-22:
  `CloudCompare -SILENT -AUTO_SAVE OFF -O a.txt -O b.txt -C2C_DIST` over two
  200-point clouds under `QT_QPA_PLATFORM=offscreen`, with no X server and no
  xvfb, exited 0 and reported a mean distance of 0.303472. It is off by default
  because it costs 200 packages and 149 MiB of downloads for tools no study
  currently uses, and because apt resolves against whatever trixie serves today,
  which is a weaker pin than the hashes above. A study that needs M3C2, ICP,
  CSF, C2C or C2M should turn it on and pin the deb versions, ideally from
  `snapshot.debian.org`. The installed size delta was not measured.
- SAGA and R. `VRM-SAGA-ANALYTIC` used SAGA 7.8.2 from a QGIS bundle, and
  conda-forge has no saga package. `MEAS-PROFILE-OGR-R-CORRIDOR` used R 4.4.1
  and SpatiaLite 5.1.0, both of which conda-forge packages and either could be
  added at the cost of a larger image. The guard reports both as absent rather
  than failing.

## The guard

```sh
node scripts/verify-oracle-versions.mjs
```

It reads the versions the records already state, in
`validation/cross-implementation/studies/*.study.json` and in every
`environment` block under `validation/`, runs each oracle's own version command,
and compares.

- A tool that is not installed is reported and passed over. Several legs
  already record `status: "failed"` rather than fabricating a reference, and a
  machine without SAGA is a normal machine.
- A tool that is installed and cannot report its version exits non-zero.
  That is the PDAL failure exactly.
- A version that disagrees with a record exits non-zero and names every file
  that would have to change. That is the GDAL failure exactly.
- A pin in `oracle-pins.json` that disagrees with a record exits non-zero
  even when no oracle is installed at all, which is the half that runs on a CI
  machine with neither GDAL nor PDAL on it.

`validation/snapshot/` is skipped. It is a frozen copy of an earlier release and
its versions are supposed to differ from today's machine.

## Regenerating the lock

```sh
node validation/oracles/solve-lock.mjs          # rewrite the lock and the pins
node validation/oracles/solve-lock.mjs --check  # fail if conda-forge has moved
```

The solve runs on the host and needs no container runtime, so the pins can be
reviewed before anything is built. It passes `CONDA_OVERRIDE_GLIBC` and
`CONDA_OVERRIDE_LINUX` because the solver otherwise reads the virtual packages
of the machine it runs on, and a macOS host reports no glibc at all. The values
are the base image's and are recorded in the lock header.

Regenerating changes the oracle. Run the guard afterwards, and if a version
moved, either keep the old pin or re-run the affected references and update
every record that cites the old version.

## The image does not reproduce the committed references byte for byte

Measured on 2026-08-22, inside the image, against the committed aspect
reference. The command is the one the study records, `gdaldem aspect
input-dem.asc aspect-gdal.asc -alg Horn -of AAIGrid`, and the GDAL version is
3.13.1 on both sides.

```
comparable cells: 11564
identical cells:  11260
cells differing:  304
max abs diff:     3.05e-05 degrees
mean abs diff:    2.08e-07 degrees
```

Every difference is one float32 unit in the last place at values near 250
degrees. The committed artifact came from a Homebrew macOS arm64 build of GDAL
3.13.1 and this one from a conda-forge linux-64 build of the same version, and
two builds of one version do not agree to the bit. The slope reference produced
by `gdal raster slope` differs from its committed artifact for the same reason.

Two consequences. Adopting the image for a leg means re-running that leg's
reference and updating the sha256 the record carries, not assuming the bytes
will match. And version identity, not byte identity, is what a pin across
machines can promise, which is what the guard checks.
