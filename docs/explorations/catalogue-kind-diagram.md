# Catalogue kind relations in diagrams — madarch-64o5.71

## Root cause and choice

`validateProductManifests` published `derives-from` declarations as `manifest.dependency` vertices holding JSON `{from, to, via}`. `catalogueData` decoded those vertices for `derivesFrom` and `derivedBy`. Both `diagramNeighbourhood` and `backlinks` walked the generic `edge` table, so neither saw those relationships. Relation-kind declarations were also metadata vertices, not links between catalogue kinds. This explains the isolated kind picture and zero backlinks without a layout defect.

The chosen representation is real edges between `manifest.kind` vertices, written by the existing graph writer in the same publication transaction. `manifest.depends-on` points from a dependent kind to its prerequisite: incoming links to File include kinds derived from File. Kind dependency vertices are retired, and both catalogue derivation fields read the same edges; workflow stage dependency declarations remain separate.

`manifest.relation-edge` connects the declared source/target kinds. Its discriminator retains the declared relation name, so parallel relation kinds between two catalogue entries stay distinct. It does not pretend a schema relationship is an instance relationship. The product declares relation words in `catalog.relations.<name>.labels.<language>.out` and `.in`, beside the optional standard `source`. These declarations are published in the catalogue graph. Diagrams, backlinks and named relation connections read those graph-provided words, preserving direction and kind-page links. Only engine-owned metadata relations have built-in words; an untranslated product relation keeps its identifier.

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

## PR 303 relation vocabulary and language corrections

Finding 6 first failed on an arbitrary `sample.powers` declaration: the parser rejected its source-and-label object. The product catalogue now owns EN/RU forward and inverse words, including the starter set's code and C4 relations. A focused graph regression publishes custom words, deletes the product catalogue files, then checks both languages through GraphQL backlinks/outgoing and the diagram read/render path. The client reads labels from the graph response rather than an embedded product dictionary. Missing translations keep the relation identifier.

Finding 8 first failed with English `depends on` requested but Russian `зависит от` returned. Diagram fallback words now use the entity's request language, not a fixed Russian language.

Focused native validation: relation declarations, published graph labels, the real File catalogue and diagram route passed **19 cases, 0 failures, 169 assertions**. The separate diagram language regression passed with both English and Russian assertions. The full wiki app suite passed **50 cases, 0 failures, 221 assertions** after regenerating its starter SDL with the normal generator. The final root-focused run, including diagram language, passed **20 cases, 0 failures, 171 assertions**. Semantic mutants that ignore published relation labels, reverse their direction, or restore fixed Russian words were all killed; the restored code passed its focused regression checks. Engine TypeScript, architecture (36 existing violations, no new debt), and wiki TypeScript/architecture checks passed. These are targeted checks, not a full-suite claim.


## PR 303 CI repair follow-up

The schema golden was regenerated for the public relation-label fields. The wiki browser preload no longer imports unused `@radix-ui/react-popover`; a frozen install and all wiki checks pass without an undeclared package.

Repeated fill preparation used the pinned product contract without the engine's manifest metadata contract. Reconciliation then tried to prune metadata edges, failing their opinion-table foreign keys. `readPinnedGraphContract` now retains the same metadata contract as the stages fill. The consistency, scoped-fill, cross-process source and status-refresh regressions retain their original assertions and pass. A separate migration regression covers legitimate removal of populated vertex and edge kinds: dependent opinion rows/tables are removed before referenced graph identities.

The clean-install walk's plugin-free fixture had replaced all kinds with a skeletal `code.file`, while retaining templates that query the removed fields. The walk now separates unchanged starter-product init/serve acceptance from a neutral plugin-free store fixture. No engine schema fields are hidden to accommodate the fixture.

Validation of the CI repair follow-up:

