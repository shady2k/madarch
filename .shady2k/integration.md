## Backlog integration

Maintained by `setup-shady2k-skills`. The protocol ships with the skills;
project facts and verified commands live here. Changing choices live only in
the config. No installation state is recorded: the installed checks' versions
are the repository's installation, and each person's plugin and hooks are theirs.

- **Config:** `.shady2k/config.json`; read current values there.
- **Scope:** personal. Hooks run only in the owner's clone. The backlog,
  commit-link and document gates are enforced nowhere else; the set requires
  the product-documents check in CI whatever the scope, so
  `.github/workflows/documents.yml` runs it on every push.
- **Vision, roadmap and charters:** `docs/vision.md` (roadmap as its section),
  `docs/milestones/<milestone>.md`; status comes from the tracker. Vision and the MVP charter (`docs/milestones/mvp.md`) written.
- **Current specifications:** `docs/system/capabilities/<name>.md`, catalogued in
  `docs/system/index.md`.
- **Changes:** `docs/changes/<change>/change.md` from the skills' template, with
  header lines `Change:` (the directory name), `Base:` (the main-line revision the
  proposal was written against), `Tasks:` and `Kind:`, an optional `## Rationale`
  section, and complete proposed capability files in
  `docs/changes/<change>/capabilities/<capability>.md`. Deltas are never written
  by hand: the document adapter compares each proposal with the capability at
  `Base:`. `## Preserved contracts` and `## Coverage` are `None.` or bullets
  `- <capability>/<requirement>: <reason | check ids>`. Optional `design.md`.
- **Document resources:** the skills' `documents.md` contract and its templates, the product's own document templates included; no local overrides.
- **Workflow ownership:** shady2k-skills owns the workflow; br is the only task list.
- **Architecture and explorations:** `docs/system/architecture.md` (written 2026-09-30; a present document like the others); `docs/explorations/` only when retention is requested.
- **Glossary and decisions:** `docs/glossary.md`, `docs/decisions/NNNN-<slug>.md` (MADR).
- **Retiring a record written wrong:** a `check:` or `approval:` comment
  written wrong (a receipt without its revision, say) is never edited or
  deleted; a comment on the same task whose first line is `void: {"comment":
  <its tracker comment id>, "reason": "<why>"}` retires it, and the document
  gate reads the task as if it were not there. A void without its reason, or
  naming a comment not on its task or one that is not a `check:` or
  `approval:` record, or one written before the record it names, is refused
  (exit 2), never ignored. Time
  records keep their own void, the run script's `void`.
- **Acceptance records:** a comment on the stage (epic) whose first line is
  `accepted: {"base": "<sha>", "final": "<sha>"}` (older records name
  `Final: <sha>` in prose, which the adapter also reads), followed by included tasks, criteria, test,
  mutation and review evidence, and pending limitations.
- **Features and stages:** br type `epic` (a feature, or a stage under it);
  br type `feature` is read as epic too. The coordinator holds the stage.
- **Implemented:** label `implemented` plus a comment whose first line is
  `implemented: {"revision": "<sha>", "evidence": "<checks run>"}`; the adapter
  emits status `implemented`. It is neither ready nor closed.
- **Submitted:** label `submitted` plus a comment whose first line is
  `submitted: {"revision": "<sha or branch>", "evidence": "<local checks>"}`;
  emitted as `submitted`, pending integration, never ready to reimplement.
- **Commit task links:** every commit, merges and reverts included, carries one
  or more lines `Task: <id>[, <id>...]`. Parsed by `taskIds()` in
  `.shady2k/adapter.mjs` (case-insensitive `^Task:` lines, ids split on commas and spaces).
  The adapter also marks a commit that carries only records of what already
  happened (`recordsOnly`, `onlyRecords()`): one whose single changed path is
  `.beads/issues.jsonl`, in which every issue keeps its fields (compared with
  keys sorted, `updated_at` aside) and every comment it had, and adds only
  `[shady2k-time` comments. A changed or dropped comment is not records-only.
  `check-commits.mjs` refuses it: the records ride with the landing they
  describe. Filing, claiming, closing or annotating work is not records-only;
  merges and the root commit are never marked. For the commit being made the
  adapter reads the `git commit` process from `ps` and, when it amends, judges
  the index against `HEAD^`, so records added to a commit that carries code pass.
- **Cleanup recovery:** none needed at setup (empty tracker). Before any bulk
  edit, snapshot with `node .shady2k/adapter.mjs backlog > <file>` and keep it with the task.

