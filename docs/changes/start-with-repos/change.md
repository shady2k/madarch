# Engineers join with their existing repositories: rename, remote, repo add, bootstrap and clone on the madarch command

Change: start-with-repos
Base: 58fc5c0a65ad66176173d8049da3d65198e62879
Tasks: madarch-525o.1.1, madarch-525o.2.1
Kind: behavior

## Intent
The owner, 2026-10-11 ~11:30 MSK: engineers must be able tomorrow to create a product repository, connect the repositories they already have, and start work (madarch-525o; the charter's scope decisions record what the milestone's exclusions gave up for this). The bundled product-repository program (vendor/shady2k-skills/0.94.0, decision 0019) already names, remotes, bootstraps and enters repositories; today the madarch command exposes only new, serve and list. After this change a person runs `madarch new`, `madarch rename`, `madarch repo add` for each existing repository, `madarch remote` and git push; a colleague runs `madarch clone` of the product's remote in their own products home, finds the repositories cloned under `repos/`, and opens the product's wiki with `madarch serve`.

Stories:
- As the engineer starting a product, I rename the draft with one command and my id and links survive the rename.
- As the engineer with three existing repositories, `madarch repo add` for each enters them in the manifest and gives me the checkouts at once; a repository I already cloned is named, not touched.
- As the second engineer, `madarch clone` of the product's remote gives me the product, its repositories, and the command that opens its wiki.
- As anyone inside a product folder or one of its checkouts, the lifecycle commands find the product from where I stand; nobody asks me for a path twice.

## Out of scope
The product's naming conversation (outcome 5's naming stays with the skills; the draft is renamed into a name a test or a person chooses directly); several people on one product beyond the first clone; transport beyond git; agents through MCP or an API (madarch-yhy); work launched from the wiki (madarch-mv2).

## Changes to requirements
- product-repository gains `rename`, `remote`, `repo-add`, `bootstrap`, `clone` and `where`: the lifecycle commands on the madarch command, each a thin wrapper over the pinned program with the same refusal words and the exit codes the command's other subcommands map (0 done, 2 refused, 1 failed).
- product-repository/where: how a lifecycle command finds the product when no `--product` is given - the product the working folder stands in, or the parent product of a checkout under its `repos/`.

## Preserved contracts
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test

## Coverage
- product-repository/rename: test, browser-walk
- product-repository/remote: test, browser-walk
- product-repository/repo-add: test, browser-walk
- product-repository/bootstrap: test, browser-walk
- product-repository/clone: test, browser-walk
- product-repository/where: browser-walk
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test

## Blocking questions
None.

## Design and decisions
- Nothing of the lifecycle is written in madarch: every refusal, every name rule, the remote's never-push and the left-alone checkout are the pinned program's, whose messages are printed whole; the declarations beside the pinned release (product.d.mts) carry the five functions' shapes and are written in this repository, never in the vendored file.
- The where resolution is the program's `whereAmI`, asked only when no `--product` is given; a command that finds no product above the working folder refuses with exit 2 and names the folder.
- clone names the product's folder from the url (the `.git` suffix off); the manifest keeps the product's name and id whatever the folder is called. A url that is no product repository is refused with the reader's words and its working copy is removed, the way a refused draft leaves no folder behind.
- The command's own word surface: `repo` takes the verb `add` as its first word (`madarch repo add <name> <url>`); any other verb is refused naming `add`.

## Acceptance evidence
Recorded on the change's tasks: the commands' tests, the mutation sample of the ranges, and the acceptance walk (new, rename, repo add of two public repositories, remote to a bare repository standing in for GitHub, push, and a colleague's clone) recorded in the run report.

## DONE WHEN
In a scratch home: `madarch new`; rename to an example name; `repo add` two real small public repositories; `remote` to a local bare repository standing in for GitHub; push; `madarch clone` of that remote into a second scratch home as the second engineer: both repositories under `repos/`, the wiki serving, and a file saved under `docs/` showing on its page. Nothing under the real products home. The engineer's guide page exists with every command copy-pasteable.
