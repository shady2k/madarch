# Catalogue kind relations in diagrams — madarch-64o5.71

## Root cause and choice

`validateProductManifests` published `derives-from` declarations as `manifest.dependency` vertices holding JSON `{from, to, via}`. `catalogueData` decoded those vertices for `derivesFrom` and `derivedBy`. Both `diagramNeighbourhood` and `backlinks` walked the generic `edge` table, so neither saw those relationships. Relation-kind declarations were also metadata vertices, not links between catalogue kinds. This explains the isolated kind picture and zero backlinks without a layout defect.

The chosen representation is real edges between `manifest.kind` vertices, written by the existing graph writer in the same publication transaction. `manifest.depends-on` points from a dependent kind to its prerequisite: incoming links to File include kinds derived from File. Kind dependency vertices are retired, and both catalogue derivation fields read the same edges; workflow stage dependency declarations remain separate.

`manifest.relation-edge` connects the declared source/target kinds. Its discriminator retains the declared relation name, so parallel relation kinds between two catalogue entries stay distinct. It does not pretend a schema relationship is an instance relationship. Diagrams use the existing translated relation-word dictionary for the declared relation identity and display its relation words and kind labels, preserving direction and kind-page links.

A wildcard `any` is an allowed-endpoint constraint, not a declaration that every kind relates to every other kind. Only named concrete endpoint pairs become catalogue edges. Wildcard definitions remain in the existing relation declaration vertices. An experimental eager expansion over the starter's catalogue caused quadratic publication work and was rejected; neither a synthetic wildcard kind nor a special diagram-only read was added.

Storage now permits self-edges, including a relation kind whose source and target are both File. The preserving schema reconciliation removes the old `edge_check` constraint without resetting existing vertices, opinions or authored operations. The diagram counts a self-edge once, not once per traversal direction.

## Verification

The fresh `everything` starter and a read-only inspection of the existing store both declare exactly three File dependents: `code.commit`, `code.database` and `code.test-quarantine`. Its prerequisites are `code.directory` and `code.repository`. The requested count of five is not present in those inputs. The regression fixture therefore preserves the three real starter declarations and adds two explicit fixture-only kinds derived from File. No starter dependency is invented or changed to satisfy a count.

Static checks pass, with 36 existing architecture violations and no new debt. The first combined run passed 67 cases and failed the real File LikeC4 render: the library rejects a relationship whose source and target are the same model element. Mermaid rendered the real self-loop. The format adapter therefore repeats that kind's visual occurrence, with the same label and destination page, for LikeC4 self-link targets. LikeC4 also aggregates distinct parallel labels to `[...]`; the supported view setting `include * -> * { multiple true }` keeps those relations and their labels separate without extra parallel-link occurrences. This creates no new stored graph entity and does not remove the canonical self-edge.

A manual mutation reversing published dependency endpoints was killed by the real File regression: its two prerequisites became the five dependents. The correct code was restored before validation (`/tmp/catalogue-edges-mutation.txt`).

The Russian `touched`/`code.touched` forward label changes from `изменяет` to the requested `затронул`. Deadline, watchdog, cache and fold limits are unchanged.

Final native combined validation passed: **69 cases, 0 failures, 397 assertions across 10 files** (12.29 s). The real File worker path rendered warm in **50.9 ms Mermaid / 84.0 ms LikeC4**. The existing 80-kind case rendered in **49.5 ms / 24.9 ms**, respectively. Both tests retain the strict 200 ms assertion. The real File case verifies dependency direction, five explicit fixture dependents, declared relation labels including self-imports, every node's page link, visible LikeC4 relation labels, idempotent refresh, dependency removal and restoration. Upgrade/reopen tests preserve original opinions and authored operations.

The combined files were `catalogue-kind-relations`, `catalogue-diagram`, `manifest-publication`, `manifest-relation-projection`, `graph-schema-self-edge-upgrade`, `graphql-executor`, `diagram-route`, `graph-schema-reconcile`, `graph-schema-fingerprint` and `graph-schema-readiness`. Evidence: `/tmp/catalogue-edges-combined.txt`, `/tmp/catalogue-edges-check.txt`, `/tmp/catalogue-edges-mutation.txt`. This is focused regression validation, not a new full-suite claim. All test commands use the ordinary `shady` account with `HOME=/home/shady.guest` and `MADARCH_PLUGIN_SANDBOX=off`.

Task integration commands are unavailable in this checkout session; no tracker closure or stage acceptance is claimed.
