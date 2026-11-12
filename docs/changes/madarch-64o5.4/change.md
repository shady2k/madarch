# One command to start a product

Change: madarch-64o5.4
Base: 7cbfed93effa7a4e3592b2c522f1cbd1f2760a2d
Tasks: madarch-64o5.4
Kind: behavior

## Intent

Keep `madarch init [folder]` as the only command that starts a product.
Delete `madarch new` without an alias. Connect a Git checkout when one is
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

## Changes to requirements

The complete capability proposals are compared with the pinned main base.
Each changed requirement is replaced once, with before read from that base.
Repository contract and describe-skill retain main's structured-publication
wording, not the older working-tree reader. Requirement manifest, list and demo
only rename their start-command references; identity and update behavior remain.

## Preserved contracts

None.

## Coverage

- product-repository/draft: static test review
- product-repository/manifest: static test review
- product-repository/list: static test review
- product-repository/describe-step: static test review
- product-repository/demo: static test review
- product-wiki/serve: static test review
- product-wiki/catalog: static test review
- product-wiki/extractor-mapping: static test review
- product-wiki/pov: static test review
- product-wiki/presentation: static test review
- product-wiki/views: static test review
- product-wiki/workflows: static test review
- release-binary/installers: static review

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
