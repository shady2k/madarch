## Backlog integration

Maintained by `setup-shady2k-skills`. The protocol ships with the skills;
project facts and verified commands live here. Changing choices live only in
the config. No installation state is recorded: the installed checks' versions
are the repository's installation, and each person's plugin and hooks are theirs.

- **Config:** `.shady2k/config.json`; read current values there.
- **Scope:** personal. Hooks run only in the owner's clone; nothing is enforced in CI.
- **Vision, roadmap and charters:** `docs/vision.md` (roadmap as its section),
  `docs/milestones/<milestone>.md`; status comes from the tracker. Vision and the MVP charter (`docs/milestones/mvp.md`) written.
- **Current specifications:** `docs/system/capabilities/<name>.md`. None yet: no accepted behaviour.
- **Changes:** `docs/changes/<change>/change.md`, optional `design.md`; short deltas may live on tasks with a spec pointer.
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
- **Document adapter and gate:** not installed yet; task "Wire the document gate" (madarch-9jo).
  Until then documents are checked by reading.
- **Document policy / baseline / evidence level / synchronization / enforcement boundary:**
  defined when the document gate is wired; the planned evidence level is `records`
  (no protected CI), so acceptance records are trusted, not verified.
- **Backlog gate:** `node .shady2k/adapter.mjs backlog > b.json && node .shady2k/checks/check.mjs --config .shady2k/config.json b.json`.
  Strength `block` from the config; no baseline is needed at that strength.
- **JSON report:** the same with `--json`.
- **Commit-link input and check:** `node .shady2k/adapter.mjs commits --message <file>`
  (pending message) or `--range <a>..<b>` (every commit in a range), piped to
  `node .shady2k/checks/check-commits.mjs -`.
- **Local entry points:** `.githooks/pre-commit` (privacy guard, then backlog
  gate) and `.githooks/commit-msg` (commit links).
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
  `.git/info/private-patterns`; `user.email` is the owner's public email;
  `br sync --import-only` then `br sync --migrate-source-repo-path --apply` if br reports foreign paths.
- **CI:** none (personal scope, no product code yet). The walking skeleton
  wires CI; there the backlog baseline is the previous head of a push or the
  PR merge-base, and an empty or unreadable commit range fails.
- **Bulk-edit age correction:** `check.mjs --ages-from <before.json> --ages-through <after.json>`
  with adapter snapshots taken before and after the edit.
- **Static checks / related tests / full stage checks:** none yet; defined by the walking skeleton.
- **Mutation checks:** none yet; until tooling exists, acceptance escalates (config `mutationFallback`).
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
