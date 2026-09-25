#!/bin/sh
# Connects this clone to the project's workflow (see .shady2k/integration.md,
# "Connecting a clone"): the hooks, the tracker export's path filter, the tracker
# database, and every local file a hook reads. Safe to rerun. Everything that
# can be checked is checked before anything changes; git config is written
# last, so a clone whose tracker cannot be imported is left unconnected, never
# half connected. It writes no global git config.
#   sh .shady2k/connect.sh
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "connect: run this inside a clone of the repository."; exit 2; }

missing=""
need() { missing="$missing
  - $1"; }

command -v node >/dev/null 2>&1 || need "node (Node.js 20 or newer): the hooks run the checks with it"
command -v br >/dev/null 2>&1 || need "br (beads_rust): the tracker the hooks read"

PRIVATE="$(git rev-parse --git-path info/private-patterns)"
USER_PRIVATE="${XDG_CONFIG_HOME:-$HOME/.config}/madarch/private-patterns"
for f in "$PRIVATE" "$USER_PRIVATE"; do
  { [ -e "$f" ] || [ -L "$f" ]; } && ! cat "$f" >/dev/null 2>&1 && need "a readable private pattern list: $f exists but cannot be read"
done
patterns=$(cat "$PRIVATE" "$USER_PRIVATE" 2>/dev/null | grep -v '^#' | grep -v '^[[:space:]]*$')
if [ -z "$patterns" ]; then
  need "a private pattern list, one extended regular expression per line (# starts a comment),
    at $USER_PRIVATE (per user, outside the repository; keep it in sync between
    your machines yourself) or at $PRIVATE (this clone only).
    The privacy guard refuses every commit without one: this repository is public."
else
  printf '' | grep -E -e "$patterns" >/dev/null 2>&1
  [ $? -eq 2 ] && need "valid private patterns: one in $USER_PRIVATE or $PRIVATE is not an extended regular expression"
fi

if ! git rev-parse --verify -q refs/heads/main >/dev/null; then
  if git rev-parse --verify -q refs/remotes/origin/main >/dev/null; then
    make_main=1
  else
    need "a local main branch (the document gate's target): fetch origin, then rerun"
  fi
fi

if [ -z "$(git config --get user.email)" ]; then
  need "git user.email: commits are signed with the owner's public email (git config user.email <address>)"
fi

if command -v node >/dev/null 2>&1 && ! node .shady2k/adapter.mjs backlog >/dev/null 2>&1; then
  need "a readable tracker export: node .shady2k/adapter.mjs backlog fails on .beads/issues.jsonl (run it to see why)"
fi

if [ -n "$missing" ]; then
  echo "connect: this clone is not connected; nothing was changed. Missing:$missing"
  exit 1
fi

fail() { echo "connect: $1; the clone is not connected. Fix it and rerun."; exit 1; }

# The tracker database is local; the export is what is committed.
br sync --import-only >/dev/null || fail "br could not import .beads/issues.jsonl (see above)"
# The committed export stores "." for each issue's workspace path; give br this
# clone's. br plans the migration first and applies only that reviewed plan.
plan=$(br sync --migrate-source-repo-path --json) || fail "br could not plan this clone's workspace path (see above)"
if ! echo "$plan" | grep -q '"no_op":true'; then
  sha=$(echo "$plan" | sed -n 's/.*"plan_sha256":"\([0-9a-f]*\)".*/\1/p')
  br sync --migrate-source-repo-path --apply --expect-plan-sha256 "$sha" >/dev/null || fail "br could not set this clone's workspace path (see above)"
fi

if [ -n "$make_main" ]; then
  git branch main origin/main >/dev/null || fail "could not create local main from origin/main"
  echo "connect: created local main from origin/main"
fi
# core.hooksPath goes last: a write that fails part way leaves the hooks off,
# so the clone is plainly unconnected, and a rerun completes it.
git config filter.br-portable-path.clean "node .shady2k/jsonl-clean.mjs" || fail "could not write git config"
git config filter.br-portable-path.smudge cat || fail "could not write git config"
git config filter.br-portable-path.required true || fail "could not write git config"
git config core.hooksPath .githooks || fail "could not write git config"

# Prove what the hooks read works here.
[ "$(git config --get core.hooksPath)" = .githooks ] || fail "core.hooksPath did not take effect"
.githooks/privacy-guard.sh || fail "the privacy guard does not pass on this clone"

echo "connect: this clone is connected (hooks, path filter, tracker, private patterns, main)."
