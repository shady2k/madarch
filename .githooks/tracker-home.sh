#!/bin/sh
# Tracker home guard (see .shady2k/integration.md, "Tracker layout"): the tracker
# lives off the branches, in one store per machine, and every checkout reaches it
# through its .beads link. A checkout whose .beads is missing, a real folder, or a
# link to anything else would let br write a second tracker no one else sees.
# `sh .shady2k/connect.sh` points a checkout at the store.
top="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "tracker-home: not inside a clone of the repository."; exit 2; }
connect="Run sh .shady2k/connect.sh in this checkout ($top), then commit again."
command -v br >/dev/null 2>&1 || { echo "tracker-home: br (beads_rust) is not installed, so the tracker this checkout writes cannot be checked. $connect"; exit 2; }
store="$(node "$top/.shady2k/tracker.mjs" store 2>/dev/null)" || { echo "tracker-home: the tracker store's entry point (.shady2k/tracker.mjs) does not run. $connect"; exit 2; }
[ -d "$store/.beads" ] || { echo "tracker-home: this machine has no tracker store at $store. $connect"; exit 2; }
if [ ! -L "$top/.beads" ] || [ "$(cd "$top/.beads" 2>/dev/null && pwd -P)" != "$(cd "$store/.beads" && pwd -P)" ]; then
  echo "Commit refused: this checkout's .beads does not link to the machine's tracker store ($store/.beads),"
  echo "so br here would write a tracker no other checkout or machine reads."
  echo "$connect"
  exit 1
fi
exit 0