### Checks and execution

- **Backlog adapter:** `node .shady2k/adapter.mjs backlog [--at <git-rev>]`;
  reads `.beads/issues.jsonl` through the checkout's link to the machine store
  (br rewrites it on every write), or the store's recording at a revision (see
  "Tracker layout"). Commit task ids resolve against the store as it is now.
- **Rules:** `.shady2k/checks/{check,check-commits,check-docs,check-present,check-product}.mjs`,
  `document-format.mjs` (which `documents.mjs` parses the project's documents
  with and `check-present.mjs` takes its path matcher from; `check-docs.mjs`
  reads the exported model, not files) and `time-format.mjs`
  (which `check.mjs` reads records by),
  verbatim copies of shady2k-skills plugin 0.121.0 (setup and rules 0.51.0),
  compared byte for byte at each setup, with the set's fixtures and templates
  under `.shady2k/checks/`. Their self-tests run from the plugin's
  setup skill directory, where their fixtures are. `check.mjs` carries the
  record rules: a record is retired by a `void` record naming its comment, never
  edited or deleted, and a void that retires nothing only warns
  (`time-void-idle`). Since 0.45.0 `check-docs.mjs` reports a mutation check
  that was not made, or not on the judged revision, as a `not-made` note and
  never refuses on it; `documents.mjs` prints the notes beside its verdict
  (and in `--json`). Since 0.51.0 `check-commits.mjs` reads a standalone
  task's criterion through `check.mjs`, so the three travel together. The
  0.51.0 rules this installation has not switched on, each turned on only by
  the value it reads (owner's profile, 2026-10-21, madarch-y47p): the outcome
  rules (`orphaned-outcome`, `unobservable-first-stage`, `unserved-outcome`)
  and the forecast rules (`unforecast-target`, `unmeasured-forecast`) wait for
  ids on the vision and the charter, which come with the self-filling
  milestone's re-plan; the commit check's code-path rule waits for
  `codePaths` and the commit input it needs (each commit's paths and the
  document gate's verdicts on its change records); the design-match and
  judgement rules wait for the records they read.
- **Present documents:** the config's `presentDocuments` (`AGENTS.md`, the
  glossary, `docs/system/architecture.md`, the current capability specs).
  `node .shady2k/checks/check-present.mjs --config .shady2k/config.json --base
  <rev> [--head <rev>]` runs in the pre-push hook for every pushed ref that
  introduces commits, against the revision just before the first of them (see
  "What a push introduces"); with personal scope and pushes straight to `main`
  there is no pull-request step, so the push stands in for a pull request's
  opening. It refuses a change that leaves one of them naming a path the tree no
  longer has; the list itself is not a reference, so moving or dropping a listed
  document with no other document naming its path is not what it refuses
  (checked 2026-10-09: moving `docs/glossary.md` passed, moving
  `.shady2k/integration.md`, named by `AGENTS.md`, was refused). The `skills`
  ignore names the product-created `skills/` folder in product-repository
  scenarios; it is not a repository-root folder shipped by this engine. It
  does not ignore paths below that folder or moved skill-specific paths. At adoption
  (2026-09-29) it reported no dead references and two areas no present document
  mentions (`examples/`, `scripts/`), filed as debt; read again 2026-10-09 over
  the last twenty commits of `main`, no new dead reference and `examples/` still
  uncovered (that debt is madarch-p1y).
- **Product documents:** `.shady2k/checks/check-product.mjs`, the set's check of
  the product's own documents (sources, hypotheses, user stories, use cases,
  product requirements, open questions, prototypes, results). The commit-msg
  hook runs `node .shady2k/checks/check-product.mjs --staged` on what the commit
  stages, and `.github/workflows/documents.yml` runs
  `node .shady2k/checks/check-product.mjs --rev "${{ github.sha }}"` on every
  push. It needs no config: the forms are the skill set's product documents, and
  the ids under `docs/` are resolved against each other. This repository keeps
  no product document today, so it passes untouched, and until the first one
  exists it returns before it resolves any id: a capability or a change record
  naming a product requirement that does not exist passes, so its green says
  nothing about product documents this repository does not keep. A refusal names
  the file and the line.
