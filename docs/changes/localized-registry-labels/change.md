# The product registry may supply localized kind and stage labels

Change: localized-registry-labels
Base: 79161f7364071e52a5f33b604bec8cdb25ab7b65
Tasks: madarch-k47i
Kind: behavior

## Intent
The wiki currently shows registry kind, group and stage names as written even when the reader selects another language. The owner chose an additive optional pair, `labels: { en, ru }`, on kind and stage entries in registry contract v1. When the pair is present, the wiki uses the selected locale's value on the overview, sidebar, stage navigation and document-kind label. When the pair is absent, it displays the manifest's own name unchanged (or a stage's own id when no name is declared); it never uses a value from the other locale. Product documents remain in their authored language.

## Out of scope
- Requiring labels or introducing contract v2.
- Translating product-authored documents.
- Editing the external product repository or the skill set in this change. The skill set's manifest writers should emit pairs after this schema lands; the coordinator will notify the skill set.

## Rationale
Optional paired labels keep existing contract-v1 registries valid and preserve their existing names. A required field or a cross-locale fallback would either force migration or show a language the reader did not choose. `name` and `id` stay stable matching identities; `labels` is reader-facing display data.

## Changes to requirements
- product-repository/contract (replaced): contract v1 accepts an optional paired `labels: { en, ru }` object on kinds and stages, with both non-blank strings and no extra keys when present; absence remains valid and the published schema id/version stays v1.
- product-wiki/shell (replaced): the overview, sidebar groups, stage navigation and document-kind labels use the selected locale's registry label; absent pairs use the registry's own name unchanged, never the other locale; product-authored content is unchanged.
- product-wiki/internationalization (replaced): registry kind/group/stage labels follow the reader's selected locale with the manifest-name fallback, while product document text remains as authored.

## Preserved contracts
- product-repository/manifest: the product manifest and registry version remain contract v1; existing unlabeled registries remain valid (test, contract:check).
- product-wiki/pages: product-authored document content remains unchanged when the wiki language changes (test, browser-walk).

## Coverage
- product-repository/contract: static, test, mutation, review, contract:check
- product-repository/manifest: test, contract:check
- product-wiki/internationalization: static, test, mutation, review, browser-walk
- product-wiki/pages: test, browser-walk
- product-wiki/shell: static, test, mutation, review, browser-walk
