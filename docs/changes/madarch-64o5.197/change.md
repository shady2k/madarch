# The serve command reports every malformed manifest as its own refusal

Change: madarch-64o5.197
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.197
Kind: no-behavior

## Intent

The built O1 acceptance met a product with two malformed kind files, one fault in each. `madarch serve --product`
correctly refused it and named both files with their lines, so the validation itself was right; what reached the
person was not the command's answer but the runtime's own report of an exception — an excerpt of the compiled source
around the `throw`, a stack whose frames name `/$bunfs/root/madarch-linux-arm64`, and a `Bun v` footer. The command now
prints each finding as the refusal the module's contract gives an input that cannot be read: the file relative to the
product folder, the line and the reason, one per line on standard error, and nothing of the program's own machinery.
The run ends there, before any store work, with exit 2.

## Rationale

The serve path validated the product's manifests inside the store-preparation wrapper, whose work is a plain callback:
the only way it had to refuse was to throw, and an exception nothing catches is reported by the runtime — Bun prints
the source range around the `throw`, the stack of the compiled program with its `/$bunfs` bundle path, and its own
version footer. The command already holds a diagnostic exit for an input it cannot use: print what is wrong on standard
error and end the run with the contract's code. The findings the validator returns are already the whole answer — a
file, a line and a reason each — so the work is to print them, relative to the product folder a person names, from
that exit instead of throwing past it. Nothing else needs to move: the validation is untouched and it still runs before
any store work, so a product that cannot be served costs nothing more than reading its files.

The single review of that round (`24bff2ea7`) found four more faces of the same defect, each on the built binary; they
are answered here because they are the same fault in the same diagnostic:

- **The plugin lock, reported twice with a machine path in the reason.** `madarch/plugins.lock` is read by two
  readers — the kind reader (`src/product/manifest/kinds.ts`) and the manifest boundary
  (`src/plugin/manifest-source.ts`) — and each put the file it was given into its reason, so the two reasons differed
  by the absolute checkout path and the deduplication by message kept both. The lock's reasons now name what is wrong
  only (`src/plugin/lock.ts`), the boundary reads it by its place in the product (`madarch/plugins.lock`) as the kind
  reader already did, and one finding is printed once with its relative file, its line and its reason.
- **An unresolved YAML alias ended the run in the conversion.** `plugins: *missing` is not a document error the YAML
  reader reports: `toJS()` throws, and the throw carried the compiled source and the stack, while the malformed kind
  beside it disappeared. The lock reader catches that conversion and returns its own finding — the alias, its line and
  that no anchor of the document has that name — so it prints beside the other findings.
- **An unreadable template ended the run in the evidence read.** `validateProductManifests` read every template's text
  for the graph evidence before it returned the findings it already held, so `templates/unreadable.yaml` beside a
  malformed kind printed an absolute path, a source excerpt and a stack, and the kind's finding was lost. The failed
  read is now a finding of its own at the template's first line, and the findings collected before it stand.
- **A malformed `workspace.yaml` took a separate refusal path.** The product manifest was refused by `serveWiki` with
  the folder's absolute path in three places (the folder, the file and the reason), where the kinds and the lock are
  refused by their place in the product, their line and the reason. `readProduct` now names the manifest by its place
  in the product, and `madarch serve` prints that refusal from its own diagnostic exit, before any store work, as the
  manifests are printed: the place `workspace.yaml`, the line and the reason, then exit 2.

## Out of scope

The validation rules and the findings they produce (`src/graph/manifest-publication.ts`, `src/product/manifest/`), the
daemon's own manifest reporting, and the other commands that end a run by throwing (`madarch fill`, the daemon's
start). Only the serve path's printed report and the places it reads findings from change; a product that validates as
it did serves as it did.

## Preserved contracts

- product-wiki/result: the accepted requirement already gives exit 2 to a manifest entry that cannot be read and to an invalid manifest, naming what is wrong. The command now keeps it: the exit is nonzero as before (the unhandled exception's 1 was no chosen code), the validation is the same `validateProductManifests` with the same findings, and only their printing changes — each finding's file is shown relative to the product folder rather than as an absolute path inside a stack.

## Coverage

- product-wiki/result: static, test, mutation, review

## Where it is seen

Kind: command
Place: the `madarch serve` command, in the terminal that ran it
Reason: the change is the command's own report of a product it cannot serve; no page, route or wiki read is touched.
1. Put two malformed kind files in a product, one fault in each, and run `madarch serve --product` on that product:
   the command exits 2 and prints the relative file, the line and the reason of both, with no source excerpt, no stack
   and no `/$bunfs` path.
2. Beside them, put a `madarch/plugins.lock` whose one entry holds an extra field, and a lock holding an unresolved
   alias (`plugins: *missing`): each is one line of the same answer — its place, its line, its reason — once, never
   with the checkout's path.
3. Make `templates/unreadable.yaml` unreadable as the ordinary user: the answer names it at line 1 and keeps the
   kind's own finding.
4. Write `workspace.yaml` with an unclosed flow sequence on line 2: the answer names `workspace.yaml` at line 2 with
   the reason, and holds no absolute product path.
5. Correct the files and run the same command: the wiki is served as before.

## Blocking questions

None.