- Native Linux arm64 release build and `scripts/clean-install-walk.ts` passed, including unchanged fresh-product foreground `serve` with `not-filled` status, plugin-free Fill, stop and reopen with `ok` status. The init daemon is stopped before foreground cleanup, then restarted for Fill; this avoids Windows cleanup stopping a live daemon's shared PostgreSQL cluster. macOS and Windows still require their CI runs.
- Root frozen install, `bun run check`, wiki frozen install/check and all 50 wiki tests passed. Architecture debt remains 36 existing entries; no quarantine was added.
- One full foreground `bun test test/` with the permitted `MADARCH_PLUGIN_SANDBOX=off` workaround completed: **1,943 pass, 90 skip, 2 fail**, 249,585 assertions across 243 files, 1,311.09 seconds. All originally reported CI cases passed. File diagrams passed at 91.2 ms Mermaid and 78.1 ms LikeC4 with the unchanged 200 ms bound.
- The two full-run failures were in `fill-updates-run.test.ts`: an owner RPC POST reset (`ECONNRESET`, cancellation case, 78.02 ms), followed by a dependent refusal assertion after the old service had been cleared. Both the complete file (7 cases, 125 assertions) and the file with its three immediate predecessors (19 cases, 155 assertions) passed on the branch and on `origin/main` at `a6382f4dcf4994130186f8a504f69c2b48352856`. No concrete transport cause was established. No speculative retry, timeout change, assertion weakening, or quarantine was applied. **The full suite is therefore not claimed green.**
- The originally failing consistency/scoped-fill files also pass on main (14 cases), as do the source/status files (4 cases), the golden-schema file (11 cases), and the constitution/privileged-port cases. The privileged-port path was exercised with three assertions in an isolated network namespace on both revisions, not silently bypassed on this host.

Evidence: `/tmp/pr303-ci-full-foreground.txt`, `/tmp/pr303-ci-check.txt`, `/tmp/pr303-ci-frozen.txt`, `/tmp/pr303-ci-fill-updates-{branch,main}{,-order}.txt`, `/tmp/madarch-cleanwalk-evidence/`, `/tmp/madarch-ci-fill-receipt.md`, `/tmp/ci-refresh-report.md`, and `/tmp/madarch-64o5.71-cli-report.md`. Limits and performance bounds are unchanged. The plugin-free walk now uses the neutral fixture kind `acceptance.record`, rather than a partial declaration of the product's `code.file` kind.

## Owner-directed template findings correction (2026-11-14)

The owner-path acceptance test from `e04be93f`, cherry-picked as `7c27849b`, passes: fresh init, serve, catalogue GraphQL, plugin-only code fill to succeeded, and repository counts. It did not reproduce the reduced clean-install fixture's refusal.

The owner clarified that a template querying undeclared fields must be a finding on that page and in Problems, not a refusal of the whole product. The earlier neutral-fixture workaround above is superseded: the walk again declares only `code.file` with `source: graph` and retains the original starter templates. Against the previous binary this reproduces the exact `repository`/`path`/`language` refusal (`/tmp/pr303-template-walk-red.txt`). After removing product-wide template refusals and isolating composition findings to the selected template's inheritance, the same native Linux arm64 packaged walk passes (`/tmp/pr303-template-walk-green.txt`). Manifest/schema validation is not weakened; invalid page queries still return their validation errors. No limits or timeouts changed.

The Problems frame now reads the typed GraphQL `templateFindings` list and displays template messages with file/line locations. It explicitly labels this section as template findings; it does not claim to list checks that the frame has not rebuilt. UI validation: 5 focused regressions, 55 wiki tests/237 assertions, wiki static and architecture checks passed. A bounded manual mutation removing displayed findings was killed before restoring the green source. English and Russian labels are included. The prior full-suite owner-RPC reset remains unresolved; these targeted checks do not make that full run green.

Final correction validation: native root check passes with unchanged architecture debt. Backend focused tests pass (20 tests, 103 assertions). Three bounded manual mutations were killed: empty findings root, global composition findings, and disabled query validation. The checker validates against the published manifest used by GraphQL and retains the actual inherited `.yml`/`.yaml` source location. Independent read-only re-review found no remaining blocking backend issue. The final Linux arm64 build and original-fixture packaged walk pass, including init, fresh foreground serve, Fill and final reopen: `/tmp/pr303-template-final-build.txt`, `/tmp/pr303-template-final-walk.txt`, `/tmp/pr303-template-final-check.txt`. No visual/browser acceptance or native Windows/macOS execution is claimed.
