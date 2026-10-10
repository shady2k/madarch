# Create products through the skill set's pinned product-repository program

Change: product-program
Base: 772a25487f88e6e939ecfd14a9a2627c13f76527
Tasks: madarch-4fk
Kind: behavior

## Intent
madarch-rtr built madarch's own draft creation and `madarch new` first, as
the reference the skill set ported. The set has published its
product-repository program (a dependency-free Node library and CLI: new,
read, rename, remote, bootstrap, repo add, where, with its manifest cases and
its example product folder as fixtures). This change pins that program into
madarch, makes `madarch new` a thin wrapper over it, removes madarch's own
creation code, and keeps madarch's manifest reading, serving and listing on
the same pinned reader, so a folder the set made, a draft madarch made and a
folder written by hand are read and served alike (decision 0019: the product
repository's lifecycle is the set's; madarch is the server and its wiki).

What a user can do that they could not before: `madarch list` names the
products the products home holds, whoever made them. Everything else reads
and behaves as before, except where the pinned program's constitution and
refusal words differ (listed in the report of the run).

## Out of scope
- The set's other commands as madarch commands: `madarch rename`, a remote
  and `bootstrap` stay the set's program and the work of outcome 5
  (madarch-mni), which may wrap them thinly; this change adds none.
- The product's documents, their forms and their check: the set's
  (decision 0019), arriving with madarch-fe1.
- The model's pages in the served app, writing from the wiki, MCP and REST
  (the standing out-of-scope list of draft-product).
- Upgrading the pinned release after this pin, or a mechanism that watches
  upstream: the pin is checked against the recorded upstream tree, nothing
  more.

## Rationale
Decision 0019 (2026-10-09): "the product repository's lifecycle is the set's
too ... madarch bundles a pinned release of that program, so `madarch new`
stays a front door for a person without an agent, and it serves and lists any
folder with a valid `workspace.yaml`, whoever made it. One owner of the
structure, more than one way in, like a project creator and its runtime."
The set published the program in shady2k-skills plugin 0.90.0 and completed
it with `repo add` and `where` in 0.91.0; the release this change pins is
0.94.0, the newest published release, whose program differs from the 0.91.0
copy cached on this machine in the version constant alone (fixtures compared
byte for byte before the pin).

## Changes to requirements
- product-repository/draft: the creation runs through the skill set's
  product-repository program, at the release pinned in the checkout; madarch
  keeps its own decisions (the products home, the day a test names) and holds
  no creation code of its own; the skeleton, the manifest text and the
  constitution are the program's, whose markers are the program's
  (`<!-- product:maintained -->`), not madarch's.
- product-repository/manifest: the manifest is read by the pinned program's
  reader, in its words and lines; the plain YAML subset the program enforces
  (no anchors, aliases, tags, flow collections, second documents, duplicate
  fields, tab indents) replaces the looser reading madarch had; the reader
  now reads the `skills` and `repos` fields as the set's manifest declares
  them.
- product-repository/list (new): `madarch list` names the products the
  products home holds, whoever made them.

