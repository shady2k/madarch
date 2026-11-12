# Review: madarch-64o5.4 change record

Scope: read-only review of the current working-tree change record in /var/lib/boxd/homes/prime/wplat against origin/main (7cbfed93effa7a4e3592b2c522f1cbd1f2760a2d), with implementation inspected at b2760959ddd7b344e54d58ca127c8e7ea9e0fc31. No tests executed; no owner approval supplied or inferred.

## Concrete finding

- product-wiki.md, scenario `starter-set-shows-the-same-pages` (line 956): its Given still says a product `madarch init` made from the generated training repository and filled. The rest of the starter-set requirements deliberately use `madarch init --template everything`, because plain nonterminal init now writes neither manifest. This remaining invocation does not reliably produce the starter set whose views/pages the scenario compares. Make that setup explicit too. This is a documentation consistency finding, not evidence that production init is wrong.

## Verified in current working draft

- change.md now correctly deletes `madarch new`, not `madarch init`, with no alias. Its base matches origin/main.
- draft requirement states terminal starter-template question only, Enter selecting first declaration, no repository/agent/token-cap question, nonterminal without template writing neither kind nor workflow manifest, explicit template choice, and deleted new/help exit 2. This agrees with b2760959 CLI `templateChoice`/`askTemplate`, command table and init path. TTY detection in code requires both stdin and stdout TTY; docs use the broader phrase “in a terminal.”
- Coverage requirement IDs all name real requirements. Entries use explicit static review/static test review labels, not invented passing test names. They are broad labels rather than a precise test-to-scenario index. Actual code contains nonterminal four-case matrix, deleted-command/help test, serve no-manifest test, and starter-template tests. Review did not rerun them.
- Main's newer structured-publication paragraphs in repository `contract` and `describe-skill`, and its structured-opinion describe-step scenario, are preserved in the working draft. The only additional contract-section difference from main is demoting the historical subsection heading to a paragraph. No runtime working-tree reader was reintroduced by those current edits.
- The changed repository/wiki/release requirements otherwise remain init/start-command changes; the unchanged full-capability text is inherited, not a new wiki or fill implementation.

## Revision distinction / limits

The committed record at b2760959 alone still has the old base, the erroneous “Retire madarch init” sentence, and older repository publication wording. Those are corrected by the currently uncommitted changes to change.md and product-repository.md. Do not describe the committed record alone as already repaired.

This review does not establish gate readiness. It does not address or override the coordinator's reported unreadable-main-heading failure, feature synchronization failure, or close-draft placeholder. It gives no owner approval and makes no claim that lack of approval is the sole blocker.

## Finding disposition

The parent corrected the starter-set scenario to explicit `--template everything`, matching neighboring setups. The record-only edit does not change implementation or test revisions. No other blocking record-content finding was reported. Gate limitations remain as above.
