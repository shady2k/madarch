## Backlog integration

Maintained by `setup-shady2k-skills`. The protocol ships with the skills;
project facts and verified commands live here. Changing choices live only in
the config. No installation state is recorded: the installed checks' versions
are the repository's installation, and each person's plugin and hooks are theirs.

- **Config:** `.shady2k/config.json`; read current values there.
- **Scope:** personal. Hooks run only in the owner's clone; nothing is enforced in CI.
- **Vision, roadmap and charters:** `docs/vision.md` (roadmap as its section),
  `docs/milestones/<milestone>.md`; status comes from the tracker. Vision and the MVP charter (`docs/milestones/mvp.md`) written.
- **Current specifications:** `docs/system/capabilities/<name>.md`, catalogued in
  `docs/system/index.md`. None yet: no accepted behaviour.
- **Changes:** `docs/changes/<change>/change.md` from the skills' template, with
  header lines `Change:` (the directory name), `Base:` (the main-line revision the
  proposal was written against), `Tasks:` and `Kind:`, an optional `## Rationale`
  section, and complete proposed capability files in
  `docs/changes/<change>/capabilities/<capability>.md`. Deltas are never written
  by hand: the document adapter compares each proposal with the capability at
  `Base:`. `## Preserved contracts` and `## Coverage` are `None.` or bullets
  `- <capability>/<requirement>: <reason | check ids>`. Optional `design.md`.
- **Document resources:** the skills' `documents.md` contract and templates; no local overrides.
- **Workflow ownership:** shady2k-skills owns the workflow; br is the only task list.
- **Architecture and explorations:** `docs/system/architecture.md`; `docs/explorations/` only when retention is requested.
- **Glossary and decisions:** `docs/glossary.md`, `docs/decisions/NNNN-<slug>.md` (MADR).
- **Acceptance records:** a comment on the stage (epic) whose first line is
  `accepted:` with base and final revisions, included tasks, criteria, test,
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
- **Cleanup recovery:** none needed at setup (empty tracker). Before any bulk
  edit, snapshot with `node .shady2k/adapter.mjs backlog > <file>` and keep it with the task.

### Checks and execution

- **Backlog adapter:** `node .shady2k/adapter.mjs backlog [--at <git-rev>]`;
  reads `.beads/issues.jsonl` (br rewrites it on every write), or that file at a revision.
- **Rules:** `.shady2k/checks/{check,check-commits,check-docs}.mjs` and
  `document-format.mjs`, verbatim copies of shady2k-skills setup 0.51.0 (rules 0.24.0).
- **Document gate:** `.shady2k/documents.mjs` exports the documents and tracker
  records into `check-docs.mjs`'s contract and runs it; tests in
  `.shady2k/documents.test.mjs` (`node --test .shady2k/*.test.mjs`).
  - `node .shady2k/documents.mjs check --phase <product|feature|acceptance|close> [--change <id>] [--candidate index|worktree|<rev>] [--target <rev>]`;
    defaults: candidate the working tree (`HEAD` for `acceptance`), target the
    local `main`, which must exist and be current (`git branch -f main
    origin/main` from another branch, `git pull` on it); only the phases that read a baseline
    need it. `export` prints the checker's inputs; `revision [--candidate
    <rev>]` prints the revision evidence is recorded against. Exit 0 clean, 1
    refused, 2 unreadable input (never a pass). Settings, policy and
    exemptions are read from the candidate itself, so an uncommitted edit to
    them changes nothing.
  - **Phases:** the commit-msg hook runs `product` on every commit; `feature`
    for each change owning a task of a commit that stages product code
    (anything outside `docs/`, `.shady2k/`, `.beads/`, `.githooks/`, root
    `*.md` and root dotfiles); `close` for the owning change of a staged
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
    staged against `HEAD`), and anything committed with `--no-verify`. The
    pre-commit tooling tests run the working-tree test files, not only the
    staged ones. Root dotfiles (`.gitattributes`, `.env`, …) count as tooling,
    not product code; any other path outside the listed directories counts as
    product code, dot-directories such as `.github/` included.
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
    wins. The revision is `documents.mjs revision`: a digest of the tree
    without `.beads/` and `docs/system/capabilities/`, so recording evidence
    and syncing specs at closure do not stale it. An approval's reference is
    the owner's words from the preflight; its digest covers what the change
    decides (kind, intent, out of scope, deltas, preserves). A refusal prints
    the exact `br comments add` line for each missing record. Editing the
    change record, or anything else outside the tracker and current specs,
    after recording evidence makes a new revision and stales it. Until
    mutation tooling exists (see Mutation checks below), a `mutation` receipt
    is a bounded manual mutation sample, recorded as `passed` with its
    results as the reference; without one, acceptance escalates to the owner
    (`mutationFallback: escalate`), whose decision to accept is recorded as
    `passed` with their words as the reference. A skipped check is never
    recorded as passed.
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
- **Local entry points:** `.githooks/pre-commit` (privacy guard, the tooling's
  tests when tooling is staged, then backlog gate) and `.githooks/commit-msg`
  (commit links, then the document gate).
- **Public repository, privacy:** no personal data and no details of the
  owner's other projects. `.githooks/privacy-guard.sh` refuses staged content
  matching `.git/info/private-patterns`, a list that is never committed. br
  writes an absolute `source_repo_path` into every issue; the git clean filter
  `.shady2k/jsonl-clean.mjs` (declared in `.gitattributes`) commits it as `.`.
  Agent names use the public handle and a neutral machine name
  (`claude-<role>:shady2k@mbp:<branch>#<session>`); claim comments name the
  checkout, never an absolute path. Commits are signed with the owner's public
  email (the one on the GitHub profile; owner decision 2026-09-24, madarch-xh6).
