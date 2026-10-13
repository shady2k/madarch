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


# Every local file a hook reads. A hook that cannot find one refuses the commit
# and names this command; connect says what is missing before it writes anything.
for f in \
  .shady2k/adapter.mjs .shady2k/config.json .shady2k/push.mjs \
  .shady2k/tracker.mjs .shady2k/tracker-sync.mjs .shady2k/tracker-sync.version .shady2k/trackers/br.mjs \
  .shady2k/documents.mjs .shady2k/documents.json .shady2k/document-policy.json \
  .shady2k/checks/check.mjs .shady2k/checks/time-format.mjs \
  .shady2k/checks/check-commits.mjs .shady2k/checks/check-present.mjs \
  .shady2k/checks/check-docs.mjs .shady2k/checks/document-format.mjs \
  .shady2k/checks/check-product.mjs \
  .shady2k/adapter.test.mjs .shady2k/documents.test.mjs .shady2k/hooks.test.mjs \
  .shady2k/push.test.mjs \
  .githooks/privacy-guard.sh .githooks/tracker-home.sh .githooks/pre-commit \
  .githooks/commit-msg .githooks/pre-push .githooks/post-checkout \
  .githooks/post-commit .githooks/post-merge .shady2k/connect.sh; do
  [ -f "$f" ] || need "the files the hooks read: $f is missing from this checkout"
done

if [ -n "$missing" ]; then
  echo "connect: this clone is not connected; nothing was changed. Missing:$missing"
  exit 1
fi

fail() { echo "connect: $1; the clone is not connected. Fix it and rerun."; exit 1; }

# The tracker lives off the branches: one store per machine, a worktree of this
# repository detached at refs/tracker/state, kept in step with origin by the
# tracker-sync service (integration, "Tracker synchronization"). The main
# checkout connects the machine (the store, rebuilt from the ref, and its own
# .beads link); any other checkout only links its .beads to that store.
# A real .beads folder is never overwritten: it is a second tracker.
if [ -e .beads ] && ! [ -L .beads ]; then
  fail "a real .beads folder stands in $PWD: it would be a second tracker. Move it out of the way (its records belong in the store), then rerun"
fi
store="$(node .shady2k/tracker.mjs store)" || fail "the tracker store's entry point (.shady2k/tracker.mjs) does not run"
main_checkout="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
if [ "$PWD" = "$main_checkout" ] || ! [ -d "$store/.beads" ]; then
  # The prefix names a store the first machine makes; a store from the ref keeps its own.
  node .shady2k/tracker.mjs connect --checkout "$PWD" --prefix madarch || fail "tracker-sync could not connect this machine's store (see above)"
else
  (cd "$store" && node "$OLDPWD/.shady2k/trackers/br.mjs" pointer-install --checkout "$OLDPWD") || fail "could not link .beads to the store $store (see above)"
fi
# br's own settings are this machine's, beside the store's database, and the
# set's recipe carries only the state files: a claim is exclusive here
# (br update --claim refuses an item another actor holds).
grep -q '^claim_exclusive: true' "$store/.beads/config.yaml" 2>/dev/null || \
  printf 'claim_exclusive: true\n' >> "$store/.beads/config.yaml" || fail "could not set claim_exclusive in $store/.beads/config.yaml"

if [ -n "$make_main" ]; then
  git branch main origin/main >/dev/null || fail "could not create local main from origin/main"
  echo "connect: created local main from origin/main"
fi
# core.hooksPath goes last: a write that fails part way leaves the hooks off,
# so the clone is plainly unconnected, and a rerun completes it.
git config --unset-all filter.br-portable-path.clean 2>/dev/null
git config --unset-all filter.br-portable-path.smudge 2>/dev/null
git config --unset-all filter.br-portable-path.required 2>/dev/null
git config core.hooksPath .githooks || fail "could not write git config"

# Prove what the hooks read works here.
[ "$(git config --get core.hooksPath)" = .githooks ] || fail "core.hooksPath did not take effect"
.githooks/privacy-guard.sh || fail "the privacy guard does not pass on this clone"
.githooks/tracker-home.sh >/dev/null || fail "this checkout's .beads does not reach the machine's tracker store ($store)"
node .shady2k/adapter.mjs backlog >/dev/null || fail "the tracker does not read through this checkout's .beads (node .shady2k/adapter.mjs backlog)"

echo "connect: this clone is connected (hooks, the machine's tracker store at $store, private patterns, main)."
