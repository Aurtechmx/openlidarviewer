# syntax=docker/dockerfile:1.7
#
# The pinned oracle image for OpenLiDARViewer's cross-implementation studies.
#
# Every E4 claim in validation/ rests on a second implementation having produced
# the reference. Until now those implementations were whatever the workstation
# happened to have installed, and every committed record says so: each one
# carries `containerPinning: "not-executed"` with a reason naming a stopped
# Docker daemon. Two failures inside one hour showed what that costs. A package
# upgrade moved GDAL from 3.13.1 to 3.13.3 while the corpus cited 3.13.1 in
# hundreds of places, and PDAL 2.10.2 began aborting in the dynamic loader
# because a library it links was upgraded underneath it. Neither was noticed by
# anything in the repository.
#
# This image is the fix for the first half of that: the oracles stop being
# whatever is installed. scripts/verify-oracle-versions.mjs is the fix for the
# second half, and it works whether or not this image is ever built.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY linux/amd64, EXPLICITLY
# ─────────────────────────────────────────────────────────────────────────────
# conda-forge's PDAL stops at 2.7.2 for linux-aarch64. The version this corpus
# cites, 2.10.2, exists for linux-64 only. An arm64 build of this image would
# therefore have to change the PDAL version, which changes the oracle, which is
# the thing being pinned. So the platform is named rather than inherited, and on
# an arm64 host it runs under emulation.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT IS PINNED AND HOW
# ─────────────────────────────────────────────────────────────────────────────
#   base image      by digest, never by tag
#   conda packages  by conda-linux-64.lock, 209 URLs each with its sha256
#   laszip          by PyPI wheel hash, --require-hashes
#   node tools      by npm/package-lock.json, integrity per package
#   WhiteboxTools   by the conda package, NOT by the wrapper's download
#
# The last one is the trap worth naming. The `whitebox` PyPI and conda package
# is a wrapper; it does not ship the binary. On first import it fetches
# https://www.whiteboxgeo.com/WBT_Linux/WhiteboxTools_linux_amd64.zip, a URL
# with no version and no checksum in it, and the downloader verifies no hash.
# Pinning `whitebox==2.3.6` pins the wrapper and nothing else. conda-forge's
# `whitebox_tools` package is the compiled binary, built from source, and the
# lock carries its sha256, so this image never touches that URL. Note that the
# two versions disagree by design: the wrapper is 2.3.6 and the binary reports
# 2.4.0, and the binary's own --version is the identity that matters.
#
# Build:
#   docker build --platform=linux/amd64 -t olv-oracles:1 validation/oracles
# Run a reference generator:
#   docker run --rm --platform=linux/amd64 -v "$PWD":/repo -w /repo olv-oracles:1 \
#     node scripts/run-pdal-reference.mjs

# mambaorg/micromamba:2.9.0-debian13-slim
# index digest sha256:b62ed0c54940e3c801642d72ba7d2462f06356c378eba92d603d39f2ce5e4a0d
# linux/amd64  sha256:1c1922d3417931f17fb45ec7306e83fcaf58c7af2324ffe242448557b78bdd9f
FROM --platform=linux/amd64 mambaorg/micromamba@sha256:1c1922d3417931f17fb45ec7306e83fcaf58c7af2324ffe242448557b78bdd9f

ARG BASE_IMAGE_REF="mambaorg/micromamba:2.9.0-debian13-slim"
ARG BASE_IMAGE_DIGEST="sha256:1c1922d3417931f17fb45ec7306e83fcaf58c7af2324ffe242448557b78bdd9f"
# Passed in as a literal so the image can state when it was built without the
# build reading a clock, which would make the layer cache lie.
ARG BUILT_AT="unset"

USER root
ENV ORACLE_PREFIX=/opt/oracles \
    MAMBA_ROOT_PREFIX=/opt/mamba \
    DEBIAN_FRONTEND=noninteractive

# ── the conda half ───────────────────────────────────────────────────────────
# --no-rc and --no-env keep the install from reading a channel list off the host
# or the base image. An @EXPLICIT lock names full URLs, so no channel resolution
# happens at all; those flags make that true rather than incidental.
COPY conda-linux-64.lock /tmp/conda-linux-64.lock
RUN micromamba --no-rc --no-env create --yes --prefix "${ORACLE_PREFIX}" \
      --file /tmp/conda-linux-64.lock \
 && micromamba clean --all --yes \
 && rm -rf "${MAMBA_ROOT_PREFIX}/pkgs" /tmp/conda-linux-64.lock

ENV PATH="${ORACLE_PREFIX}/bin:${PATH}" \
    PROJ_DATA="${ORACLE_PREFIX}/share/proj" \
    GDAL_DATA="${ORACLE_PREFIX}/share/gdal"

# ── the PyPI half ────────────────────────────────────────────────────────────
COPY requirements-pypi.txt /tmp/requirements-pypi.txt
RUN "${ORACLE_PREFIX}/bin/python" -m pip install --no-cache-dir --no-deps \
      --require-hashes --only-binary=:all: -r /tmp/requirements-pypi.txt \
 && rm -f /tmp/requirements-pypi.txt

