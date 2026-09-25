#!/bin/sh
# Refuses staged content matching the owner's private patterns. The patterns
# live outside the repository, because publishing them would publish what they
# protect: per user in ${XDG_CONFIG_HOME:-~/.config}/madarch/private-patterns,
# and per clone in .git/info/private-patterns; both are read. With neither, the
# guard refuses: an unconnected clone must not pass any content silently.
PRIVATE="$(git rev-parse --git-path info/private-patterns)"
USER_PRIVATE="${XDG_CONFIG_HOME:-$HOME/.config}/madarch/private-patterns"
LIST="${TMPDIR:-/tmp}/madarch-private.$$"
cat "$PRIVATE" "$USER_PRIVATE" 2>/dev/null | grep -v '^#' | grep -v '^[[:space:]]*$' > "$LIST"
if [ ! -s "$LIST" ]; then
  rm -f "$LIST"
  echo "Commit refused: no private pattern list, so the privacy guard cannot check this public repository."
  echo "Create $USER_PRIVATE (or $PRIVATE) and connect the clone: sh .shady2k/connect.sh"
  exit 1
fi
# A pattern grep cannot read would match nothing and pass everything: refuse.
printf '' | grep -E -f "$LIST" >/dev/null 2>&1
if [ $? -eq 2 ]; then
  rm -f "$LIST"
  echo "Commit refused: a private pattern is not a valid extended regular expression ($USER_PRIVATE or $PRIVATE)."
  echo "Fix the pattern (grep -E -f <file> names it), then commit again."
  exit 1
fi
hits=$(git diff --cached --no-color --unified=0 --diff-filter=ACMR | grep '^+' | grep -v '^+++' | grep -n -i -E -f "$LIST")
names=$(git diff --cached --name-only --diff-filter=ACMR | grep -i -E -f "$LIST")
rm -f "$LIST"
if [ -n "$hits$names" ]; then
  echo "Commit refused: staged content matches a private pattern ($USER_PRIVATE or $PRIVATE)."
  echo "This repository is public. Remove the personal detail and stage again."
  exit 1
fi
exit 0
