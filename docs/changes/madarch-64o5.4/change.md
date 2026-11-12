# One command to start a product

Change: madarch-64o5.4
Base: 0e27a75f8b7a99dc9d77f9f29f12e953ee669298
Tasks: madarch-64o5.4
Kind: behavior

## Intent

Keep `madarch init [folder]` as the only command that starts a product.
Retire `madarch init` without an alias. Connect a Git checkout when one is
present, otherwise create an empty draft under the products home. Open its wiki.

Follow the owner's latest correction, recorded on 2026-11-12: a terminal asks
exactly one question, the starter template. Enter takes the first declared
template. Explicit `--template` selects without asking. Without a terminal and
without that option, write no kind or workflow manifest; the wiki offers the
templates in its existing `no-manifest` state. Ask neither agent nor token cap.

## Out of scope

Template catalogue content, agent and token-cap selection, joining products
with `clone`, the wiki's implementation, and fill behavior.

## Rationale

The owner chose one command named `init`; two start commands confuse people.
The latest tracker correction supersedes the intermediate nonterminal default
that chose the first template. Historical decisions, milestones and prior
change records retain their original wording as history.

## Preserved contracts

- product-repository/manifest: the product keeps its UUID and workspace manifest.
- product-repository/demo: demo cloning and update behavior stays unchanged.
- product-wiki/serve: the shared server opens the created product's wiki.

## Coverage

- product-repository/draft: product-cli, product-cli-script and product-serve tests.
- release-binary/installers: compiled-binary smoke and local clean npm install walk.

## Where it is seen

Kind: command
Place: `madarch init [folder]`

1. Run init in an empty folder or a Git checkout on a terminal.
2. Choose the starter template, or press Enter for the first declared one.
3. The product's wiki opens; the checkout stays where it was.
4. Run without a terminal and without a template to get the existing no-manifest wiki.
5. Run with an explicit template to get that starter without a question.
6. The retired command, including its help, exits 2 as unknown.

## Blocking questions

None.