- **Work records:** the adapter's `backlog` export carries, on each issue,
  every br comment whose text starts with `[shady2k-time`, raw, as `{id, at,
  author, body}` (br's comment id as a string, its `created_at` and author);
  other comments stay out. The run script reads that export:
  `node .shady2k/adapter.mjs backlog | node <skills>/take-task/runs.mjs <command> --backlog - ...`,
  always with `--agent <agent full name>` (the script otherwise names this
  machine's real host name, which this public repository must not carry).
  A record is posted exactly as printed: write the `body` of the script's
  `--json` output to a file and `br comments add <id> --file <file> --actor
  <agent> --author <agent>`; never retype, reflow or edit it. A tracker appends
  only, so a record that is damaged, wrong or not to count is never edited or
  deleted either: the run script's `void --comment <comment id>` prints the void
  record, posted the same way, and every reader then acts as if the voided
  record were not there. `timeRecordsExempt` is empty: at adoption (2026-09-27)
  no work was active, submitted or implemented.
- **Tracker layout:** off the branches since 2026-10-13 (the owner's choice;
  madarch-tjum, shady2k-skills 0.107.0). No branch carries `.beads/`: it is in
  `.gitignore`, and each checkout's `.beads` is a link to the machine's one
  store, `${XDG_STATE_HOME:-~/.local/state}/madarch/tracker`, a worktree of this
  repository detached at `refs/tracker/state` (a ref no branch contains, pushed
  to origin). br's database there is this machine's own, rebuilt from the
  state files on the ref; only `.beads/issues.jsonl` and `.beads/beads.base.jsonl`
  travel; br's `config.yaml` is the machine's too, and connect keeps
  `claim_exclusive: true` in it. Every checkout, a herdr worktree anywhere included, reaches the same
  store through its link: `.shady2k/tracker.mjs` names the store for all of
  them, since the set's mechanism alone would name it after the checkout's
  folder. `.githooks/tracker-home.sh` (pre-commit) refuses a commit from a
  checkout whose `.beads` is missing, a real folder or a link elsewhere;
  `.githooks/post-checkout` links a new worktree at once. Never run `br init`
  in a checkout, and never let a real `.beads` folder stand in one: it is a
  second tracker. The tracker at a code revision is the store's recording under
  that revision's full name (`.githooks/post-commit` and `post-merge` record
  each revision cut or landed; `node .shady2k/adapter.mjs backlog --at <rev>`
  reads it, refusing a revision never recorded); revisions of the in-tree era
  (up to 40ce61f1, recorded at the move from its own tree) read their own
  committed export. Tracker writes need no commit: the service publishes them,
  and a commit carries code and documents only.
- **Tracker synchronization:** the set's mechanism, copied byte for byte from
  shady2k-skills 0.121.0 (setup 0.51.0, madarch-y47p): `.shady2k/tracker-sync.mjs`
  (version in `.shady2k/tracker-sync.version`; `node .shady2k/tracker.mjs status
  --expect-version <the set's version>` says when the copy is behind), the br
  recipe `.shady2k/trackers/br.mjs`, the unit template
  `.shady2k/supervisors/systemd-user/tracker-sync.service`; run only through
  `node .shady2k/tracker.mjs <command>` (connect, publish, sync, claim,
  transition, record, relink, export, status, watch). The hooks folder is the
  repository's own (`core.hooksPath` is `.githooks`), so the mechanism writes
  nothing there: each hook it needs carries its marker line itself, with a
  command that names no machine's path (`tracker.mjs` resolves the store) —
  `post-commit` and `post-merge` record the revision, `post-checkout` relinks
  a checkout a pre-move branch left a folder in. Connect refuses, naming the
  line, a hook that lacks its marker. Supervisor: the user
  unit `~/.config/systemd/user/madarch-tracker-sync.service` (this machine's,
  not committed) runs `tracker.mjs watch --interval 10 --debounce 2 --max-age 5`:
  a write is published after 2 s of quiet or 5 s at most (measured at setup:
  3.9 s), the other machines' state is merged per item every 10 s, a push is
  killed after 10 s and a fetch after 20 s and reported as unreachable. The
  unit survives logout and reboot only with the user's linger on
  (`loginctl enable-linger <user>`, a privileged command; on NixOS
  `users.users.<user>.linger = true`). The owner decided on 2026-10-13 not to
  turn linger on ("Не нужен"): the service starts with the user's first login
  session and stops with the last; while it is down, writes stay in this
  machine's store and are published when it runs again. A push to the ref starts no code CI (a
  workflow's push event is a branch or a tag; the run list after the first
  pushes showed none). The residual the set accepts: two machines claiming one
  item in the same seconds can both believe they hold it until the next sync.
