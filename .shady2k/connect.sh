#!/bin/sh
# Connects this clone to the project's workflow (see .shady2k/integration.md,
# "Connecting a clone"): the hooks, the tracker export's path filter, the tracker
# database, and every local file a hook reads. Safe to rerun. It checks
# everything first and changes nothing until every check passes, so it never
# leaves a clone half connected. It writes no global git config.
#   sh .shady2k/connect.sh
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "connect: run this inside a clone of the repository."; exit 2; }

missing=""
need() { missing="$missing
  - $1"; }

command -v node >/dev/null 2>&1 || need "node (Node.js 20 or newer): the hooks run the checks with it"
command -v br >/dev/null 2>&1 || need "br (beads_rust): the tracker the hooks read"

PRIVATE="$(git rev-parse --git-path info/private-patterns)"
USER_PRIVATE="${XDG_CONFIG_HOME:-$HOME/.config}/madarch/private-patterns"
if [ ! -s "$PRIVATE" ] && [ ! -s "$USER_PRIVATE" ]; then
  need "a private pattern list, one extended regular expression per line (# starts a comment),
    at $USER_PRIVATE (per user, outside the repository; keep it in sync between
    your machines yourself) or at $PRIVATE (this clone only).
    The privacy guard refuses every commit without one: this repository is public."
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

if [ -n "$missing" ]; then
  echo "connect: this clone is not connected; nothing was changed. Missing:$missing"
  exit 1
fi

git config core.hooksPath .githooks
git config filter.br-portable-path.clean "node .shady2k/jsonl-clean.mjs"
git config filter.br-portable-path.smudge cat
git config filter.br-portable-path.required true
[ -n "$make_main" ] && git branch main origin/main >/dev/null && echo "connect: created local main from origin/main"

# The tracker database is local; the export is what is committed.
br sync --import-only >/dev/null || { echo "connect: br could not import .beads/issues.jsonl (see above)."; exit 1; }
# The committed export stores "." for each issue's workspace path; give br this
# clone's. br plans the migration first and applies only that reviewed plan.
plan=$(br sync --migrate-source-repo-path --json) || { echo "connect: br could not plan this clone's workspace path (see above)."; exit 1; }
if ! echo "$plan" | grep -q '"no_op":true'; then
  sha=$(echo "$plan" | sed -n 's/.*"plan_sha256":"\([0-9a-f]*\)".*/\1/p')
  br sync --migrate-source-repo-path --apply --expect-plan-sha256 "$sha" >/dev/null || { echo "connect: br could not set this clone's workspace path (see above)."; exit 1; }
fi

# Prove what the hooks read works here.
node .shady2k/adapter.mjs backlog >/dev/null || { echo "connect: the tracker adapter cannot read the export."; exit 1; }
.githooks/privacy-guard.sh || exit 1

echo "connect: this clone is connected (hooks, path filter, tracker, private patterns, main)."