# ── WhiteboxTools wiring ─────────────────────────────────────────────────────
# WBT_PATH stops the wrapper's downloader, and only that: read download_wbt(),
# which returns early when the variable is set. It does NOT redirect execution.
# The wrapper separately sets its executable directory to its own package
# directory and chdirs there before running ./whitebox_tools, so the binary has
# to be reachable from inside the package as well. Hence the link.
#
# settings.json is the hidden state. The Rust binary reads and rewrites it in
# its working directory, which is that same package directory, and it persists
# compress_rasters (default true) and max_procs (default -1). Both change output
# bytes. The copy shipped inside the Python package even carries the upstream
# author's home directory as working_directory. This writes the file
# deterministically and takes the write bit away, so a run cannot quietly
# persist different settings for the next run.
#
# --max_procs=1 is set here for the tools that read the file, but WhiteboxTools
# applies that flag per tool rather than globally, so a tool that ignores it has
# to be found by testing that tool, not by trusting this line.
COPY wbt-settings.json /tmp/wbt-settings.json
RUN set -eux; \
    WB_PKG="$("${ORACLE_PREFIX}/bin/python" -c 'import whitebox,os;print(os.path.dirname(whitebox.__file__))')"; \
    WBT_BIN="${ORACLE_PREFIX}/bin/whitebox_tools"; \
    test -x "${WBT_BIN}"; \
    ln -sf "${WBT_BIN}" "${WB_PKG}/whitebox_tools"; \
    cp /tmp/wbt-settings.json "${WB_PKG}/settings.json"; \
    chmod 0444 "${WB_PKG}/settings.json"; \
    rm -f /tmp/wbt-settings.json; \
    printf '%s\n' "${WB_PKG}" > /etc/olv-whitebox-package-dir

ENV WBT_PATH="${ORACLE_PREFIX}/bin"

# ── the Node half ────────────────────────────────────────────────────────────
# Node is 22 because 3d-tiles-validator@0.6.1 pulls better-sqlite3 transitively,
# which has no prebuilt binary for Node 26 and falls back to a node-gyp build
# that fails. `npm ci` installs the committed lock exactly and refuses to
# resolve anything it does not name.
#
# This is a separate manifest from the project's own package.json on purpose:
# an oracle must never enter the application's dependency tree, its lockfile or
# its SBOM.
COPY npm/package.json npm/package-lock.json /opt/node-oracles/
RUN cd /opt/node-oracles \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force
ENV PATH="/opt/node-oracles/node_modules/.bin:${PATH}"

# ── identity and entrypoint ──────────────────────────────────────────────────
COPY record-oracle-versions.mjs /opt/oracle-tools/record-oracle-versions.mjs
COPY entrypoint.sh /opt/oracle-tools/entrypoint.sh
COPY conda-linux-64.lock /opt/oracle-tools/conda-linux-64.lock
RUN set -eux; \
    LOCK_SHA="$(sha256sum /opt/oracle-tools/conda-linux-64.lock | cut -d' ' -f1)"; \
    WB_PKG="$(cat /etc/olv-whitebox-package-dir)"; \
    printf '%s\n' "{" \
      "  \"baseImage\": \"${BASE_IMAGE_REF}\"," \
      "  \"baseImageDigest\": \"${BASE_IMAGE_DIGEST}\"," \
      "  \"lockSha256\": \"${LOCK_SHA}\"," \
      "  \"builtAt\": \"${BUILT_AT}\"," \
      "  \"platform\": \"linux/amd64\"," \
      "  \"whiteboxPackageDir\": \"${WB_PKG}\"" \
      "}" > /etc/olv-oracle-image.json; \
    chmod 0444 /etc/olv-oracle-image.json; \
    chmod 0555 /opt/oracle-tools/entrypoint.sh; \
    "${ORACLE_PREFIX}/bin/python" -c "import json;json.load(open('/etc/olv-oracle-image.json'))"

ENV WBT_SETTINGS_PATH=/opt/oracles/lib/python3.12/site-packages/whitebox/settings.json

# ── CloudCompare, off by default ─────────────────────────────────────────────
# Debian trixie main, which is this base image's distribution, carries
# cloudcompare 2.13.2+git20240821+ds-1. It runs headless: command-line mode
# still builds a Qt application, but QT_QPA_PLATFORM=offscreen is enough, with
# no X server and no xvfb. That was tested in this image on 2026-08-22, running
# `CloudCompare -SILENT -AUTO_SAVE OFF -O a.txt -O b.txt -C2C_DIST` over two
# 200-point clouds; it exited 0 and reported a mean distance of 0.303472.
#
# It is off by default because it costs 200 packages and 149 MiB of downloads
# for tools no study currently uses, and because an apt pin is weaker than the
# hash-verified installs above: apt resolves against whatever trixie serves
# today. A study that needs M3C2, ICP, CSF, C2C or C2M should turn this on and
# pin the deb versions, ideally from snapshot.debian.org.
#
#   docker build --platform=linux/amd64 --build-arg WITH_CLOUDCOMPARE=1 ...
ARG WITH_CLOUDCOMPARE=0
USER root
RUN if [ "${WITH_CLOUDCOMPARE}" = "1" ]; then \
      set -eux; \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cloudcompare; \
      rm -rf /var/lib/apt/lists/*; \
      dpkg-query --show --showformat '\${Version}\n' cloudcompare; \
      command -v CloudCompare; \
    fi
ENV QT_QPA_PLATFORM=offscreen

# The base image's own unprivileged user. Reference runs write into a bind mount
# of the repository, so running as root would leave root-owned artifacts behind
# on the host.
USER mambauser
WORKDIR /repo

ENTRYPOINT ["/opt/oracle-tools/entrypoint.sh"]
CMD ["versions"]
