# `madarch repo add` connects only an explicitly selected checkout

Change: repo-add-checkout
Base: 9bb85e5ae2c98c88ef33c1a0acdcea2adf3c90e7
Tasks: madarch-74k4.1.2
Kind: behavior

## Intent
An engineer working in a product can connect a code checkout they explicitly name with `--source`, or the distinct Git checkout from which they run the command, without moving it by default or writing madarch files into it. `madarch repo add library https://example.invalid/library.git --source ./checkout` asks how to connect that checkout when run interactively; link is the default, and move or clone are explicit choices. A non-interactive run names the choice with `--mode`. When no local checkout is pointed out by `--source` or the distinct current Git checkout, madarch clones the URL and never searches another folder. The change is the existing-product `repo add` slice; creating a new product from a checkout and discovering a product from a linked checkout are separate leaves.

## Out of scope
- Creating a new product around the current checkout (`madarch init` or equivalent).
- Finding products by scanning the products home for links to a checkout.
- Changing the product manifest's repository fields, the bootstrap command, the wiki, or repository-description behavior.
- Searching any conventional folder for local checkouts.
- The one-time acceptance walk and the Windows clean-install workflow; the acceptance walk belongs to the assembled feature, and the install-workflow change belongs to its own task.

## Changes to requirements
- product-repository/repo-add (added): `repo add` accepts a supplied local source path or the distinct current Git checkout and a connection mode. It uses the remote URL for future clones, links by default interactively, offers move and clone, requires `--mode` for a non-interactive local-source run, and clones without searching when no local checkout is selected. The scenarios pin source preservation, move-state preservation, mode selection, and failure words.

## Rationale
The owner decided that code checkouts have no standard parent folder: a local source is the path the person gives or the checkout they run from, and a URL alone does not authorize a search. The person also chose link by default (symlink; Windows directory junction without administrator rights), move with branch/uncommitted work/stash preserved, or clone; non-interactive agents and CI pass the choice as a flag. The existing manifest requires a remote `url`, so this slice keeps the URL explicit while adding the local source path. Decision 0021 keeps the product-repository format and lifecycle owned by madarch.

## Preserved contracts
- product-repository/manifest: the manifest still declares each code repository by its unique `name`, remote `url` and optional `branch`; no local absolute path is written into it.

## Coverage
- product-repository/repo-add: test
- product-repository/manifest: test

## Blocking questions
None.

## Design and decisions
See `design.md`. The existing lifecycle transaction remains the one operation surface; no new dependency or product-owned path is introduced.
