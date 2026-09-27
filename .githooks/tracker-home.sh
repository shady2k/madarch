#!/bin/sh
# Tracker home guard (see .shady2k/integration.md, "Tracker layout"): br in this
# checkout must write this checkout's own database and export. br finds the
# database by walking up, so a git worktree without its own database writes the
# main checkout's tracker, and each checkout's export then carries the other's
# states. `sh .shady2k/connect.sh` gives a checkout its own.
top="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "tracker-home: not inside a clone of the repository."; exit 2; }
connect="Run sh .shady2k/connect.sh in this checkout ($top), then commit again."
command -v br >/dev/null 2>&1 || { echo "tracker-home: br (beads_rust) is not installed, so the tracker this checkout writes cannot be checked. $connect"; exit 2; }
[ -d "$top/.beads" ] || { echo "tracker-home: $top/.beads is missing: this checkout has no tracker export. $connect"; exit 2; }
where="$(cd "$top" && br where 2>/dev/null | head -n 1)"
[ -n "$where" ] && [ -d "$where" ] || { echo "tracker-home: br finds no tracker from $top. $connect"; exit 2; }
if [ "$(cd "$where" && pwd -P)" != "$(cd "$top/.beads" && pwd -P)" ]; then
  echo "Commit refused: br in this checkout writes another checkout's tracker ($where),"
  echo "so tracker changes made here land in that checkout's export, and this one's goes stale."
  echo "$connect It gives this checkout its own tracker database."
  exit 1
fi
exit 0
