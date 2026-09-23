#!/bin/sh
# Refuses staged content matching the owner's private patterns. The pattern list
# is .git/info/private-patterns: it stays out of the repository, because
# publishing it would publish what it protects.
PATTERNS="$(git rev-parse --git-dir)/info/private-patterns"
[ -f "$PATTERNS" ] || exit 0
grep -v '^#' "$PATTERNS" | grep -v '^$' > "${TMPDIR:-/tmp}/madarch-private.$$" || { rm -f "${TMPDIR:-/tmp}/madarch-private.$$"; exit 0; }
hits=$(git diff --cached --no-color --unified=0 --diff-filter=ACMR | grep '^+' | grep -v '^+++' | grep -n -i -E -f "${TMPDIR:-/tmp}/madarch-private.$$")
names=$(git diff --cached --name-only --diff-filter=ACMR | grep -i -E -f "${TMPDIR:-/tmp}/madarch-private.$$")
rm -f "${TMPDIR:-/tmp}/madarch-private.$$"
if [ -n "$hits$names" ]; then
  echo "Commit refused: staged content matches a private pattern (.git/info/private-patterns)."
  echo "This repository is public. Remove the personal detail and stage again."
  exit 1
fi
exit 0
