#!/bin/sh
# entrypoint.sh — record what the oracles are, then run what was asked.
#
# Every reference run inside this image writes its environment record first, so
# the record exists even when the run that follows fails. A record written after
# a successful run only ever describes successes, which is the wrong way round:
# the failures are the ones whose provenance is disputed.
#
#   docker run ... olv-oracles:1                       print the environment
#   docker run ... olv-oracles:1 versions              the same
#   docker run ... olv-oracles:1 node scripts/run-pdal-reference.mjs
#
# OLV_ORACLE_ENV_OUT names a file to write the record to. Unset, the record goes
# to stderr, so it cannot contaminate a command whose stdout is data.
set -eu

RECORDER=/opt/oracle-tools/record-oracle-versions.mjs

if [ "$#" -eq 0 ] || [ "$1" = "versions" ]; then
  exec node "$RECORDER"
fi

if [ -n "${OLV_ORACLE_ENV_OUT:-}" ]; then
  node "$RECORDER" "$OLV_ORACLE_ENV_OUT" >&2
else
  node "$RECORDER" >&2
fi

exec "$@"