- **Document gate:** `.shady2k/documents.mjs` exports the documents and tracker
  records into `check-docs.mjs`'s contract and runs it; tests in
  `.shady2k/documents.test.mjs` (`node --test .shady2k/*.test.mjs`).
  - **Where it is seen** (setup 0.51.0): a change record's section
    `## Where it is seen`, before `## Blocking questions`, is exported as
    `whereSeen`. Field lines first — `Kind:` (`screen`, `command`, `request`,
    `log` or `internal`), `Place:` (where a person reaches the change),
    `Mockup:` for a screen (an image, an HTML file or a `docs/prototypes/`
    document in the tree), `Reason:` for internal (why nothing a person
    reaches changes) — then the steps a person follows as a numbered or
    bulleted list; an indented line continues the line above. A line it
    cannot place is an error. A record without the section is refused as
    `missing-observation` in the feature, acceptance and close phases, and
    the refusal prints the form; for a screen change the wrapper exports the
    tree's non-empty mockup files as `mockups` (rule `missing-mockup`). The
    approval digest does not cover the section. The change records live at
    the update (32 with open work) gain the section at their next gate run,
    not in bulk (owner's profile, 2026-10-21).
  - `node .shady2k/documents.mjs check --phase <product|feature|acceptance|close> [--change <id>] [--candidate index|worktree|<rev>] [--target <rev>]`;
    defaults: candidate the working tree (`HEAD` for `acceptance`), target the
    local `main`, which must exist and be current (`git branch -f main
    origin/main` from another branch, `git pull` on it); only the phases that read a baseline
    need it. `export` prints the checker's inputs; `revision [--candidate
    <rev>]` prints the revision evidence is recorded against. Exit 0 clean, 1
    refused, 2 unreadable input (never a pass). Settings, policy and
    exemptions are read from the same tree as the thing being judged: the index
    in the commit hook, the working tree for `check` with no `--candidate` (a
    revision otherwise, `HEAD` for `acceptance`). A working-tree edit therefore
    cannot weaken the verdict on what a commit or a revision holds, and it does
    take effect when the working tree is the candidate.
  - **Phases:** the commit-msg hook runs `product` on every commit; `feature`
    for each change owning a task of a commit that stages product code
    (anything outside `docs/`, `.shady2k/`, `.beads/`, `.githooks/`,
    `.github/workflows/`, root `*.md` and root dotfiles); `close` for the owning change of a staged
    `docs/system/capabilities/` file, which is refused if no change linked by
    the commit proposes that capability. A supporting change may not carry
    product code, and only `<capability>.md` files may live in
    `docs/system/capabilities/`. `acceptance` is run by `take-task` at stage
    acceptance as `check --phase acceptance --change <id>`. At closure,
    `close-out` writes the proposed capabilities into
    `docs/system/capabilities/` and commits them (the hook runs `close`)
    **before** `br close` of any of the change's tasks; nothing else stops a
    closure that skipped it. A closed change is history: later work on the
    same capability is a new change with a new `Base:`.
  - **What the hooks do not see:** `commit --amend` of an already committed
    product change, rebases and cherry-picks (commit-msg judges only what is
    staged against `HEAD`; the pre-push hook catches their task links, not their
    documents), and anything committed or pushed with `--no-verify`. The
    pre-commit tooling tests run the working-tree test files, not only the
    staged ones. Root dotfiles (`.gitattributes`, `.env`, …) count as tooling,
    not product code; `.github/workflows/` is the workflow's own tooling (owner decision
    2026-09-27: CI decides which checks run and cannot change what the product
    does); any other path outside the listed directories counts as product
    code, other dot-directories such as the rest of `.github/` included.
  - **Policy:** `.shady2k/document-policy.json`. Behavior and no-behavior
    changes owe `static`, `test`, `mutation` and `review`, plus the checks their
    coverage names; supporting changes owe `review`, and the tooling's own
    tests run in pre-commit whenever `.shady2k/` or `.githooks/` is staged. The
    commands behind `static` and `test` are in "Checks and execution" below. Approval is required for behavior changes only
    (`approvalFor` in `.shady2k/documents.json`).
  - **Evidence level: records.** There is no protected CI, so evidence is
    trusted, not verified. It lives in tracker comments on the change's tasks,
    first line `check: {"id","status","reference","revision"}` or
    `approval: {"changeDigest","reference"}`; the latest receipt per check
    wins. The revision is `documents.mjs revision` (see Evidence revision
    below). An approval's reference is
    the owner's words from the preflight; its digest covers what the change
    decides (kind, intent, out of scope, deltas, preserves). A refusal prints
    the exact `br comments add` line for each missing record. Editing
    anything outside the paths the revision leaves out (the tracker export, the
    change records, the current specs and their catalogue) after recording
    evidence makes a new revision and stales it. An approval's digest covers what
    the change decides — its kind, intent, out of scope, deltas and preserved
    contracts (`documents.mjs` builds it from exactly those) — so editing one of
    those stales the approval, while an edit elsewhere in the change record (its
    title, its task list, its rationale, its coverage) does not. Until
    mutation tooling exists (see Mutation checks below), a `mutation` receipt
    is a bounded manual mutation sample, recorded as `passed` with its
    results as the reference; without one, acceptance escalates to the owner
    (`mutationFallback: escalate`), whose decision to accept is recorded as
    `passed` with their words as the reference. A skipped check is never
    recorded as passed.
  - **Evidence revision:** `documents.mjs revision` (default `--candidate
    HEAD`; `--candidate worktree` hashes the working tree, so an uncommitted
    edit moves only that) hashes the whole tree
    except what the gate reads and verifies itself on every run: `.beads/`
    (the tracker export), `docs/changes/` (the change records),
    `docs/system/capabilities/` (the current specs) and `docs/system/index.md`
    (their catalogue). Nothing else is left out, so filing a task, editing the
    change record or syncing specs at closure does not stale evidence, while
    any other edit does.
  - **A receipt stands for what its check reads:** a policy entry's `ignores`
    names paths its command cannot read. Only `static` has one, `docs/`, and it
    is true: `tsc` reads `src` and `test` (`tsconfig.json`'s `include`) and no
    document. `test` and `mutation` ignore nothing, because the suite reads a
    document: `test/scenarios.test.ts:872` reads `docs/glossary.md` and asserts
    its content, so `bun test`, and a Stryker run whose test file is that one,
    can change verdict with it. This corrects the earlier claim that `bun test`
    and Stryker read no document under `docs/` (the independent review of the
    0.41.0 run, 2026-10-09, checked the pin: editing `docs/glossary.md` left the
    recorded `test` receipt standing). Receipts of a check with an `ignores`
    entry are recorded against `documents.mjs revision --check <id>` (`check:…`,
    `checkRevision` over the tree with the same exclusions plus the paths that
    check cannot read), exported as `checkRevisions`; `review`, coverage-named
    checks and the checks without `ignores` use the whole revision (`content:…`).
    An edit under `docs/`, outside the shared exclusions above, therefore
    leaves `static`'s receipt standing and stales the others; an edit under
    `.beads/`, `docs/changes/`, `docs/system/capabilities/` or
    `docs/system/index.md` leaves every check revision unchanged; any other edit
    stales all. The list only grows where a command is shown not to read a path;
    changing it stales every receipt.
  - **What a commit owes:** the wrapper judges each commit as it is made, not a
    range: a change is asked for only when the commit stages product code or a
    current spec. A commit that touches only the tracker (filing, commenting,
    editing fields) owes no change. Tracker transitions that claim a result
    (`submitted`, `implemented`, `closed`) are not judged by the hooks; see
    the enforcement boundary.
  - **Baseline and synchronization:** the baseline is read from the target
    (`main`), deltas from the change's pinned `Base:`, so a requirement moved
    on the target since is refused as stale rather than reverted. Current specs
    equal the baseline until closure and the replayed change at closure.
  - **Adoption and exemptions:** adopted 2026-09-24 with no work in flight;
    `exempt.tasks` in `.shady2k/documents.json` is empty, and a task listed
    there exempts its descendants. What it costs: documents-only and tooling
    commits pay nothing beyond a complete vision and charter (tooling commits
    also run the tooling tests, a few seconds). The first behavior change
    (the foundation, madarch-ozp) additionally writes its change record and
    complete proposed capability files, takes the owner's approval in its
    preflight, and records its check receipts: roughly an hour of agent work
    on top of the feature, planned in its preflight rather than met at a push.
    Tooling scripts live under `.shady2k/` to stay tooling; a script at the
    root is product code.
  - **Enforcement boundary:** local hooks are feedback, not a security
    boundary: `git commit --no-verify` bypasses them, and nothing checks
    tracker closures. A refusal is owed work whoever could walk past it, and a
    check nobody else enforces is one to hold to harder, not more lightly.
- **Backlog gate:** `node .shady2k/adapter.mjs backlog > b.json && node .shady2k/checks/check.mjs --config .shady2k/config.json b.json`.
  Strength `block` from the config; no baseline is needed at that strength.
- **JSON report:** the same with `--json`.
- **Commit-link input and check:** `node .shady2k/adapter.mjs commits --message <file>`
  (pending message) or `--range <a>..<b>` (every commit in a range), piped to
  `node .shady2k/checks/check-commits.mjs -`.
- **Product repository:** none. This repository is neither a product repository
  nor a code repository under a product's `repos/`. The program is run from this
  repository, `node <setup skill directory>/product.mjs where`, and prints
  `where: none` (checked 2026-10-09 in the 0.41.0 run); started anywhere else,
  or given a folder, it answers about that folder instead. The set's
  product-repository layout (`workspace.yaml`, `repos/`) is therefore not
  installed here, and `docs/` is this repository's own.
- **Task ids of this repository's commits resolve against:** this repository's
  own tracker, `.beads/issues.jsonl` (the adapter's `commits` operation reads
  the working tree, `push.mjs` the export at the pushed tip). There is no
  product repository above it to resolve them against.
- **Local entry points:** `.githooks/post-checkout` (connects a new
  worktree's tracker), `.githooks/pre-commit` (privacy guard, tracker home
  guard, the tooling's tests when tooling is staged, then backlog gate), `.githooks/commit-msg`
  (commit links, then the product-documents check on the staged tree, then the
  document gate) and `.githooks/pre-push`
  (`.shady2k/push.mjs`: commit links of every introduced commit, then the
  present-documents check).
- **What a push introduces:** for each pushed ref, the commits of its tip (a
  tag peeled to its commit) that neither the remote's head for that ref nor
  any `refs/remotes/<remote>/*` reaches (`git rev-list <tip> --not
  --remotes=<remote> [<remote sha>]`), with their links resolved against the
  tracker export at the tip. A ref that introduces none (a tag or a new branch
  on a commit the remote holds) prints "introduces no commits: nothing to
  check" and passes; a deletion passes. Refused as unreadable (exit 2): no ref
  lines, a malformed line, a tip that is no commit, a remote head this clone
  does not have (fetch first). The document gate judges each commit as it is
  made and has no range mode, so the push does not judge it again, and the
  backlog gate at `block` strength needs no baseline. The checks start without
  git's repository variables (`GIT_DIR` and the rest, which git exports to a
  linked worktree's hooks): under an inherited `GIT_DIR`, `check-present.mjs`'s
  scratch `git init` reinitialised the shared repository as bare (madarch-ry5). Tests:
  `.shady2k/push.test.mjs`, through real pushes to a scratch remote.
- **Connecting a clone:** `sh .shady2k/connect.sh`. It checks first and changes
  nothing unless every check passes: node and br present, a valid private
  pattern list, a local `main` (created from `origin/main` when only that
  exists), a `user.email`, every file a hook reads, and no real `.beads` folder
  in the checkout (a second tracker, refused and left alone). Then, in the main
  checkout or on a machine with no store yet, it connects the machine
  (`tracker.mjs connect`: the store from `refs/tracker/state`, its database
  rebuilt from the ref, this machine's ordinal, the checkout's `.beads` link);
  in any other checkout it only links `.beads` to the store. Only then does it
  write `core.hooksPath` (and drop the old `br-portable-path` filter), and it
  proves the privacy guard, the tracker home guard and a tracker read pass.
  The supervisor is not started by it: the user unit is this machine's, agreed
  with the owner (see "Tracker synchronization"). Safe to rerun; it writes no
  global git config. Tests: `.shady2k/hooks.test.mjs`.
- **Public repository, privacy:** no personal data and no details of the
  owner's other projects. `.githooks/privacy-guard.sh` refuses staged content
  matching the private pattern lists, never committed: per user at
  `${XDG_CONFIG_HOME:-~/.config}/madarch/private-patterns` (the owner keeps it
  in sync between machines) and per clone at `.git/info/private-patterns`;
  both are read. With neither, it refuses every commit and names the connect
  command. br
  writes an absolute `source_repo_path` into every issue; the git clean filter
  `.shady2k/jsonl-clean.mjs` (declared in `.gitattributes`) commits it as `.`.
  Agent names use the public handle and a neutral machine name
  (`claude-<role>:shady2k@mbp:<branch>#<session>`); claim comments name the
  checkout, never an absolute path. Commits are signed with the owner's public
  email (the one on the GitHub profile; owner decision 2026-09-24, madarch-xh6).
- **Fresh clone:** create the private pattern list, set `user.email` to the
  owner's public email, then run `sh .shady2k/connect.sh`.
- **CI:** GitHub Actions on every push of any branch, once (a pull request from
  this repository shows its branch's push run; `[skip ci]` in the pushed
  commit's message skips unfinished work). `.github/workflows/ci.yml` runs the
  root suite in five `bun test --shard=i/5` jobs balanced by
  `.github/workflows/test-timings.json`; refresh the timings with
  `bun test test/ --timings=.github/workflows/test-timings.json --update-timings`.
  The stable `test` job is green only when all five shards, the separate checks
  job and the union-of-test-files check pass. The checks job keeps
  `bun install --frozen-lockfile`, `bun run check`, the PostgreSQL service and
  test, `bun run views:check`, `bun run contract:check`, and the wiki app's own
  install, checks, tests and build. Workflow changes run CI so the workflow
  judging the branch is itself tested. Changes touching only `docs/`, `.beads/`,
  `.shady2k/`, `.githooks/` or root `*.md` files run nothing there
  (`paths-ignore`). `.github/workflows/documents.yml` runs the product-documents
  check on every push whatever the paths, about 15 seconds, as the set requires
  it in CI whatever the project's scope. In personal scope the backlog,
  commit-link and document gates stay in the local hooks only; the
  product-documents check is the one that runs both.
- **Bulk-edit age correction:** `check.mjs --ages-from <before.json> --ages-through <after.json>`
  with adapter snapshots taken before and after the edit.
- **Runtime:** Bun 1.4.2 (`packageManager` in `package.json`), TypeScript 7
  in strict mode.
- **Static checks:** `bun run check` (`tsc --noEmit`). **Related tests:** `bun
  test <file>`. **Full stage checks:** `bun install --frozen-lockfile && bun
  run check && bun test && bun run views:check` (Mermaid's parser and
  `likec4 validate` on the reference system's views, also in CI), plus `bun
  run schemas` and `bun run views` reproducing the committed `schema/*.json`
  and `examples/reference-system/views/` (tests fail otherwise). The wiki
  app's own checks run inside `wiki/app`: `bun install --frozen-lockfile &&
  bun run check && bun test && bun run build`.
- **Mutation checks:** StrykerJS 9 with the command runner (`bun test`),
  `coverageAnalysis: off`, run from outside the repository (it is not a
  dependency): a scratch folder with `@stryker-mutator/core@9` and
  `typescript@5` (Stryker needs TypeScript's JS API, which TypeScript 7 lacks),
  a config mutating `src/**/*.ts` except the TypeBox schema files; about two
  minutes for the model code. Message-text and always-populated-fallback
  survivors are equivalent; others are investigated.
- **Jev:** consent given 2026-09-29 (owner, madarch-u2g), route OpenRouter;
  tracker ids (`madarch-…`) are masked by the config's `jev.idPattern`; answers
  are taken at `jev.sure` (0.9) on `jev.model` (jev-1.13), both moved with
  `jev.mjs replay` on this project's own history. Nothing is copied into this
  repository: `node <skills>/setup-shady2k-skills/jev.mjs status|ask|mask`, or
  the harness's own `jev` tool where it has one. The key's place is this
  machine's, in `~/.config/shady2k-skills/jev.json`, never the config; a
  machine without it works without Jev.
- **Reviewer:** gpt-6-luna through the Prime Agent CLI, the way:
  `prime-agent --provider openai-codex --model gpt-6-luna -p "<the review brief>"`
  run in the checkout under review (proved by one real call at the 0.45.0
  setup, 2026-10-13); gpt-6.1-sol the same way once its limit lifts, by the
  owner's choice. A way that stops answering is repaired with the owner told,
  never silently replaced. 2026-10-21 (setup 0.51.0, madarch-y47p): the
  `openai-codex` way refused with no key for that provider; the review ran on
  gpt-6.1-sol through the owner's gateway, `prime-agent --provider
  shady2k-gateway --model gpt-6.1-sol -p "<the review brief>"` (proved by that
  review), and the owner was told. Fallback: an independent same-model reviewer,
  disclosed in the acceptance record.
- **Pushes to the owner:** `notifyPushes` is on (owner's yes, 2026-10-13); the
  channel is this machine's, `~/.config/shady2k-skills/notify.json` naming the
  owner's Bark script, sent through the run script's `notify --config
  .shady2k/config.json`. No key is in the repository.
- **Practices:** `docs/practices/PRA-<n>-<slug>.md` from the set's practice
  template, each with one line in `AGENTS.md`; none recorded yet
  (`refine-practices` writes them).
- **Parallel execution:** one worker (config `maxWorkers`); separate git
  worktrees when more are allowed; `br update <id> --claim` is atomic and
  exclusive (`claim_exclusive: true` in `.beads/config.yaml`).

### Tracker operations

Call br as `br` (in a shell where another `br` function shadows it, `command br`).
Its own reference: `br robot-docs guide`, `br <command> --help`. Pass
`--actor <agent full name>` on every write.

| operation | project implementation |
| --- | --- |
| create | `br create --type <task\|bug\|chore\|epic> --title … --labels <current milestone>,<area> [--parent <epic>] --description …`, both labels taken from the config (`currentMilestone` and one of `areaLabels`); an epic states `## Done when` |
| link / unlink | `br dep add <issue> <prerequisite>` (type `blocks`, gating only), `br dep remove`; provenance uses `--type related` or `discovered-from`, which the adapter ignores. br refuses an edge that would close a cycle (`Cycle detected in dependencies`), so the `dependency-cycle` rule guards an export that already holds one |
| claim | `node .shady2k/adapter.mjs claim <id> --actor <agent full name>`, then the run script's claim record posted on the item (see Work records). It claims only an open, unheld leaf, and judges each open blocker: an `implemented` prerequisite in the same stage passes once its recorded revision is an ancestor of `HEAD`; one in an earlier stage of the same feature passes once that stage is accepted (the adapter exports the final revision of its latest `accepted:` record as `acceptance`) and that revision is an ancestor of `HEAD`, though the stage stays open until the feature lands; one in another feature must be closed; any other open one refuses with its reason. br's `--claim` stays atomic and exclusive (forced past br's own blocker check only in those cases), the blockers are judged again right after the claim, which is released if one no longer passes and it is still this actor's, and the edge is kept. Known limit: br has no release-if-mine, so a release racing another actor's claim in the moment between the check and the release could clear it; with one worker this does not arise |
| release | `br update <id> --status open --assignee ""` for unfinished holds only; implemented work keeps its label and record |
| implemented | coordinator: `br update <id> --add-label implemented` and `br comments add <id> 'implemented: {"revision":…,"evidence":…}'` |
| submitted | worker: `br update <id> --add-label submitted --assignee ""` and `br comments add <id> 'submitted: {"revision":…,"evidence":…}'` |
| reopen | `br reopen <id>`, remove `implemented`/`submitted` labels, comment why; reassess dependants |
| close | `br close <id> --reason …` after stage acceptance, or with a cancellation/duplicate reason |
| comment / edit | `br comments add`, `br update` (title, description, parent, labels); a work record posted exactly as the run script printed it (`--file`), never reflowed, edited or deleted, and a wrong one retired by the run script's `void`, posted the same way |
| defer / undefer | `br defer <id> --until <date>`, `br undefer <id>` |
| milestone / label | labels from the config's `milestoneLabels` and `areaLabels` |
| ready | `br ready --label <current milestone> [--parent <stage>]`, then drop the items labelled `submitted` or `implemented` and the containers: br's own ready lists both (checked 2026-10-09, br 0.7.0). br treats only closed prerequisites as satisfied; the coordinator also treats as satisfied an integrated `implemented` prerequisite inside one stage, and one in an accepted earlier stage of the same feature whose accepted revision is in the checkout, by the rules of the claim operation, which judges them |
| holds | `br list --status in_progress --json` (assignee is the holder) |
| pending integration / acceptance | `br list --label submitted` / `br list --label implemented` |
| children | `br list --all --json` filtered by parent (all statuses) |
| search / show | `br search <words>`, `br show <id>` |
| publish | commit `.beads/issues.jsonl` with the change that caused it; push after checks |

When a skill reports the installation is out of date, run `setup-shady2k-skills`. An explicit
setup invocation rechecks everything even if its recorded version matches.
