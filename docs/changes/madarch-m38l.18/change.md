# Extracted document entities are shown in the wiki language beside their original source

Change: madarch-m38l.18
Base: 2e0848bd86848f1a85e0651b2de0b5ad15b65118
Tasks: madarch-m38l.18
Kind: behavior

## Intent
After a Russian refresh of the shop product, the glossary still showed English definitions from `docs/glossary.md`. A person reading the wiki in their chosen language should see extracted terms, use cases, rules, decisions and requirements in that language, while keeping the original source wording and its location available for verification. Entity names and identifiers remain unchanged because readers use them to find concepts in source documents and code.

## Rationale
This changes reader-visible knowledge pages and the product-repository source format, so it is a behavior change. The complete proposed capability is `capabilities/product-wiki.md`. The proposal extends the current `product-wiki` capability at `Base:` with `localized-document-sources` and retains all existing requirements. The baseline is the current `origin/main` revision recorded above.

## Out of scope
- Translating entity names, identifiers, code, or source documents.
- Storing product text in madarch's engine or machine-local store; the localized statements remain Markdown in each product repository.
- Translating arbitrary wiki pages; this task concerns extracted document entities only.
- Real agent runs; behavior is tested with the scripted ACP test agent.

## Changes to requirements
- product-wiki/localized-document-sources (new): extracted document entities show grounded statements in the wiki's language, retain the original source and location, and refresh when the wiki language changes. Localized source files live one per entity under `docs/sources/{entity-type}/{entity-id}.md` in the product repository. Scenarios: `localized-entities-with-source`, `source-language-matches-wiki`, `language-change-refreshes-localized-source`, `invalid-localized-source-is-reported`.

Complete proposed capability text: `capabilities/product-wiki.md`. It is the full capability at the pinned `Base:` plus the new requirement, not a hand-written delta.

## Preserved contracts
- product-wiki/pages: Markdown documents remain the wiki's pages and entity names remain searchable as written.
- product-wiki/internationalization: the reader supports English and Russian.

## Coverage
- product-wiki/localized-document-sources: test
- product-wiki/pages: test
- product-wiki/internationalization: test

## Where it is seen

Kind: screen
Place: an extracted document entity in a product's knowledge wiki
Mockup: docs/changes/madarch-m38l.18/localized-source-mockup.html

1. A reader opens a term, use case, rule, decision or requirement while the wiki is set to Russian and reads the Russian grounded statement.
2. The reader opens “В источнике” to verify the original wording and its document location.
3. After changing the wiki language and filling again, the reader sees the refreshed statement in the new language without a translated entity name or id.

## Blocking questions
None.

## Design and decisions
- The product repository is the source of truth for localized statements. Store one Markdown file per entity at `docs/sources/{entity-type}/{entity-id}.md`; do not put product text in the engine or machine-local store.
- Match localized source to graph entities by the unchanged entity type and id. Store the original source wording and its document line or section beside the localized grounded statement. The reader shows the original collapsed under the localized “In the source” / “В источнике” label.
- The fill writes the localized statement in the wiki language. If source and wiki languages are the same, render the original once. A language change is handled by the next fill.
- Missing or invalid localized content is an explicit error naming its file and line; do not display another entity's content or silently substitute a smaller result.

## Acceptance evidence
Pending implementation and acceptance.

## DONE WHEN
A Russian wiki over English source documents displays every extracted glossary term, use case, rule, decision and requirement with a grounded Russian statement and its original source available collapsed with its location; names and ids remain unchanged, same-language content is not duplicated, language changes refresh the statements on the next fill, and scripted-agent tests cover these behaviors.