- **Fresh clone:** `git config core.hooksPath .githooks`;
  `git config filter.br-portable-path.clean "node .shady2k/jsonl-clean.mjs"`,
  `git config filter.br-portable-path.smudge cat`,
  `git config filter.br-portable-path.required true`; create
  `.git/info/private-patterns`; `user.email` is the owner's public email; a local `main`
  branch (the document gate's target);
  `br sync --import-only` then `br sync --migrate-source-repo-path --apply` if br reports foreign paths.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) on every push and pull
  request: `bun install --frozen-lockfile`, `bun run check`, `bun test` on
  Linux. It runs the product's checks only; the backlog, commit-link and
  document gates stay in the local hooks (personal scope).
- **Bulk-edit age correction:** `check.mjs --ages-from <before.json> --ages-through <after.json>`
  with adapter snapshots taken before and after the edit.
- **Runtime:** Bun 1.4.2 (`packageManager` in `package.json`), TypeScript 7
  in strict mode.
- **Static checks:** `bun run check` (`tsc --noEmit`). **Related tests:** `bun
  test <file>`. **Full stage checks:** `bun install --frozen-lockfile && bun
  run check && bun test`, plus `bun run schemas` reproducing the committed
  `schema/*.json` (a test fails otherwise).
- **Mutation checks:** StrykerJS 9 with the command runner (`bun test`),
  `coverageAnalysis: off`, run from outside the repository (it is not a
  dependency): a scratch folder with `@stryker-mutator/core@9` and
  `typescript@5` (Stryker needs TypeScript's JS API, which TypeScript 7 lacks),
  a config mutating `src/**/*.ts` except the TypeBox schema files; about two
  minutes for the model code. Message-text and always-populated-fallback
  survivors are equivalent; others are investigated.
- **Reviewer:** another model where available (Codex through its MCP server or
  CLI; available when the server is connected in the session). Fallback: an
  independent same-model reviewer, disclosed in the acceptance record.
- **Parallel execution:** one worker (config `maxWorkers`); separate git
  worktrees when more are allowed; `br update <id> --claim` is atomic and
  exclusive (`claim_exclusive: true` in `.beads/config.yaml`).

### Tracker operations

Call br as `br` (in a shell where another `br` function shadows it, `command br`).
Its own reference: `br robot-docs guide`, `br <command> --help`. Pass
`--actor <agent full name>` on every write.

| operation | project implementation |
| --- | --- |
| create | `br create --type <task\|bug\|chore\|epic> --title … --labels mvp,<area> [--parent <epic>] --description …`; an epic states `## Done when` |
| link / unlink | `br dep add <issue> <prerequisite>` (type `blocks`, gating only), `br dep remove`; provenance uses `--type related` or `discovered-from`, which the adapter ignores |
| claim | `br update <id> --claim --actor <agent full name>` (atomic), then a comment with the start time and the checkout name (no absolute path) |
| release | `br update <id> --status open --assignee ""` for unfinished holds only; implemented work keeps its label and record |
| implemented | coordinator: `br update <id> --add-label implemented` and `br comments add <id> 'implemented: {"revision":…,"evidence":…}'` |
| submitted | worker: `br update <id> --add-label submitted --assignee ""` and `br comments add <id> 'submitted: {"revision":…,"evidence":…}'` |
| reopen | `br reopen <id>`, remove `implemented`/`submitted` labels, comment why; reassess dependants |
| close | `br close <id> --reason …` after stage acceptance, or with a cancellation/duplicate reason |
| comment / edit | `br comments add`, `br update` (title, description, parent, labels) |
| defer / undefer | `br defer <id> --until <date>`, `br undefer <id>` |
| milestone / label | labels from the config's `milestoneLabels` and `areaLabels` |
| ready | `br ready --label mvp [--parent <stage>]`, excluding `submitted`/`implemented` labels. br treats only closed prerequisites as satisfied; inside one stage the coordinator also treats an integrated `implemented` prerequisite as satisfied, by reading its record |
| holds | `br list --status in_progress --json` (assignee is the holder) |
| pending integration / acceptance | `br list --label submitted` / `br list --label implemented` |
| children | `br list --all --json` filtered by parent (all statuses) |
| search / show | `br search <words>`, `br show <id>` |
| publish | commit `.beads/issues.jsonl` with the change that caused it; push after checks |

When a skill reports the installation is out of date, run `setup-shady2k-skills`. An explicit
setup invocation rechecks everything even if its recorded version matches.
