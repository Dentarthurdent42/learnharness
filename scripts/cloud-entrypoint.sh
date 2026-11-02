#!/bin/sh
# Cloud image entrypoint (Dockerfile): the data volume mounts root-owned,
# so take ownership once as root, then run the server as the unprivileged
# node user — Chromium and agent-written pages never run as root.
set -e
mkdir -p "${LH_DATA_DIR:-/data}"
chown node:node "${LH_DATA_DIR:-/data}"
chmod 700 "${LH_DATA_DIR:-/data}"
exec setpriv --reuid=node --regid=node --init-groups "$@"
