# Design: explicit checkout modes for `madarch repo add`

## Drivers and constraints

- The person chooses the source: an explicit path, never a search in a presumed parent folder. A URL-only call is an explicit request to clone.
- Link is the default because the existing checkout must remain in place. Move and clone remain explicit alternatives.
- A link must not write to the code checkout. A move must carry its Git metadata and dirty state. The product manifest stores only a remote URL, never a machine-local source path.
- Interactive use asks the person; agents and CI must provide `--mode` rather than block on a prompt.
- The system already has one lifecycle operation module (`src/product/lifecycle.ts`) and a CLI parser (`src/product/cli.ts`). The manifest has one repository entry shape: name, URL, optional branch.

## Options considered

1. **Extend the existing lifecycle transaction and CLI surface.** `repoAddLife` validates the product and source, carries out the selected connection operation, and updates the manifest. The CLI resolves the interactive choice or validates the explicit mode. The command remains the single surface.
2. **Add a separate repository-connector service.** A new module owns link/move/clone state and is called from the lifecycle wrapper. This creates a second owner and boundary for one command's transaction, and duplicates the existing lifecycle module's role.

## Decision

Option 1. The repository lifecycle is already implemented in `src/product/lifecycle.ts`; adding the modes there keeps the command's decision and rollback in one place. The CLI adds `--source` and `--mode`; an interactive local-source run prompts with link first/default, while a non-interactive local-source run without `--mode` refuses before mutation. When neither `--source` nor a distinct current checkout is selected, the command clones and does no local discovery. A supplied `--source` path is resolved to its Git top level; without that flag, the command uses the Git checkout it runs from only when that checkout differs from the selected product. It never searches another folder. Link uses a symlink on POSIX and a directory junction on Windows. Clone completes before the manifest is committed. Link or move also prepares the target before the manifest commit. The manifest update writes a complete temporary file beside `workspace.yaml` and atomically renames it into place, so a failed write never exposes partial YAML. If staging or committing fails, reset the product index and atomically restore the previous manifest before rolling back the prepared target or restoring a moved source. If restoring the old manifest itself fails, do not remove the prepared target: leave a complete manifest entry matched to its checkout and report both exact paths and the recovery error. No failure is reported as though the source were untouched when it was moved.

For a same-filesystem ordinary repository, move uses an atomic rename and can be rolled back by renaming the target back. For a cross-filesystem move, copy the checkout to the product target first. Compare the source and copy's `HEAD`, current branch, staged and unstaged diffs, untracked paths and bytes, and stash list before proceeding. Then atomically rename the source to a sibling backup path on its own filesystem. If the manifest update fails, move the backup back to the original path and remove the product copy. After the manifest commit succeeds, remove the backup. If that cleanup fails, report success with the backup path; do not report a failed move that could imply the source was untouched. A linked worktree (`.git` is a file) uses `git worktree move`; if Git refuses the move, leave it in place and offer link or clone instead. Failure to create a link names the path and alternatives; no partial manifest entry is kept.

## Consequences and risks

- Local absolute paths never enter `workspace.yaml`; a second machine continues to bootstrap from the declared URL.
- The source-preservation behavior is verified with locally created repositories containing a branch, an uncommitted file and a stash. No test or feature walk needs an outside checkout or network.
- Cross-device moves temporarily keep a verified copy and a backup until the manifest commit succeeds; cleanup failures name the backup location and are reported as a successful move with cleanup required.
- A linked-worktree move depends on Git's `worktree move`; refusal leaves the source unchanged, and link or clone remain available.
- The junction choice is unit-tested by selecting the Windows platform branch in the link helper. The separate clean-install workflow's Windows job is not changed by this leaf.
