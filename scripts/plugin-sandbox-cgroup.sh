#!/bin/sh
# A cgroup v2 subtree delegated to the test account, and the command run inside a leaf of it
# (decision 0035, item 9; docs/system/plugin-sandbox.md). The plugin host bounds a plugin's whole
# process tree in a cgroup of its own under one delegated to madarch, and moves that tree in
# before its first instruction; the kernel lets a process move itself between cgroups only inside
# the subtree it owns, so the command that starts the host must stand in a leaf of the delegation.
# A cgroup that hands controllers on may hold no process, which is why the command goes to `run`
# and the plugin's own cgroups stand beside it.
#
#   scripts/plugin-sandbox-cgroup.sh bun test test/plugin-host.test.ts
#
# Run as the test account with sudo at hand, it prepares the subtree with sudo and comes back to
# the account; run as root with MADARCH_SANDBOX_UID, it takes that account. It exports
# MADARCH_PLUGIN_CGROUP and MADARCH_SANDBOX_REQUIRED=1, so a machine that cannot run the sandbox
# cases fails them rather than skipping them. The folder is MADARCH_PLUGIN_CGROUP when set, else
# /sys/fs/cgroup/madarch-test.
set -eu

CGROUP=${MADARCH_PLUGIN_CGROUP:-/sys/fs/cgroup/madarch-test}
LEAF="$CGROUP/run"
SELF=$(readlink -f "$0")

if [ "$(id -u)" -ne 0 ]; then
  exec sudo --preserve-env=HOME,PATH,MADARCH_PLUGIN_CGROUP,MADARCH_QUARANTINE,MADARCH_QUARANTINE_REPORT,GITHUB_STEP_SUMMARY,GITHUB_SHA,GITHUB_RUN_ID,GITHUB_SERVER_URL,GITHUB_REPOSITORY "$SELF" "$@"
fi

TARGET_UID=${SUDO_UID:-${MADARCH_SANDBOX_UID:-0}}
TARGET_GID=${SUDO_GID:-${MADARCH_SANDBOX_GID:-$TARGET_UID}}

mkdir -p "$CGROUP"
if ! printf '+memory +cpu +pids' > "$CGROUP/cgroup.subtree_control" 2>/dev/null; then
  echo "$SELF:1: $CGROUP hands no memory, cpu and pids controller to its children: this machine cannot bound a plugin's tree. See docs/system/plugin-sandbox.md" >&2
  exit 2
fi
mkdir -p "$LEAF"
chown -R "$TARGET_UID:$TARGET_GID" "$CGROUP"

printf '%s' "$$" > "$LEAF/cgroup.procs"
exec setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --init-groups \
  env HOME="${HOME:-/}" PATH="${PATH:-/usr/bin:/bin}" \
  MADARCH_PLUGIN_CGROUP="$CGROUP" MADARCH_SANDBOX_REQUIRED=1 "$@"
