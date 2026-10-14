# Localized registry labels: optional paired values in contract v1

## Drivers
- The reader selects English or Russian, but registry kind, group and stage names can appear in the other language.
- Contract-v1 manifests already exist and must remain readable without migration.
- The registry name/id remains the stable identity; product document text stays authored by its product.

## Existing shape
The product's `docs/kinds.yaml` is parsed by the published contract-v1 schema and read by the wiki registry endpoint. The app receives registry entries and decides their reader-facing labels. Legacy entries may have no localized labels.

## Decision
Add an optional `labels: { en, ru }` pair to registry kind and stage entries under the existing contract-v1 schema and `$id`. If the pair is present, both non-blank strings are required and extra keys are refused. The wiki chooses the selected locale's value. If the pair is absent, it shows the kind's own name, or the stage's own name/id, unchanged; it never substitutes the other locale. The server transports the pair through the existing registry response. The skill set's writers should emit both labels after the schema lands; that follow-up is outside this repository change.

## Alternatives
- Require labels in a new contract v2: rejected because it would force every existing registry to migrate for a reader-only presentation improvement.
- Fall back to the other locale or translate the name in the engine: rejected because the owner requires one language per page and no product data in the engine.

## Consequences and checks
Old contract-v1 registries remain valid. Tests and conformance cases cover labeled and unlabeled kind/stage entries; rendered English and Russian walks verify the selected label, the legacy-name fallback and no cross-locale substitution. Product-authored content is not translated.