## Preserved contracts
- product-wiki/pages: unchanged; the wiki's pages are read from the working tree as before, now over the pinned reader.
- product-wiki/live: unchanged; a page still follows its file as it is saved.
- product-wiki/serve: unchanged; serve serves the product of the given or the current folder, opens the browser, and refuses what it refused — a folder that holds no manifest still names it.
- product-wiki/app: unchanged; the app is built once on first use.
- product-wiki/result: unchanged; serve's exits are 2 and 1 as before.
- server/serves-wiki: unchanged; the server's product mode reads the folder read-only as before.
- server/send: unchanged; the send command still runs the check first.
- server/store: unchanged; the graph is still built only from the models sent to the server.
- server/view: unchanged; a view is answered from a sent source's graph.
- server/explains: unchanged; a request that cannot be answered still says why.
- server/sources: unchanged; what the server holds is listed as before.
- server/survives-restart: unchanged; stored histories answer the same after a restart.
- server/identities: unchanged; source ids are unaffected by a product folder.
- server/immutability: unchanged; a resend is judged by its digest as before.
- server/protocol: unchanged; the wire protocol and the version it names are untouched.
- intended-model/schema: unchanged; the intended model's format does not move.
- intended-model/files: unchanged; a product's documents are not the intended model.
- compiled-model/shape: unchanged; no compiled model is read or written by this change.
- model-history/store-version: unchanged; nothing is sent to or stored by the server.
- graph-queries/view: unchanged; no query is asked differently and no engine changes.
- views/view-set: unchanged; the renderer and the view set are untouched.
- model-check/compiles: unchanged; the model check is not run on a product folder.
- model-authoring/skill: unchanged; the skill still writes a code repository's model.
- wiki/pages: unchanged; the static site's pages are built as before.
- wiki/diagrams: unchanged; the static site's diagram tabs stay.
- wiki/engine: unchanged; Zensical and Starlight still build the static site.
- wiki/documents: unchanged; the static site's documents section is untouched.
- wiki/links: unchanged; the static site's link check is untouched.
- wiki/result: unchanged; the wiki command's exit codes and messages are as before.

## Coverage
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- server/serves-wiki: test
- server/send: test
- server/store: test
- server/view: test
- server/explains: test
- server/sources: test
- server/survives-restart: test
- server/identities: test
- server/immutability: test
- server/protocol: test
- intended-model/schema: test
- intended-model/files: test
- compiled-model/shape: test
- model-history/store-version: test
- graph-queries/view: test
- views/view-set: test
- model-check/compiles: test
- model-authoring/skill: test
- wiki/pages: test
- wiki/diagrams: test
- wiki/engine: test
- wiki/documents: test
- wiki/links: test
- wiki/result: test

## Blocking questions
None.

## Design and decisions

- **Pin 0.94.0, vendored.** The program is vendored byte-for-byte into
  `vendor/shady2k-skills/0.94.0/` with the two fixtures it and the consumer
  tests read (`fixtures/workspace/cases.json`, `fixtures/product/good/`), the
  upstream commit and SHA-256 hashes recorded in `vendor/shady2k-skills/README.md`,
  and a test (`test/product-pin.test.ts`) holding the files to those hashes
  and to the program's own `--version` and `--selftest`. The run never reads
  a plugin cache at run time; 0.94.0 was chosen over the cached 0.91.0
  because it is the newest published release and differs from it in the
  version constant alone.
- **The manifest reader is the program's, not a port of it.** Rewriting
  madarch's yaml-based reader to match the set's 53 cases would keep two
  owners of the schema, exactly what decision 0019 refuses. `readProduct`
  now delegates to the pinned program; the module keeps madarch's interface
  (its refusal shape, its `folder` resolution, the fallback name) and gains
  the `skills` and `repos` fields the set's manifest carries.
- **`madarch list` is madarch's.** It reads the products home the way `new`
  resolves it, lists every subfolder whose manifest reads (code point
  order), skips a subfolder with no manifest (the home is where madarch
  writes products; a folder with no manifest is nothing it recognises),
  names a manifest that stands but cannot be read on standard error with
  the reader's words — still exit 0, so one broken neighbour hides none of
  the good products — and exits 2 only when the home cannot be used. An
  absent or empty home is an empty list. It takes no serving options.
- **madarch's seams stay.** `productsHome` (the home is madarch's decision,
  handed to the program, which takes it from no one else), the `today`
  moment a test folds a draft's name from (given to the program as its
  `--date` day), the sealed git identity for tests, and the git-stub seams
  the review built (the program has the same refusal-and-cleanup shape, so
  those tests hold as they were).
- **No creation code of madarch's remains.** `src/product/draft.ts` keeps
  only `productsHome` and the wrapper; `src/product/manifest.ts` keeps only
  the interface; the yaml-position machinery the old reader used stays for
  the model layer, which reads models the same way it did.
